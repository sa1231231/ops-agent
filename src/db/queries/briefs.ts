import { randomBytes } from "node:crypto";
import { pool } from "../pool.js";

/**
 * Brief persistence and carry-over.
 *
 * `local_date` is UNIQUE, which is the idempotency gate: a cron retry, a
 * redeploy mid-run, or two workers racing cannot produce two WhatsApp messages
 * in one day.
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
 * Claims today's brief, or returns null if one already exists.
 *
 * The insert is the lock. Checking-then-inserting would leave a window where
 * two workers both see "no brief yet" and both send.
 */
export async function claimBrief(localDate: string): Promise<BriefRow | null> {
  const { rows } = await pool.query<BriefRow>(
    `insert into briefs (local_date, status, share_token, share_expires_at)
     values ($1, 'pending', $2, now() + interval '30 days')
     on conflict (local_date) do nothing
     returning id, local_date, status, share_token, payload, sent_at`,
    [localDate, randomBytes(24).toString("base64url")],
  );
  return rows[0] ?? null;
}

/**
 * Releases a claim without recording anything.
 *
 * A dry run must be side-effect free and repeatable: it should neither consume
 * the day's only send nor write carry-over rows that would make tomorrow claim
 * an item was already reported.
 */
export async function releaseBrief(briefId: number): Promise<void> {
  await pool.query("delete from briefs where id = $1 and status = 'pending'", [
    briefId,
  ]);
}

export async function getBrief(localDate: string): Promise<BriefRow | null> {
  const { rows } = await pool.query<BriefRow>(
    `select id, local_date, status, share_token, payload, sent_at
       from briefs where local_date = $1`,
    [localDate],
  );
  return rows[0] ?? null;
}

export async function getBriefByToken(token: string): Promise<BriefRow | null> {
  const { rows } = await pool.query<BriefRow>(
    `select id, local_date, status, share_token, payload, sent_at
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
