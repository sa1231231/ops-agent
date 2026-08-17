import { BRIEF_RETENTION_DAYS, optionalEnv, PUBLIC_BASE_URL } from "../config.js";
import { pool } from "../db/pool.js";
import {
  carriedOverItems,
  createBrief,
  markBriefFailed,
  markBriefSent,
  pruneOldBriefs,
  saveBriefItems,
  scheduledSendExists,
} from "../db/queries/briefs.js";
import { activeBriefRules, recordRuleFires } from "../db/queries/rules.js";
import {
  briefGreetingName,
  briefHour,
  briefRecipient,
  isBriefPaused,
} from "../db/queries/settings.js";
import { formatSkippedAccounts, notifyOperator } from "../outputs/operatorEmail.js";
import {
  conflictLines,
  estimateSegments,
  meetingLines,
  renderPlainText,
} from "../outputs/render.js";
import { deliveryChannel, sendOperatorCopy, sendSms } from "../outputs/sms.js";
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
  /**
   * Who asked. "scheduled" runs at most once per local day; "manual" is
   * unlimited, which is the whole point of the console button.
   */
  trigger?: "scheduled" | "manual";
}

export interface BriefRunResult {
  status: "sent" | "preview" | "not-due" | "already-sent" | "paused";
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
  const trigger = options.trigger ?? "manual";
  const localDate = localDateString(now);

  // Checked before the hour gate so the log says "paused" rather than "not due"
  // on the twenty-three hours where both are true. Only the schedule is held:
  // the console's button passes trigger "manual" and still runs, which is the
  // point of pausing at all, and a dry run was never going to send anything.
  if (trigger === "scheduled" && !dryRun && (await isBriefPaused())) {
    const message = `Scheduled brief is paused, nothing sent for ${localDate}`;
    console.log(`[brief] ${message}`);
    return { status: "paused", message };
  }

  // Container clocks are UTC, so the cycle fires hourly and gates on his local
  // hour. This survives DST without a twice-yearly adjustment.
  // The configured hour wins; the env var is only a fallback for a fresh
  // deployment where nobody has opened the console yet.
  const targetHour = await briefHour(BRIEF_HOUR);
  if (!force && localHour(now) !== targetHour) {
    const message = `Not ${targetHour}:00 local (it is ${localHour(now)}:00), nothing to do`;
    console.log(`[brief] ${message}`);
    return { status: "not-due", message };
  }

  // The hour gate stops a single scheduler firing twice. This stops *two*
  // schedulers — an in-process one and a platform cron — from both sending.
  // Manual runs are unaffected, deliberately.
  if (trigger === "scheduled" && !dryRun && (await scheduledSendExists(localDate))) {
    const message = `Already sent on schedule for ${localDate}, nothing to do`;
    console.log(`[brief] ${message}`);
    return { status: "already-sent", message };
  }

  // A preview records nothing at all; a real send always creates a row.
  const brief = dryRun ? null : await createBrief(localDate);

  try {
    const [meetings, candidates, carried, skipped, houseRules] = await Promise.all([
      meetingsForLocalDay(now),
      selectCandidates(now),
      carriedOverItems(localDate),
      skippedAccounts(),
      activeBriefRules(),
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
      houseRules: houseRules.map((r) => r.rule),
    });

    const briefUrl = brief
      ? `${PUBLIC_BASE_URL}/brief/${brief.share_token}`
      : `${PUBLIC_BASE_URL}/brief/(preview)`;
    // Rendered from calendar rows, not from the model: the schedule has one
    // correct answer and it is already in the database.
    const meetingList = meetingLines(meetings);
    const conflictList = conflictLines(conflicts);

    const text = renderPlainText(composed, {
      localDate,
      skippedAccounts: skippedEmails,
      meetings: meetingList,
      conflicts: conflictList,
      greetingName: await briefGreetingName(),
    });

    const channel = deliveryChannel();
    console.log(
      `[brief] rendered ${text.length} chars (~${estimateSegments(text)} SMS segments), channel=${channel}`,
    );

    let messageSid: string | null = null;

    if (dryRun) {
      console.log("\n----- DRY RUN, not sending -----\n" + text + "\n--------------------------------\n");
      console.log("[brief] dry run, nothing claimed, nothing recorded");
      return {
        status: "preview",
        message: `Preview for ${localDate}: ${candidates.length} candidates, nothing sent or recorded`,
        text,
      };
    }

    if (channel === "sms") {
      // Console-configured recipient wins; the env var is only a fallback so a
      // fresh deployment can deliver before anyone opens the console.
      const recipient = await briefRecipient(optionalEnv("CLIENT_SMS_NUMBER", ""));
      messageSid = await sendSms(text, recipient);
      // After the client's, and never fatal: the brief is already delivered.
      await sendOperatorCopy(text, recipient);
    } else if (channel === "whatsapp") {
      messageSid = await sendWhatsApp(
        buildTemplateVariables(composed, {
          localDate,
          briefUrl,
          skippedAccounts: skippedEmails,
          meetings: meetingList,
          conflicts: conflictList,
        }),
      );
    } else {
      console.log("[brief] DELIVERY_CHANNEL=none, rendered and stored, not sent");
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

    // Snapshot why these were chosen. The live scoring view recomputes from
    // current data, which cannot answer "why did Tuesday's brief pick that" —
    // messages and the correspondent graph have moved on since.
    const scoring = candidates.map((t) => ({
      threadKey: `${t.candidate.accountId}:${t.candidate.gmailThreadId}`,
      subject: t.candidate.subject,
      from: t.candidate.fromEmail,
      score: Math.round(t.score),
      signals: t.signals.map((sig) => ({
        name: sig.name,
        points: Math.round(sig.points),
        detail: sig.detail ?? null,
      })),
    }));

    await markBriefSent(
      brief!.id,
      { trigger, composed, meetings: meetingList, conflicts: conflictList, text, briefUrl, scoring },
      messageSid,
      skippedEmails,
    );

    // Fire counts are bumped only on a real send. The scoring view recomputes
    // on every page load, and counting those would make a rule look
    // load-bearing when nobody had done anything but look at it.
    await recordRuleFires([...new Set(candidates.flatMap((t) => t.firedSenderRuleIds))]);

    if (skipped.length > 0) {
      await notifyOperator(formatSkippedAccounts(skipped));
    }

    // Retention runs after a successful send: cheap, and tied to the daily job
    // so there is no second schedule to deploy or forget.
    const pruned = await pruneOldBriefs(BRIEF_RETENTION_DAYS);
    if (pruned > 0) console.log(`[brief] pruned ${pruned} brief(s) past retention`);

    console.log(`[brief] done: ${briefUrl}${messageSid ? ` (sid ${messageSid})` : ""}`);

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
      subject: `the brief for ${localDate} was not sent`,
      body:
        "Composing or delivering today's brief failed, so nothing was sent.\n\n" +
        `  ${message}`,
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
