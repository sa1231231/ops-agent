import { pool } from "../db/pool.js";
import { notifyOperator } from "../outputs/operatorEmail.js";
import { briefHour } from "../db/queries/settings.js";
import { BRIEF_HOUR, BRIEF_TZ, localHour } from "../time.js";
import { briefBlockedBy, runBrief } from "./brief.js";
import { syncAll, type SkippedSync } from "./sync.js";

/**
 * One scheduled cycle: sync every account, then attempt the brief.
 *
 * One schedule rather than two: the brief self-gates on the configured hour, so
 * attempting it every hour is safe and costs a database round trip on the
 * twenty-three hours it does nothing.
 *
 * Syncing hourly is not about completeness — the Gmail history cursor picks up
 * everything since the last successful run, so one sync a day would capture the
 * same messages. It is about not letting a single failed sync ship a brief built
 * on yesterday's data, which would look completely normal and be wrong.
 *
 * `runCycle` is the whole job. It is called both by this file's CLI entrypoint
 * (a container that runs and exits, if a platform cron is driving it) and by the
 * in-process scheduler in the web service. Same code either way.
 */

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * How long the pre-brief retry is allowed to take.
 *
 * The brief must go out whether or not Google is answering, so this is a hard
 * ceiling rather than a target. If the retry has not finished by then the cycle
 * moves on and the brief names the account as skipped, which is exactly what it
 * would have done without the retry. Nothing is lost by giving up.
 *
 * Ninety seconds because the failures worth catching here resolve in one or two
 * (a refused connection, a 500, a token endpoint having a bad moment), and the
 * ones that do not are the ones there is no point waiting for.
 */
const RETRY_DEADLINE_MS = 90_000;

/**
 * Gives failed accounts one more attempt, but only when the brief is about to
 * send.
 *
 * An account that fails at 13:00 has another sync coming in an hour and nothing
 * depends on it in the meantime, so retrying then is wasted work. An account
 * that fails at 06:00 is about to be a line in his brief saying his mail could
 * not be read, and the failure is usually the kind that would have worked on a
 * second attempt. That is the only moment where a retry buys anything.
 *
 * Permanent failures are skipped. A revoked grant returns invalid_grant just as
 * fast the second time, and the only thing retrying it does is spend part of the
 * deadline that a recoverable account might have needed.
 */
export function retryableEmails(skipped: readonly SkippedSync[]): string[] {
  return skipped.filter((s) => !s.permanent).map((s) => s.email);
}

async function retryBeforeBrief(skipped: SkippedSync[]): Promise<void> {
  const retryable = retryableEmails(skipped);
  if (retryable.length === 0) return;

  console.log(`[worker] brief is due, retrying ${retryable.join(", ")}`);

  // Raced rather than awaited: syncAll has no per-request timeout, so a hung
  // connection would otherwise hold the brief open indefinitely. The loser keeps
  // running and its writes are idempotent, so a late finish is harmless.
  const retry = syncAll({ only: new Set(retryable) })
    .then((again) => {
      const recovered = again.synced;
      console.log(
        recovered.length > 0
          ? `[worker] retry recovered ${recovered.join(", ")}`
          : "[worker] retry recovered nothing",
      );
    })
    .catch((err: unknown) => {
      // Never fatal. The brief runs on whatever is stored either way.
      console.error("[worker] retry failed:", errorText(err));
    });

  await Promise.race([
    retry,
    new Promise<void>((resolve) => setTimeout(resolve, RETRY_DEADLINE_MS)),
  ]);
}

export async function runCycle(): Promise<{ syncFailed: string | null }> {
  const started = Date.now();
  let syncFailed: string | null = null;

  // Partial failure never suppresses the brief. Even a total sync failure must
  // not stop delivery — the brief runs on whatever is already in Postgres and
  // names what it could not read.
  try {
    const summary = await syncAll();
    console.log(
      `[worker] sync: ${summary.synced.length} synced, ${summary.skipped.length} skipped`,
    );
    for (const s of summary.skipped) {
      console.error(`[worker] skipped ${s.email}: ${s.reason}`);
    }

    // Asked before the brief runs, not after: once runBrief has read Postgres
    // the answer is too late to be useful.
    if (summary.skipped.length > 0) {
      const blocked = await briefBlockedBy(new Date(), { scheduled: true, force: false });
      if (blocked === null) await retryBeforeBrief(summary.skipped);
    }
  } catch (err) {
    syncFailed = errorText(err);
    console.error("[worker] sync failed entirely:", syncFailed);
    await notifyOperator({
      subject: "the hourly sync did not finish",
      body:
        "The sync threw before completing, so no account was refreshed this hour.\n\n" +
        `  ${syncFailed}\n\n` +
        "The brief still runs, using whatever was already stored. If this repeats, " +
        "the data behind the next brief will be stale rather than missing.",
    });
  }

  const result = await runBrief(new Date(), { trigger: "scheduled" });
  console.log(`[worker] brief: ${result.status}, ${result.message}`);

  // Read the configured hour, not the env fallback: the gate uses the console
  // setting, and a log line that disagrees with the gate is worse than none.
  const configuredHour = await briefHour(BRIEF_HOUR);
  console.log(
    `[worker] done in ${((Date.now() - started) / 1000).toFixed(1)}s ` +
      `(${localHour()}:00 ${BRIEF_TZ}, brief hour is ${configuredHour}:00)`,
  );

  return { syncFailed };
}

/** Alerts the operator that a whole cycle died. Shared by both callers. */
export async function reportCycleFailure(err: unknown): Promise<void> {
  console.error("[worker] fatal:", errorText(err));
  await notifyOperator({
    subject: "the scheduled run did not complete",
    body:
      "The hourly run stopped before finishing. Neither sync nor the brief " +
      "can be assumed to have run.\n\n" +
      `  ${errorText(err)}`,
  });
}

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (isEntrypoint) {
  runCycle()
    .then(async ({ syncFailed }) => {
      // A sync that died outright is worth a non-zero exit so the platform shows
      // the run as failed, even though the brief itself may have gone out fine.
      if (syncFailed) process.exitCode = 1;
      await pool.end();
    })
    .catch(async (err: unknown) => {
      await reportCycleFailure(err);
      await pool.end();
      process.exit(1);
    });
}
