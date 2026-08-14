import { pool } from "../pool.js";
import type { RuleSet, SenderRule, ThreadRule } from "../../signals/rules.js";
import * as W from "../../signals/weights.js";

/**
 * Storage for the tuning layers.
 *
 * `feedback` is append-only and is the source of truth: rules can be rebuilt
 * from verdicts, but verdicts cannot be rebuilt from rules. It is also the
 * regression corpus — replaying past verdicts against changed weights is how a
 * tuning change gets checked against every judgement already made.
 */

export type Verdict = "good" | "not-important" | "badly-written" | "missed";

export interface FeedbackInput {
  briefId: number | null;
  threadKey: string | null;
  verdict: Verdict;
  choice?: string | null;
  note?: string | null;
  scoreAtTime?: number | null;
}

export async function recordFeedback(input: FeedbackInput): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `insert into feedback (brief_id, thread_key, verdict, choice, note, score_at_time)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [
      input.briefId,
      input.threadKey,
      input.verdict,
      input.choice ?? null,
      input.note ?? null,
      input.scoreAtTime ?? null,
    ],
  );
  return rows[0]!.id;
}

/**
 * Adds a sender rule, or strengthens the one already there.
 *
 * Repeat verdicts raise `confidence` rather than stacking rows, which is what
 * makes a rule earn its strength instead of arriving at full force from a single
 * irritated morning. The adjustment is clamped so no rule can become a de-facto
 * filter.
 */
export async function upsertSenderRule(rule: {
  pattern: string;
  scope: "address" | "domain";
  accountId?: number | null;
  adjustment: number;
  reason?: string | null;
  sourceBrief?: number | null;
}): Promise<void> {
  const clamped = Math.max(
    -W.SENDER_RULE_MAX,
    Math.min(W.SENDER_RULE_MAX, Math.round(rule.adjustment)),
  );

  await pool.query(
    `insert into sender_rules (pattern, scope, account_id, adjustment, confidence, reason, source_brief)
     values (lower($1), $2, $3, $4, 1, $5, $6)
     on conflict (pattern, scope, account_id) do update
       set confidence = sender_rules.confidence + 1,
           -- Keep the stronger opinion, and let a reversal flip the sign rather
           -- than averaging into a meaningless middle.
           adjustment = case
             when sign(excluded.adjustment) <> sign(sender_rules.adjustment)
               then excluded.adjustment
             when abs(excluded.adjustment) > abs(sender_rules.adjustment)
               then excluded.adjustment
             else sender_rules.adjustment
           end,
           reason = coalesce(excluded.reason, sender_rules.reason)`,
    [
      rule.pattern,
      rule.scope,
      rule.accountId ?? null,
      clamped,
      rule.reason ?? null,
      rule.sourceBrief ?? null,
    ],
  );
}

export async function setThreadRule(rule: {
  threadKey: string;
  verdict: "pin" | "mute";
  expiresAt?: Date | null;
  reason?: string | null;
}): Promise<void> {
  await pool.query(
    `insert into thread_rules (thread_key, verdict, expires_at, reason)
     values ($1, $2, $3, $4)
     on conflict (thread_key) do update
       set verdict = excluded.verdict,
           expires_at = excluded.expires_at,
           reason = coalesce(excluded.reason, thread_rules.reason)`,
    [rule.threadKey, rule.verdict, rule.expiresAt ?? null, rule.reason ?? null],
  );
}

export async function deleteSenderRule(id: number): Promise<void> {
  await pool.query("delete from sender_rules where id = $1", [id]);
}

export async function deleteThreadRule(id: number): Promise<void> {
  await pool.query("delete from thread_rules where id = $1", [id]);
}

export async function addBriefRule(rule: string): Promise<void> {
  await pool.query("insert into brief_rules (rule) values ($1)", [rule]);
}

export async function deleteBriefRule(id: number): Promise<void> {
  await pool.query("delete from brief_rules where id = $1", [id]);
}

export interface BriefRule {
  id: number;
  rule: string;
  active: boolean;
}

export async function activeBriefRules(): Promise<BriefRule[]> {
  const { rows } = await pool.query<BriefRule>(
    "select id, rule, active from brief_rules where active order by id",
  );
  return rows;
}

/** Every rule, loaded once per scoring run. */
export async function loadRuleSet(): Promise<RuleSet> {
  const [senders, threads] = await Promise.all([
    pool.query<{
      id: number;
      pattern: string;
      scope: "address" | "domain";
      account_id: number | null;
      adjustment: number;
      confidence: number;
      reason: string | null;
    }>(
      `select id, pattern, scope, account_id, adjustment, confidence, reason
         from sender_rules`,
    ),
    pool.query<{
      id: number;
      thread_key: string;
      verdict: "pin" | "mute";
      expires_at: Date | null;
      reason: string | null;
    }>(
      // Expired rows are filtered at match time too; excluding them here keeps
      // the loaded set small.
      `select id, thread_key, verdict, expires_at, reason
         from thread_rules
        where expires_at is null or expires_at > now()`,
    ),
  ]);

  const senderRules: SenderRule[] = senders.rows.map((r) => ({
    id: r.id,
    pattern: r.pattern,
    scope: r.scope,
    accountId: r.account_id,
    adjustment: r.adjustment,
    confidence: r.confidence,
    reason: r.reason,
  }));

  const threadRules = new Map<string, ThreadRule>(
    threads.rows.map((r) => [
      r.thread_key,
      {
        id: r.id,
        threadKey: r.thread_key,
        verdict: r.verdict,
        expiresAt: r.expires_at,
        reason: r.reason,
      },
    ]),
  );

  return { senders: senderRules, threads: threadRules };
}

/**
 * Counts a rule as having influenced a real brief.
 *
 * Bumped only on a genuine send, never on a console page load — the scoring
 * view recomputes on every refresh, and counting those would make a rule look
 * load-bearing when nobody had done anything but look at it.
 */
export async function recordRuleFires(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await pool.query(
    `update sender_rules
        set times_fired = times_fired + 1, last_fired_at = now()
      where id = any($1::bigint[])`,
    [ids],
  );
}

export interface SenderRuleRow extends SenderRule {
  timesFired: number;
  lastFiredAt: Date | null;
  accountEmail: string | null;
  createdAt: Date;
}

export async function listSenderRules(): Promise<SenderRuleRow[]> {
  const { rows } = await pool.query<{
    id: number;
    pattern: string;
    scope: "address" | "domain";
    account_id: number | null;
    account_email: string | null;
    adjustment: number;
    confidence: number;
    reason: string | null;
    times_fired: number;
    last_fired_at: Date | null;
    created_at: Date;
  }>(
    `select r.id, r.pattern, r.scope, r.account_id, a.email as account_email,
            r.adjustment, r.confidence, r.reason, r.times_fired, r.last_fired_at,
            r.created_at
       from sender_rules r
       left join accounts a on a.id = r.account_id
      order by abs(r.adjustment) desc, r.pattern`,
  );
  return rows.map((r) => ({
    id: r.id,
    pattern: r.pattern,
    scope: r.scope,
    accountId: r.account_id,
    accountEmail: r.account_email,
    adjustment: r.adjustment,
    confidence: r.confidence,
    reason: r.reason,
    timesFired: r.times_fired,
    lastFiredAt: r.last_fired_at,
    createdAt: r.created_at,
  }));
}

export interface ThreadRuleRow extends ThreadRule {
  subject: string | null;
  createdAt: Date;
}

export async function listThreadRules(): Promise<ThreadRuleRow[]> {
  const { rows } = await pool.query<{
    id: number;
    thread_key: string;
    verdict: "pin" | "mute";
    expires_at: Date | null;
    reason: string | null;
    created_at: Date;
    subject: string | null;
  }>(
    // The thread key is "<account_id>:<gmail_thread_id>"; joining back to
    // threads recovers a human-readable subject for the rules list.
    `select r.id, r.thread_key, r.verdict, r.expires_at, r.reason, r.created_at,
            t.subject
       from thread_rules r
       left join threads t
         on t.account_id = split_part(r.thread_key, ':', 1)::bigint
        and t.gmail_thread_id = split_part(r.thread_key, ':', 2)
      order by r.created_at desc`,
  );
  return rows.map((r) => ({
    id: r.id,
    threadKey: r.thread_key,
    verdict: r.verdict,
    expiresAt: r.expires_at,
    reason: r.reason,
    createdAt: r.created_at,
    subject: r.subject,
  }));
}

/**
 * Layer 3: what the accumulated verdicts suggest.
 *
 * Deliberately a query rather than a stored rule. It proposes; a human decides;
 * the result is a number in `weights.ts`. Nothing here changes scoring on its
 * own — a suggestion engine acting unsupervised is exactly the drift we are
 * trying to avoid.
 */
export interface WeightSuggestion {
  signal: string;
  downVotes: number;
  upVotes: number;
  verdict: string;
}

const MIN_EVIDENCE = 5;

export async function weightSuggestions(): Promise<WeightSuggestion[]> {
  // Signals are stored per-brief in the payload snapshot, so this reads what
  // actually fired on the morning he judged — not what would fire today.
  const { rows } = await pool.query<{
    signal: string;
    down_votes: string;
    up_votes: string;
  }>(
    `with judged as (
       select f.verdict, f.thread_key, b.payload
         from feedback f
         join briefs b on b.id = f.brief_id
        where f.verdict in ('good', 'not-important')
     ),
     sig as (
       select j.verdict, s->>'name' as signal
         from judged j,
              jsonb_array_elements(j.payload->'scoring') item,
              jsonb_array_elements(item->'signals') s
        where item->>'threadKey' = j.thread_key
     )
     select signal,
            count(*) filter (where verdict = 'not-important') as down_votes,
            count(*) filter (where verdict = 'good')          as up_votes
       from sig
      group by signal
     having count(*) >= $1
      order by count(*) filter (where verdict = 'not-important') desc`,
    [MIN_EVIDENCE],
  );

  return rows
    .map((r) => {
      const down = Number(r.down_votes);
      const up = Number(r.up_votes);
      return {
        signal: r.signal,
        downVotes: down,
        upVotes: up,
        verdict:
          down > up * 3
            ? `appears in ${down} rejections vs ${up} approvals — consider weakening`
            : up > down * 3
              ? `appears in ${up} approvals vs ${down} rejections — consider strengthening`
              : `mixed (${up} up, ${down} down) — no clear signal yet`,
      };
    })
    .filter((s) => !s.verdict.startsWith("mixed"));
}

/** Verdicts with enough context to replay them against current scoring. */
export async function feedbackForReplay(): Promise<
  Array<{ threadKey: string; verdict: string; scoreAtTime: number | null; createdAt: Date }>
> {
  const { rows } = await pool.query<{
    thread_key: string;
    verdict: string;
    score_at_time: number | null;
    created_at: Date;
  }>(
    `select thread_key, verdict, score_at_time, created_at
       from feedback
      where thread_key is not null
        and verdict in ('good', 'not-important', 'missed')
      order by created_at desc`,
  );
  return rows.map((r) => ({
    threadKey: r.thread_key,
    verdict: r.verdict,
    scoreAtTime: r.score_at_time,
    createdAt: r.created_at,
  }));
}

/**
 * How the brief is doing, judged by what he actually did.
 *
 * We are read-only, but we resync these mailboxes anyway — so his own outbox
 * grades us for free. Surfaced-and-replied is a good call. **Not-surfaced-and-
 * replied is a false negative the system can detect on its own**, which matters
 * because false negatives are otherwise invisible: he will never report the
 * email he was not shown, because he does not know it exists.
 *
 * Replying is not the same as mattering — he fires off one-liners and sits on
 * hard things. So this **directs attention and never touches scoring**. It says
 * where to look; he still decides.
 */
export interface OutcomeStats {
  surfaced: number;
  surfacedAndReplied: number;
  windowDays: number;
}

export interface MissedThread {
  threadKey: string;
  subject: string | null;
  fromEmail: string | null;
  accountEmail: string;
  repliedAt: Date;
}

const OUTCOME_WINDOW_DAYS = 7;

export async function outcomeStats(): Promise<OutcomeStats> {
  const { rows } = await pool.query<{ surfaced: string; replied: string }>(
    `with surfaced as (
       select distinct bi.ref_key, min(b.sent_at) as first_shown
         from brief_items bi
         join briefs b on b.id = bi.brief_id
        where bi.kind = 'email'
          and b.status = 'sent'
          and b.sent_at > now() - ($1 || ' days')::interval
        group by bi.ref_key
     )
     select count(*)::text as surfaced,
            count(*) filter (
              where t.last_outbound_at is not null
                and t.last_outbound_at >= s.first_shown
            )::text as replied
       from surfaced s
       left join threads t
         on t.account_id = split_part(s.ref_key, ':', 1)::bigint
        and t.gmail_thread_id = split_part(s.ref_key, ':', 2)`,
    [String(OUTCOME_WINDOW_DAYS)],
  );

  return {
    surfaced: Number(rows[0]?.surfaced ?? 0),
    surfacedAndReplied: Number(rows[0]?.replied ?? 0),
    windowDays: OUTCOME_WINDOW_DAYS,
  };
}

/** Threads he answered that no brief ever mentioned. */
export async function missedThreads(limit = 10): Promise<MissedThread[]> {
  const { rows } = await pool.query<{
    thread_key: string;
    subject: string | null;
    from_email: string | null;
    account_email: string;
    replied_at: Date;
  }>(
    `select t.account_id || ':' || t.gmail_thread_id as thread_key,
            t.subject,
            (select m.from_email from messages m
              where m.account_id = t.account_id
                and m.gmail_thread_id = t.gmail_thread_id
                and m.direction = 'inbound'
              order by m.sent_at desc nulls last limit 1) as from_email,
            a.email as account_email,
            t.last_outbound_at as replied_at
       from threads t
       join accounts a on a.id = t.account_id
      where a.status <> 'disabled'
        and t.last_outbound_at > now() - ($1 || ' days')::interval
        and t.last_inbound_at is not null
        -- He replied to something, rather than starting the conversation.
        and t.last_inbound_at < t.last_outbound_at
        and not exists (
          select 1
            from brief_items bi
            join briefs b on b.id = bi.brief_id
           where bi.ref_key = t.account_id || ':' || t.gmail_thread_id
             and b.sent_at > now() - interval '30 days'
        )
        -- Already judged; no point asking twice.
        and not exists (
          select 1 from feedback f
           where f.thread_key = t.account_id || ':' || t.gmail_thread_id
        )
      order by t.last_outbound_at desc
      limit $2`,
    [String(OUTCOME_WINDOW_DAYS), limit],
  );

  return rows.map((r) => ({
    threadKey: r.thread_key,
    subject: r.subject,
    fromEmail: r.from_email,
    accountEmail: r.account_email,
    repliedAt: r.replied_at,
  }));
}
