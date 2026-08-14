import type { PoolClient } from "pg";
import { pool } from "../pool.js";
import type { NormalizedMessage } from "../../sources/gmail.js";

/**
 * Thread state and the correspondent graph are *derived* from `messages` by
 * SQL rather than accumulated incrementally in JavaScript. Recomputing from the
 * stored rows is idempotent: syncing the same messages twice cannot double-count
 * a correspondent or corrupt an awaiting_reply flag.
 */

const CHUNK = 100;
const COLUMNS = 14;

export async function insertMessages(
  accountId: number,
  messages: NormalizedMessage[],
  client: PoolClient | typeof pool = pool,
): Promise<number> {
  if (messages.length === 0) return 0;

  let inserted = 0;

  for (let start = 0; start < messages.length; start += CHUNK) {
    const chunk = messages.slice(start, start + CHUNK);
    const values: unknown[] = [];
    const tuples: string[] = [];

    chunk.forEach((m, i) => {
      const p = i * COLUMNS;
      tuples.push(
        `($${p + 1},$${p + 2},$${p + 3},$${p + 4},$${p + 5},$${p + 6},$${p + 7},` +
          `$${p + 8},$${p + 9},$${p + 10},$${p + 11},$${p + 12},$${p + 13},$${p + 14})`,
      );
      values.push(
        accountId,
        m.gmailMessageId,
        m.gmailThreadId,
        m.fromEmail,
        m.fromName,
        m.toEmails,
        m.ccEmails,
        m.subject,
        m.snippet,
        m.sentAt,
        m.direction,
        m.hasListUnsubscribe,
        m.isAutomated,
        m.labels,
      );
    });

    const { rowCount } = await client.query(
      `insert into messages (
         account_id, gmail_message_id, gmail_thread_id, from_email, from_name,
         to_emails, cc_emails, subject, snippet, sent_at, direction,
         has_list_unsubscribe, is_automated, labels
       )
       values ${tuples.join(",")}
       on conflict (account_id, gmail_message_id) do update set
         -- Labels and snippet are the only fields that change after delivery
         -- (read/starred state, thread trimming). Everything else is immutable.
         labels  = excluded.labels,
         snippet = excluded.snippet`,
      values,
    );
    inserted += rowCount ?? 0;
  }

  return inserted;
}

/**
 * Rebuilds thread state for one account.
 *
 * `awaiting_reply` is the dominant ranking signal, so it is computed here from
 * ground truth — the newest inbound is later than the newest outbound — rather
 * than inferred at brief time. That is what makes "unanswered for six days" a
 * stored fact that survives a Gmail outage at 6:29am.
 */
/**
 * Removes messages he has reclassified out of the inbox.
 *
 * The counterpart to excluding Promotions and Social at fetch time. Google
 * decides first, he overrules Google, and that has to work in both directions —
 * otherwise something he files away keeps briefing him forever off a row nobody
 * will ever refresh.
 *
 * Threads are recomputed from messages after every sync, so removing the rows
 * is enough; nothing else needs unwinding.
 */
export async function deleteMessages(
  accountId: number,
  gmailMessageIds: string[],
): Promise<number> {
  if (gmailMessageIds.length === 0) return 0;
  const { rowCount } = await pool.query(
    `delete from messages
      where account_id = $1 and gmail_message_id = any($2::text[])`,
    [accountId, gmailMessageIds],
  );
  return rowCount ?? 0;
}

export async function recomputeThreads(accountId: number): Promise<number> {
  const { rowCount } = await pool.query(
    `insert into threads (
       account_id, gmail_thread_id, subject, last_inbound_at, last_outbound_at,
       awaiting_reply, participants, message_count, updated_at
     )
     select
       m.account_id,
       m.gmail_thread_id,
       (array_agg(m.subject order by m.sent_at desc nulls last))[1],
       max(m.sent_at) filter (where m.direction = 'inbound'),
       max(m.sent_at) filter (where m.direction = 'outbound'),
       count(*) filter (where m.direction = 'inbound') > 0
         and coalesce(max(m.sent_at) filter (where m.direction = 'inbound'), 'epoch'::timestamptz)
           > coalesce(max(m.sent_at) filter (where m.direction = 'outbound'), 'epoch'::timestamptz),
       coalesce((
         select array_agg(distinct addr)
           from messages m2,
                lateral (
                  select m2.from_email as addr
                  union all select unnest(m2.to_emails)
                  union all select unnest(m2.cc_emails)
                ) a
          where m2.account_id = m.account_id
            and m2.gmail_thread_id = m.gmail_thread_id
            and addr is not null and addr <> ''
       ), '{}'),
       count(*),
       now()
     from messages m
     where m.account_id = $1
     group by m.account_id, m.gmail_thread_id
     on conflict (account_id, gmail_thread_id) do update set
       subject          = excluded.subject,
       last_inbound_at  = excluded.last_inbound_at,
       last_outbound_at = excluded.last_outbound_at,
       awaiting_reply   = excluded.awaiting_reply,
       participants     = excluded.participants,
       message_count    = excluded.message_count,
       updated_at       = now()`,
    [accountId],
  );
  return rowCount ?? 0;
}

/**
 * Rebuilds the correspondent graph for one account.
 *
 * Outbound weight comes from who he addresses; inbound from who writes to him.
 * The outbound side is the signal that matters — anyone can email you, but who
 * *you* email, and how recently, is what identifies a real relationship.
 */
export async function recomputeCorrespondents(
  accountId: number,
  accountEmail: string,
): Promise<number> {
  const { rowCount } = await pool.query(
    `insert into correspondents (
       account_id, email, outbound_count, inbound_count,
       last_outbound_at, last_inbound_at, updated_at
     )
     select
       $1, addr,
       count(*) filter (where direction = 'outbound'),
       count(*) filter (where direction = 'inbound'),
       max(sent_at) filter (where direction = 'outbound'),
       max(sent_at) filter (where direction = 'inbound'),
       now()
     from (
       select m.direction, m.sent_at, unnest(m.to_emails || m.cc_emails) as addr
         from messages m
        where m.account_id = $1 and m.direction = 'outbound'
       union all
       select m.direction, m.sent_at, m.from_email as addr
         from messages m
        where m.account_id = $1 and m.direction = 'inbound'
     ) t
     where addr is not null and addr <> '' and addr <> $2
     group by addr
     on conflict (account_id, email) do update set
       outbound_count   = excluded.outbound_count,
       inbound_count    = excluded.inbound_count,
       last_outbound_at = excluded.last_outbound_at,
       last_inbound_at  = excluded.last_inbound_at,
       updated_at       = now()`,
    [accountId, accountEmail],
  );
  return rowCount ?? 0;
}
