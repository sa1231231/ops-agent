import { BRIEF_RETENTION_DAYS, optionalEnv, PUBLIC_BASE_URL } from "../config.js";
import { pool } from "../db/pool.js";
import {
  carriedOverItems,
  claimBrief,
  getBrief,
  markBriefFailed,
  markBriefSent,
  pruneOldBriefs,
  saveBriefItems,
} from "../db/queries/briefs.js";
import { briefHour, briefRecipient } from "../db/queries/settings.js";
import { formatSkippedAccounts, notifyOperator } from "../outputs/operatorEmail.js";
import { renderPlainText, estimateSegments } from "../outputs/render.js";
import { deliveryChannel, sendSms } from "../outputs/sms.js";
import { buildTemplateVariables, sendBrief as sendWhatsApp } from "../outputs/whatsapp.js";
import { composeBrief } from "../ranking/compose.js";
import { findConflicts, meetingsForLocalDay } from "../ranking/meetings.js";
import { selectCandidates } from "../ranking/candidates.js";
import { BRIEF_HOUR, localDateString, localHour } from "../time.js";

/**
 * The morning brief.
 *
 * Reads only Postgres — it never touches Google. Sync runs all day and writes;
 * this reads. A Gmail outage at 6:29am therefore cannot cost him his 6:30 brief.
 */

const ENV_DRY_RUN = optionalEnv("DRY_RUN", "") === "1";
const ENV_FORCE = optionalEnv("FORCE", "") === "1" || process.argv.includes("--force");

export interface BriefRunOptions {
  /** Render and discard. Repeatable, and records nothing. */
  dryRun?: boolean;
  /** Ignore the BRIEF_HOUR gate — used by the console's manual trigger. */
  force?: boolean;
}

export interface BriefRunResult {
  status: "sent" | "preview" | "skipped" | "not-due";
  message: string;
  text?: string;
  briefUrl?: string;
}

interface SkippedAccount {
  email: string;
  reason: string;
}

async function skippedAccounts(): Promise<SkippedAccount[]> {
  const { rows } = await pool.query<{ email: string; last_error: string | null }>(
    `select email, last_error from accounts
      where status = 'auth_error' or last_sync_at is null
      order by email`,
  );
  return rows.map((r) => ({
    email: r.email,
    reason: r.last_error ?? "never synced",
  }));
}

export async function runBrief(
  now = new Date(),
  options: BriefRunOptions = {},
): Promise<BriefRunResult> {
  const dryRun = options.dryRun ?? ENV_DRY_RUN;
  const force = options.force ?? ENV_FORCE;
  const localDate = localDateString(now);

  // Railway cron is UTC, so the job fires hourly and gates on his local hour.
  // This survives DST without a twice-yearly adjustment.
  // The configured hour wins; the env var is only a fallback for a fresh
  // deployment where nobody has opened the console yet.
  const targetHour = await briefHour(BRIEF_HOUR);
  if (!force && localHour(now) !== targetHour) {
    const message = `Not ${targetHour}:00 local (it is ${localHour(now)}:00) — nothing to do`;
    console.log(`[brief] ${message}`);
    return { status: "not-due", message };
  }

  // A preview claims nothing. It has to stay usable after the day's real brief
  // has gone out — that is precisely when you want to see what a weight change
  // would have produced — so it must not contend for the idempotency row.
  //
  // For a real send the insert *is* the lock. Checking first would leave a
  // window where two workers both see "no brief yet" and both send.
  const brief = dryRun ? null : await claimBrief(localDate);
  if (!dryRun && !brief) {
    const existing = await getBrief(localDate);
    const message = `${localDate} was already ${existing?.status ?? "claimed"} — not sending again`;
    console.log(`[brief] ${message}`);
    return { status: "skipped", message };
  }

  try {
    const [meetings, candidates, carried, skipped] = await Promise.all([
      meetingsForLocalDay(now),
      selectCandidates(now),
      carriedOverItems(localDate),
      skippedAccounts(),
    ]);

    const conflicts = findConflicts(meetings);
    const skippedEmails = skipped.map((s) => s.email);

    console.log(
      `[brief] ${localDate}: ${meetings.length} meetings, ${conflicts.length} conflicts, ` +
        `${candidates.length} candidates, ${carried.size} carried over, ${skipped.length} skipped`,
    );

    const composed = await composeBrief({
      localDate,
      meetings,
      conflicts,
      candidates,
      carried,
      skippedAccounts: skippedEmails,
    });

    const briefUrl = brief
      ? `${PUBLIC_BASE_URL}/brief/${brief.share_token}`
      : `${PUBLIC_BASE_URL}/brief/(preview)`;
    const text = renderPlainText(composed, {
      localDate,
      briefUrl,
      skippedAccounts: skippedEmails,
    });

    const channel = deliveryChannel();
    console.log(
      `[brief] rendered ${text.length} chars (~${estimateSegments(text)} SMS segments), channel=${channel}`,
    );

    let messageSid: string | null = null;

    if (dryRun) {
      console.log("\n----- DRY RUN, not sending -----\n" + text + "\n--------------------------------\n");
      console.log("[brief] dry run — nothing claimed, nothing recorded");
      return {
        status: "preview",
        message: `Preview for ${localDate} — ${candidates.length} candidates, nothing sent or recorded`,
        text,
      };
    }

    if (channel === "sms") {
      // Console-configured recipient wins; the env var is only a fallback so a
      // fresh deployment can deliver before anyone opens the console.
      messageSid = await sendSms(
        text,
        await briefRecipient(optionalEnv("CLIENT_SMS_NUMBER", "")),
      );
    } else if (channel === "whatsapp") {
      messageSid = await sendWhatsApp(
        buildTemplateVariables(composed, { localDate, briefUrl, skippedAccounts: skippedEmails }),
      );
    } else {
      console.log("[brief] DELIVERY_CHANNEL=none — rendered and stored, not sent");
    }

    // Carry-over depends on these rows: tomorrow's "still open, day 2" is only
    // correct if today was recorded.
    await saveBriefItems(
      brief!.id,
      composed.emails.map((e, i) => ({
        kind: "email",
        refKey: e.thread_key,
        rank: i + 1,
        reason: e.reason,
        firstSeen: carried.get(e.thread_key)?.firstSeen ?? localDate,
      })),
    );

    await markBriefSent(brief!.id, { composed, text, briefUrl }, messageSid, skippedEmails);

    if (skipped.length > 0) {
      await notifyOperator(formatSkippedAccounts(skipped));
    }

    // Retention runs after a successful send: cheap, and tied to the daily job
    // so there is no second schedule to deploy or forget.
    const pruned = await pruneOldBriefs(BRIEF_RETENTION_DAYS);
    if (pruned > 0) console.log(`[brief] pruned ${pruned} brief(s) past retention`);

    console.log(`[brief] done — ${briefUrl}${messageSid ? ` (sid ${messageSid})` : ""}`);

    return {
      status: "sent",
      message: messageSid
        ? `Sent for ${localDate} (sid ${messageSid})`
        : `Recorded for ${localDate}; delivery channel is "${channel}", nothing sent`,
      text,
      briefUrl,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (brief) await markBriefFailed(brief.id, { error: message });
    await notifyOperator({
      subject: `Brief failed for ${localDate}`,
      body: `The morning brief could not be sent.\n\n${message}`,
    });
    throw err;
  }
}

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (isEntrypoint) {
  runBrief()
    .then(() => pool.end())
    .catch(async (err: unknown) => {
      console.error("[brief] failed:", err instanceof Error ? err.message : err);
      await pool.end();
      process.exit(1);
    });
}
