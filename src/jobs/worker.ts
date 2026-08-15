import { pool } from "../db/pool.js";
import { notifyOperator } from "../outputs/operatorEmail.js";
import { briefHour } from "../db/queries/settings.js";
import { BRIEF_HOUR, BRIEF_TZ, localHour } from "../time.js";
import { runBrief } from "./brief.js";
import { syncAll } from "./sync.js";

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
