import { runCycle, reportCycleFailure } from "./worker.js";

/**
 * The hourly tick, run inside the web process.
 *
 * The web service is already up all the time to serve the console, so it can
 * own the schedule. This exists because the separate Railway cron service
 * proved unreliable in a way no code change could reach — deployments failing
 * before a build was even created — and a brief that does not fire is worth
 * more than a tidy separation of processes.
 *
 * It is the same `runCycle` the standalone worker calls. Nothing about the job
 * knows which process it is in.
 *
 * Off by default. `ENABLE_SCHEDULER=1` turns it on, so exactly one thing in a
 * deployment is driving the schedule and turning it back off is one variable.
 */

const HOUR_MS = 3_600_000;

/**
 * A few seconds past the hour, not on it: the brief gates on the local hour, and
 * firing at exactly :00:00 risks a clock a hair behind reading the previous hour
 * and skipping the day entirely.
 */
const OFFSET_MS = 5_000;

function msUntilNextHour(now = Date.now()): number {
  const nextHour = Math.floor(now / HOUR_MS) * HOUR_MS + HOUR_MS;
  return nextHour - now + OFFSET_MS;
}

let running = false;

async function tick(): Promise<void> {
  // A cold-start sync across fifteen mailboxes can outlast an hour. Skipping is
  // correct: the next tick picks up from the same Gmail history cursor, and two
  // concurrent syncs on one account would race each other's writes.
  if (running) {
    console.warn("[scheduler] previous cycle still running, skipping this hour");
    return;
  }

  running = true;
  try {
    await runCycle();
  } catch (err) {
    // Never rethrow: an unhandled rejection here would take the console down
    // with it, and the console is how you find out anything is wrong.
    await reportCycleFailure(err).catch(() => {});
  } finally {
    running = false;
  }
}

export function startScheduler(): void {
  const arm = (): void => {
    const delay = msUntilNextHour();
    // Re-armed from the wall clock each time rather than setInterval, which
    // drifts and would eventually fire in the wrong hour.
    setTimeout(() => {
      void tick().finally(arm);
    }, delay).unref();

    console.log(`[scheduler] next run in ${Math.round(delay / 60_000)}m`);
  };

  arm();
  console.log("[scheduler] hourly cycle enabled in this process");
}
