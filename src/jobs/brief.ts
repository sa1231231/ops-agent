import { optionalEnv, PUBLIC_BASE_URL } from "../config.js";
import { pool } from "../db/pool.js";
import {
  carriedOverItems,
  claimBrief,
  getBrief,
  markBriefFailed,
  markBriefSent,
  saveBriefItems,
} from "../db/queries/briefs.js";
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

const DRY_RUN = optionalEnv("DRY_RUN", "") === "1";
const FORCE = optionalEnv("FORCE", "") === "1" || process.argv.includes("--force");

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

export async function runBrief(now = new Date()): Promise<void> {
  const localDate = localDateString(now);

  // Railway cron is UTC, so the job fires hourly and gates on his local hour.
  // This survives DST without a twice-yearly adjustment.
  if (!FORCE && localHour(now) !== BRIEF_HOUR) {
    console.log(
      `[brief] not ${BRIEF_HOUR}:00 local (it is ${localHour(now)}:00) — nothing to do`,
    );
    return;
  }

  // The insert is the lock. Checking first would leave a window where two
  // workers both see "no brief yet" and both send.
  const brief = await claimBrief(localDate);
  if (!brief) {
    const existing = await getBrief(localDate);
    console.log(
      `[brief] ${localDate} already ${existing?.status ?? "claimed"} — not sending again`,
    );
    return;
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

    const briefUrl = `${PUBLIC_BASE_URL}/brief/${brief.share_token}`;
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

    if (DRY_RUN) {
      console.log("\n----- DRY RUN, not sending -----\n" + text + "\n--------------------------------\n");
    } else if (channel === "sms") {
      messageSid = await sendSms(text);
    } else if (channel === "whatsapp") {
      messageSid = await sendWhatsApp(
        buildTemplateVariables(composed, { localDate, briefUrl, skippedAccounts: skippedEmails }),
      );
    } else {
      console.log("[brief] DELIVERY_CHANNEL=none — rendered and stored, not sent");
    }

    // Carry-over depends on these rows, so they are written even on a dry run:
    // tomorrow's "still open, day 2" is only correct if today was recorded.
    await saveBriefItems(
      brief.id,
      composed.emails.map((e, i) => ({
        kind: "email",
        refKey: e.thread_key,
        rank: i + 1,
        reason: e.reason,
        firstSeen: carried.get(e.thread_key)?.firstSeen ?? localDate,
      })),
    );

    await markBriefSent(brief.id, { composed, text, briefUrl }, messageSid, skippedEmails);

    if (skipped.length > 0) {
      await notifyOperator(formatSkippedAccounts(skipped));
    }

    console.log(`[brief] done — ${briefUrl}${messageSid ? ` (sid ${messageSid})` : ""}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markBriefFailed(brief.id, { error: message });
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
