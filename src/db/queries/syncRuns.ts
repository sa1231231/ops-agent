import { pool } from "../pool.js";

export type SyncSource = "gmail_inbox" | "gmail_sent" | "calendar";

/**
 * Every sync attempt writes a row here, success or failure. This is what makes
 * a dead account a record rather than an exception — the brief still renders,
 * and the admin console can explain exactly what was skipped and why.
 */
export async function startRun(
  accountId: number,
  source: SyncSource,
): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `insert into sync_runs (account_id, source, status)
     values ($1, $2, 'running') returning id`,
    [accountId, source],
  );
  const row = rows[0];
  if (!row) throw new Error("startRun returned no row");
  return row.id;
}

export async function finishRun(
  runId: number,
  counts: Record<string, number>,
): Promise<void> {
  await pool.query(
    `update sync_runs
        set status = 'ok', finished_at = now(), counts = $2::jsonb
      where id = $1`,
    [runId, JSON.stringify(counts)],
  );
}

export async function failRun(runId: number, error: string): Promise<void> {
  await pool.query(
    `update sync_runs
        set status = 'error', finished_at = now(), error = $2
      where id = $1`,
    [runId, error.slice(0, 2000)],
  );
}

export async function markAccountSynced(
  accountId: number,
  historyId: string | null,
): Promise<void> {
  await pool.query(
    `update accounts
        set last_sync_at = now(),
            gmail_history_id = coalesce($2, gmail_history_id),
            status = case when status = 'auth_error' then 'active' else status end,
            last_error = null,
            updated_at = now()
      where id = $1`,
    [accountId, historyId],
  );
}
