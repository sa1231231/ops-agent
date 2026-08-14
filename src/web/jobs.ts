/**
 * The manually-triggered run.
 *
 * One job, not three. Sync and brief were separate buttons because the brief
 * used to be something you were careful about firing; it isn't — it is
 * read-only either way, and the only thing a preview saved was an SMS segment.
 * Splitting them mostly created a way to send a brief against stale mail.
 *
 * The run takes far longer than a request should — a cold-start sync across
 * fifteen mailboxes is minutes, and the brief waits on a model call. So the
 * handler starts the work and returns immediately, and the console polls by
 * refreshing itself.
 *
 * State is in memory, which is correct for a single instance and is the same
 * assumption the OAuth state map already makes. A restart loses the last
 * result, not the work: sync writes to Postgres as it goes, and every brief that
 * actually sent is a row in `briefs`.
 */

export interface JobState {
  running: boolean;
  startedAt: Date | null;
  finishedAt: Date | null;
  summary: string | null;
  error: string | null;
}

const idle: JobState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  summary: null,
  error: null,
};

let state: JobState = idle;

export function jobState(): JobState {
  return state;
}

/**
 * Starts the run unless one is already going.
 *
 * Returns false when it was already in flight, so a double-click or an
 * over-eager refresh cannot launch a second sync against the same mailboxes.
 */
export function startJob(work: () => Promise<string>): boolean {
  if (state.running) return false;

  const startedAt = new Date();
  state = { running: true, startedAt, finishedAt: null, summary: null, error: null };

  // Deliberately not awaited: the caller has already responded.
  void work()
    .then((summary) => {
      state = { running: false, startedAt, finishedAt: new Date(), summary, error: null };
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[job] run failed:", message);
      state = {
        running: false,
        startedAt,
        finishedAt: new Date(),
        summary: null,
        error: message,
      };
    });

  return true;
}
