import { pool } from "../db/pool.js";
import { notifyOperator } from "../outputs/operatorEmail.js";
import { briefHour } from "../db/queries/settings.js";
import { BRIEF_HOUR, BRIEF_TZ, localHour } from "../time.js";
import { runBrief } from "./brief.js";
import { syncAll } from "./sync.js";

/**
 * The scheduled worker. Runs hourly, does both jobs, and exits.
 *
 * One schedule rather than two: the brief already self-gates on BRIEF_HOUR and
 * on its own idempotency row, so attempting it every hour is safe and costs a
 * database round trip on the twenty-three hours it does nothing.
 *
 * Syncing hourly is not about completeness — the Gmail history cursor picks up
 * everything since the last successful run, so one sync a day would capture the
 * same messages. It is about not letting a single failed sync ship a brief built
 * on yesterday's data, which would look completely normal and be wrong.
 */

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function main(): Promise<void> {
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
      subject: "Sync failed entirely",
      body:
        `The hourly sync threw before finishing.\n\n${syncFailed}\n\n` +
        "The brief will still run, on whatever data was already stored.",
    });
  }

  const result = await runBrief();
  console.log(`[worker] brief: ${result.status} — ${result.message}`);

  // Read the configured hour, not the env fallback: the gate uses the console
  // setting, and a log line that disagrees with the gate is worse than none.
  const configuredHour = await briefHour(BRIEF_HOUR);
  console.log(
    `[worker] done in ${((Date.now() - started) / 1000).toFixed(1)}s ` +
      `(${localHour()}:00 ${BRIEF_TZ}, brief hour is ${configuredHour}:00)`,
  );

  // A sync that died outright is worth a non-zero exit so the platform shows the
  // run as failed, even though the brief itself may have gone out fine.
  if (syncFailed) process.exitCode = 1;
}

main()
  .then(() => pool.end())
  .catch(async (err: unknown) => {
    console.error("[worker] fatal:", errorText(err));
    await notifyOperator({
      subject: "Worker run failed",
      body: `The scheduled worker did not complete.\n\n${errorText(err)}`,
    });
    await pool.end();
    process.exit(1);
  });
