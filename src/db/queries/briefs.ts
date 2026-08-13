import { randomBytes } from "node:crypto";
import { pool } from "../pool.js";

/**
 * Brief persistence and carry-over.
 *
 * Several briefs per local date are allowed — a manual test send must not block
 * the scheduled one. What stops accidental repeats is the hour gate in the job,
 * not a constraint here.
 */

export interface BriefRow {
  id: number;
  local_date: string;
  status: "pending" | "sent" | "failed";
  share_token: string;
  payload: unknown;
  sent_at: Date | null;
}

export interface CarriedItem {
  refKey: string;
  firstSeen: string;
  daysReported: number;
}

/**
 * Records a new brief.
 *
 * No longer one-per-day: the hour gate is what stops the scheduler sending
 * twice, and while ranking is being tuned, a manual send must not consume the
 * day's slot and block the real one.
 */
export async function createBrief(localDate: string): Promise<BriefRow> {
  const { rows } = await pool.query<BriefRow>(
    `insert into briefs (local_date, status, share_token, share_expires_at)
     values ($1, 'pending', $2, now() + interval '30 days')
     returning id, local_date::text as local_date, status, share_token, payload, sent_at`,
    [localDate, randomBytes(24).toString("base64url")],
  );
  const row = rows[0];
  if (!row) throw new Error("createBrief returned no row");
  return row;
}

export async function getBrief(localDate: string): Promise<BriefRow | null> {
  const { rows } = await pool.query<BriefRow>(
    `select id, local_date::text as local_date, status, share_token, payload, sent_at
       from briefs where local_date = $1 order by id desc limit 1`,
    [localDate],
  );
  return rows[0] ?? null;
}

export async function getBriefByToken(token: string): Promise<BriefRow | null> {
  const { rows } = await pool.query<BriefRow>(
    `select id, local_date::text as local_date, status, share_token, payload, sent_at
       from briefs
      where share_token = $1
        and (share_expires_at is null or share_expires_at > now())`,
    [token],
  );
  return rows[0] ?? null;
}

/**
 * How long each thread has already been reported.
 *
 * Without this the same email reappears every morning as if new, and the brief
 * reads as noise. With it, an item can say "still open — day 3", which is the
 * difference between a report and a nag.
 */
export async function carriedOverItems(
  beforeDate: string,
): Promise<Map<string, CarriedItem>> {
  const { rows } = await pool.query<{
    ref_key: string;
    first_seen: string;
    days_reported: number;
  }>(
    `select bi.ref_key,
            min(coalesce(bi.first_seen_brief_date, b.local_date))::text as first_seen,
            count(distinct b.local_date)::int as days_reported
       from brief_items bi
       join briefs b on b.id = bi.brief_id
      where bi.kind = 'email'
        and b.local_date < $1
        and b.local_date >= $1::date - interval '14 days'
      group by bi.ref_key`,
    [beforeDate],
  );

  return new Map(
    rows.map((r) => [
      r.ref_key,
      { refKey: r.ref_key, firstSeen: r.first_seen, daysReported: r.days_reported },
    ]),
  );
}

export async function saveBriefItems(
  briefId: number,
  items: Array<{ kind: string; refKey: string; rank: number; reason: string; firstSeen: string }>,
): Promise<void> {
  if (items.length === 0) return;

  const values: unknown[] = [];
  const tuples: string[] = [];
  items.forEach((it, i) => {
    const p = i * 6;
    tuples.push(`($${p + 1},$${p + 2},$${p + 3},$${p + 4},$${p + 5},$${p + 6})`);
    values.push(briefId, it.kind, it.refKey, it.rank, it.reason, it.firstSeen);
  });

  await pool.query(
    `insert into brief_items (brief_id, kind, ref_key, rank, reason, first_seen_brief_date)
     values ${tuples.join(",")}
     on conflict (brief_id, kind, ref_key) do nothing`,
    values,
  );
}

export async function markBriefSent(
  briefId: number,
  payload: unknown,
  messageSid: string | null,
  skipped: string[],
): Promise<void> {
  await pool.query(
    `update briefs
        set status = 'sent', payload = $2::jsonb, message_sid = $3,
            skipped_accounts = $4, sent_at = now()
      where id = $1`,
    [briefId, JSON.stringify(payload), messageSid, skipped],
  );
}

export async function markBriefFailed(briefId: number, payload: unknown): Promise<void> {
  await pool.query(
    `update briefs set status = 'failed', payload = $2::jsonb where id = $1`,
    [briefId, JSON.stringify(payload)],
  );
}

// --- history and retention --------------------------------------------------

export interface BriefSummary {
  id: number;
  local_date: string;
  status: "pending" | "sent" | "failed";
  sent_at: Date | null;
  message_sid: string | null;
  share_token: string;
  skipped_accounts: string[];
  payload: unknown;
}

export async function countBriefs(): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    "select count(*)::int n from briefs",
  );
  return rows[0]?.n ?? 0;
}

export async function listBriefs(
  limit: number,
  offset: number,
): Promise<BriefSummary[]> {
  const { rows } = await pool.query<BriefSummary>(
    `select id, local_date::text as local_date, status, sent_at, message_sid,
            share_token, skipped_accounts, payload
       from briefs
      order by local_date desc, id desc
      limit $1 offset $2`,
    [limit, offset],
  );
  return rows;
}

/**
 * Deletes briefs past the retention window.
 *
 * Runs after a successful send rather than on its own schedule: it is cheap,
 * and tying it to the daily job means there is no second thing to deploy or
 * forget. brief_items cascade with the parent row.
 */
export async function pruneOldBriefs(retentionDays: number): Promise<number> {
  const { rowCount } = await pool.query(
    `delete from briefs where local_date < (current_date - ($1 || ' days')::interval)`,
    [String(retentionDays)],
  );
  return rowCount ?? 0;
}
