/**
 * Manually-triggered job runs.
 *
 * Sync and brief both take far longer than a request should — a cold-start sync
 * across fifteen mailboxes is minutes, and the brief waits on a model call. So
 * the handler starts the work and returns immediately, and the console polls by
 * refreshing itself.
 *
 * State is in memory, which is correct for a single instance and is the same
 * assumption the OAuth state map already makes. A restart loses the last
 * result, not the work: sync writes to Postgres as it goes, and the brief's own
 * idempotency gate is the database row, not this.
 */

export type JobName = "sync" | "brief";

export interface JobState {
  running: boolean;
  startedAt: Date | null;
  finishedAt: Date | null;
  summary: string | null;
  detail: string | null;
  error: string | null;
}

const initial = (): JobState => ({
  running: false,
  startedAt: null,
  finishedAt: null,
  summary: null,
  detail: null,
  error: null,
});

const state: Record<JobName, JobState> = {
  sync: initial(),
  brief: initial(),
};

export function jobState(name: JobName): JobState {
  return state[name];
}

export function anyJobRunning(): boolean {
  return state.sync.running || state.brief.running;
}

export interface JobResult {
  summary: string;
  detail?: string;
}

/**
 * Starts a job unless it is already running.
 *
 * Returns false when it was already in flight, so a double-click or an
 * over-eager refresh cannot launch a second sync against the same mailboxes.
 */
export function startJob(
  name: JobName,
  work: () => Promise<JobResult>,
): boolean {
  const job = state[name];
  if (job.running) return false;

  state[name] = {
    running: true,
    startedAt: new Date(),
    finishedAt: null,
    summary: null,
    detail: null,
    error: null,
  };

  // Deliberately not awaited: the caller has already responded.
  void work()
    .then((result) => {
      state[name] = {
        running: false,
        startedAt: state[name].startedAt,
        finishedAt: new Date(),
        summary: result.summary,
        detail: result.detail ?? null,
        error: null,
      };
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[job] ${name} failed:`, message);
      state[name] = {
        running: false,
        startedAt: state[name].startedAt,
        finishedAt: new Date(),
        summary: null,
        detail: null,
        error: message,
      };
    });

  return true;
}
