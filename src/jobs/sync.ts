import { getAccessToken, TokenRevokedError } from "../auth/tokens.js";
import { pool } from "../db/pool.js";
import {
  listAccounts,
  markAccountError,
  type Account,
} from "../db/queries/accounts.js";
import { upsertEvents, pruneEventsOutsideWindow } from "../db/queries/events.js";
import {
  deleteMessages,
  insertMessages,
  recomputeCorrespondents,
  recomputeThreads,
} from "../db/queries/messages.js";
import {
  failRun,
  finishRun,
  markAccountSynced,
  startRun,
  type SyncSource,
} from "../db/queries/syncRuns.js";
import { calendarWindow, fetchEvents, listCalendarIds } from "../sources/calendar.js";
import {
  fetchColdStartInbox,
  fetchIncremental,
  fetchProfileHistoryId,
  fetchRecoveryWindow,
  fetchSentForGraph,
} from "../sources/gmail.js";

/**
 * Sync worker. Runs every ~20 minutes, all day, and is deliberately decoupled
 * from delivery: the morning job only reads Postgres. A Gmail outage at 6:29am
 * therefore cannot kill the 6:30 brief.
 *
 * Accounts are isolated from each other. One revoked token is a `sync_runs` row
 * and a red badge on the console — never a thrown exception that costs the other
 * fourteen accounts their data.
 */

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Wraps one source in a sync_runs row so failures are always recorded. */
async function runStep<T>(
  accountId: number,
  source: SyncSource,
  step: () => Promise<{ result: T; counts: Record<string, number> }>,
): Promise<T> {
  const runId = await startRun(accountId, source);
  try {
    const { result, counts } = await step();
    await finishRun(runId, counts);
    return result;
  } catch (err) {
    await failRun(runId, errorText(err));
    throw err;
  }
}

async function syncGmail(account: Account, token: string): Promise<string | null> {
  let historyId: string | null = null;

  await runStep(account.id, "gmail_inbox", async () => {
    // The cursor is captured *before* fetching. Anything that arrives during
    // the fetch is then replayed on the next incremental pass rather than
    // falling into the gap between the two calls.
    const cursorBefore = await fetchProfileHistoryId(token);

    let messages;
    let reclassified: string[] = [];
    if (!account.gmail_history_id) {
      messages = await fetchColdStartInbox(token);
      historyId = cursorBefore;
    } else {
      const incremental = await fetchIncremental(token, account.gmail_history_id);
      if (incremental.expired) {
        // Gmail keeps roughly a week of history. Past that we take a bounded
        // 2-day window — never a full scan, which is what the never-backfill
        // rule is protecting against.
        console.warn(`[sync] ${account.email}: history cursor expired, bounded resync`);
        messages = await fetchRecoveryWindow(token);
        historyId = cursorBefore;
      } else {
        messages = incremental.messages;
        reclassified = incremental.excludedIds;
        historyId = incremental.newHistoryId ?? cursorBefore;
      }
    }

    const written = await insertMessages(account.id, messages);
    // He moved these out of the inbox. Deleting is what makes the exclusion
    // symmetric — Google classifies, he overrules, and both directions stick.
    const removed = await deleteMessages(account.id, reclassified);
    if (removed > 0) {
      console.log(`[sync] ${account.email}: removed ${removed} reclassified message(s)`);
    }
    return { result: null, counts: { fetched: messages.length, written, removed } };
  });

  // The sender graph only needs building once; after cold start the ordinary
  // inbox sync keeps outbound mail flowing in.
  if (!account.gmail_history_id) {
    await runStep(account.id, "gmail_sent", async () => {
      const sent = await fetchSentForGraph(token);
      const written = await insertMessages(account.id, sent);
      return { result: null, counts: { fetched: sent.length, written } };
    });
  }

  // Derived state is rebuilt from stored rows, so running it twice is harmless.
  const threads = await recomputeThreads(account.id);
  const correspondents = await recomputeCorrespondents(account.id, account.email);
  console.log(
    `[sync] ${account.email}: ${threads} threads, ${correspondents} correspondents`,
  );

  return historyId;
}

async function syncCalendar(account: Account, token: string): Promise<void> {
  await runStep(account.id, "calendar", async () => {
    const calendarIds = await listCalendarIds(token);
    const now = new Date();
    let total = 0;

    for (const calendarId of calendarIds) {
      const events = await fetchEvents(token, calendarId, now);
      total += await upsertEvents(account.id, events);
    }

    const { timeMin, timeMax } = calendarWindow(now);
    const pruned = await pruneEventsOutsideWindow(account.id, timeMin, timeMax);

    return {
      result: null,
      counts: { calendars: calendarIds.length, events: total, pruned },
    };
  });
}

async function syncAccount(account: Account): Promise<void> {
  const token = await getAccessToken(account.id);
  const historyId = await syncGmail(account, token);
  await syncCalendar(account, token);
  await markAccountSynced(account.id, historyId);
}

export interface SyncSummary {
  synced: string[];
  skipped: Array<{ email: string; reason: string }>;
}

export async function syncAll(): Promise<SyncSummary> {
  const accounts = (await listAccounts()).filter((a) => a.status !== "disabled");

  // allSettled, not all: one rejection must not cancel the others.
  const settled = await Promise.allSettled(
    accounts.map(async (account) => {
      try {
        await syncAccount(account);
        return account.email;
      } catch (err) {
        if (err instanceof TokenRevokedError) {
          // Not retryable — a human must reconnect this account. Record it so
          // the console shows why, and so the brief can name it as skipped.
          await markAccountError(account.id, errorText(err));
        } else {
          await markAccountError(account.id, errorText(err));
        }
        throw err;
      }
    }),
  );

  const summary: SyncSummary = { synced: [], skipped: [] };

  settled.forEach((outcome, i) => {
    const account = accounts[i];
    if (!account) return;
    if (outcome.status === "fulfilled") {
      summary.synced.push(account.email);
    } else {
      summary.skipped.push({
        email: account.email,
        reason: errorText(outcome.reason),
      });
    }
  });

  return summary;
}

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (isEntrypoint) {
  const started = Date.now();
  syncAll()
    .then(async (summary) => {
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      console.log(
        `[sync] done in ${seconds}s — ${summary.synced.length} synced, ` +
          `${summary.skipped.length} skipped`,
      );
      for (const s of summary.skipped) console.error(`[sync] skipped ${s.email}: ${s.reason}`);
      await pool.end();
    })
    .catch(async (err: unknown) => {
      console.error("[sync] fatal:", errorText(err));
      await pool.end();
      process.exit(1);
    });
}
