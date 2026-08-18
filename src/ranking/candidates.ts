import { pool } from "../db/pool.js";
import { loadRuleSet } from "../db/queries/rules.js";
import { deadlineFor } from "../signals/deadlines.js";
import { BRIEF_TZ } from "../time.js";
import {
  rankThreads,
  scoreThread,
  type ScoredThread,
  type ThreadCandidate,
} from "../signals/score.js";
import * as W from "../signals/weights.js";

/**
 * Deterministic pre-filter: assemble candidates from Postgres, score them with
 * fixed weights, and hand only the survivors to the model.
 *
 * Doing the narrowing in code rather than in the prompt is what keeps the brief
 * stable day to day and the token cost flat regardless of inbox volume.
 */

interface CandidateRow {
  account_id: number;
  account_email: string;
  gmail_thread_id: string;
  subject: string | null;
  snippet: string | null;
  last_inbound_at: Date | null;
  last_outbound_at: Date | null;
  awaiting_reply: boolean;
  message_count: number;
  from_email: string | null;
  from_name: string | null;
  to_emails: string[];
  cc_emails: string[];
  is_automated: boolean;
  has_list_unsubscribe: boolean;
  is_unread: boolean;
  is_archived: boolean;
  is_important: boolean;
  reported_mornings: number;
  sender_messages_recent: number;
  outbound_count: number;
  last_outbound_to_sender_at: Date | null;
  meeting_soon_at: Date | null;
  met_recently_at: Date | null;
}

const CANDIDATE_SQL = `
with latest_inbound as (
  -- The newest inbound message defines the thread's ask: who is waiting, what
  -- they said, and whether he was addressed directly.
  select distinct on (m.account_id, m.gmail_thread_id)
         m.account_id, m.gmail_thread_id, m.from_email, m.from_name, m.snippet,
         m.to_emails, m.cc_emails, m.is_automated, m.has_list_unsubscribe,
         -- Gmail's own state for the newest inbound message. Absent UNREAD means
         -- he opened it; absent INBOX means he archived it.
         ('UNREAD' = any(m.labels)) as is_unread,
         (not ('INBOX' = any(m.labels))) as is_archived,
         ('IMPORTANT' = any(m.labels)) as is_important
    from messages m
   where m.direction = 'inbound'
   order by m.account_id, m.gmail_thread_id, m.sent_at desc nulls last
)
select
  t.account_id,
  a.email as account_email,
  t.gmail_thread_id,
  t.subject,
  li.snippet,
  t.last_inbound_at,
  t.last_outbound_at,
  t.awaiting_reply,
  t.message_count,
  li.from_email,
  li.from_name,
  li.to_emails,
  li.cc_emails,
  li.is_automated,
  li.has_list_unsubscribe,
  li.is_unread,
  li.is_archived,
  li.is_important,

  -- Mornings this thread has been in a brief, counted only since the last time
  -- the count was reset. Two things reset it. A new inbound message, because
  -- that is new information and the old repetitions were about something else.
  -- And a "Good call" verdict, because he has explicitly said the repetition was
  -- right, and continuing to count toward giving up would be overruling him.
  (select count(distinct b.local_date)
     from brief_items bi
     join briefs b on b.id = bi.brief_id
    where bi.kind = 'email'
      and bi.ref_key = t.account_id::text || ':' || t.gmail_thread_id
      and b.local_date > coalesce(
            (select max(b2.local_date)
               from feedback f
               join briefs b2 on b2.id = f.brief_id
              where f.thread_key = bi.ref_key and f.verdict = 'good'),
            '-infinity'::date)
      and b.local_date >= coalesce(t.last_inbound_at::date, '-infinity'::date)
  )::int as reported_mornings,

  -- How much this sender has sent lately, across every account. Deliberately not
  -- per account: one notifier hitting three of his mailboxes is the same noise
  -- three times over, and counting it per mailbox would hide that.
  (select count(*)
     from messages m2
    where m2.direction = 'inbound'
      and m2.from_email = li.from_email
      and m2.sent_at > now() - ($5 || ' days')::interval
  )::int as sender_messages_recent,
  coalesce(c.outbound_count, 0) as outbound_count,
  c.last_outbound_at as last_outbound_to_sender_at,

  -- Meeting with this sender coming up. Their mail is probably about it, and it
  -- stops mattering the moment the meeting starts.
  (select min(e.starts_at)
     from events e
    where e.starts_at >= $1::timestamptz
      and e.starts_at <  $1::timestamptz + ($2 || ' hours')::interval
      and exists (select 1 from jsonb_array_elements(e.attendees) att
                   where lower(att->>'email') = li.from_email)
  ) as meeting_soon_at,

  -- Met recently and he has not written to them since: the follow-up he owes.
  -- Calendars are searched across *all* accounts, because it is the same human
  -- regardless of which mailbox the invite landed in.
  (select max(e.starts_at)
     from events e
    where e.starts_at <  $1::timestamptz
      and e.starts_at >= $1::timestamptz - ($3 || ' days')::interval
      and exists (select 1 from jsonb_array_elements(e.attendees) att
                   where lower(att->>'email') = li.from_email)
      and (c.last_outbound_at is null or c.last_outbound_at < e.starts_at)
  ) as met_recently_at

from threads t
join accounts a on a.id = t.account_id
join latest_inbound li
  on li.account_id = t.account_id
 and li.gmail_thread_id = t.gmail_thread_id
left join correspondents c
  on c.account_id = t.account_id
 and c.email = li.from_email
where a.status <> 'disabled'
  and t.last_inbound_at is not null
  and t.last_inbound_at >= $1::timestamptz - ($4 || ' days')::interval
`;

function toCandidate(row: CandidateRow, now: Date): ThreadCandidate {
  return {
    accountId: row.account_id,
    accountEmail: row.account_email,
    gmailThreadId: row.gmail_thread_id,
    subject: row.subject,
    snippet: row.snippet,
    lastInboundAt: row.last_inbound_at,
    lastOutboundAt: row.last_outbound_at,
    awaitingReply: row.awaiting_reply,
    messageCount: row.message_count,
    fromEmail: row.from_email,
    fromName: row.from_name,
    toEmails: row.to_emails ?? [],
    ccEmails: row.cc_emails ?? [],
    isAutomated: row.is_automated,
    hasListUnsubscribe: row.has_list_unsubscribe,
    isUnread: row.is_unread,
    isArchived: row.is_archived,
    isImportant: row.is_important,
    reportedMornings: row.reported_mornings,
    senderMessagesRecent: row.sender_messages_recent,
    outboundCount: row.outbound_count,
    lastOutboundToSenderAt: row.last_outbound_to_sender_at,
    meetingSoonAt: row.meeting_soon_at,
    metRecentlyAt: row.met_recently_at,
    // Resolved here rather than in the scorer: it needs a timezone, and
    // `signals/` is deliberately free of both env and clock.
    deadline: deadlineFor(
      `${row.subject ?? ""} ${row.snippet ?? ""}`,
      row.last_inbound_at,
      now,
      BRIEF_TZ,
    ),
  };
}

/** Every candidate, scored and ranked — before the score floor is applied. */
export async function scoreAllCandidates(now = new Date()): Promise<ScoredThread[]> {
  // The rule set is loaded once and shared across every candidate, which keeps
  // `scoreThread` a pure function of its arguments.
  const [{ rows }, rules] = await Promise.all([
    pool.query<CandidateRow>(CANDIDATE_SQL, [
      now.toISOString(),
      String(W.MEETING_SOON_HOURS),
      String(W.MET_RECENTLY_DAYS),
      String(W.CANDIDATE_MAX_AGE_DAYS),
      String(W.MACHINE_REPEAT_WINDOW_DAYS),
    ]),
    loadRuleSet(),
  ]);

  return rankThreads(rows.map((row) => scoreThread(toCandidate(row, now), now, rules)));
}

/** What actually reaches the model: above the floor, capped, deterministic. */
export async function selectCandidates(now = new Date()): Promise<ScoredThread[]> {
  const all = await scoreAllCandidates(now);
  return all
    .filter((t) => t.score >= W.MIN_SCORE_FOR_BRIEF)
    .slice(0, W.MAX_CANDIDATES);
}
