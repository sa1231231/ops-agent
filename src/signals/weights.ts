/**
 * Every number that decides what reaches the brief lives in this file.
 *
 * They are fixed, not learned and not tuned per-run. A brief that ranks
 * differently every morning is one he stops trusting, so the scoring must be
 * reproducible: same data in, same order out, forever.
 *
 * The scale is arbitrary points. What matters is the ratios — specifically that
 * the automated penalty is large enough that no amount of age or directness can
 * lift a newsletter above a real person waiting on a reply.
 */

// --- The dominant signal ----------------------------------------------------

/**
 * The last message in the thread is inbound with no outbound after it.
 *
 * This is the whole question the brief answers: what is waiting on him. A thread
 * he already replied to is finished business regardless of how important the
 * sender is.
 */
export const AWAITING_REPLY = 30;

// --- Age: importance, not recency -------------------------------------------

/**
 * Aging curve, peaking at 2–7 days.
 *
 * Deliberately NOT monotonic in recency. Something that arrived an hour ago has
 * not been ignored yet — it may not even be his turn. Something unanswered for
 * five days is a problem that is actively getting worse. Past two weeks it is
 * usually dead rather than urgent, so the curve falls back down.
 *
 * This is what lets a six-day-old unanswered email outrank this morning's noise,
 * which is the explicit requirement.
 */
export function agingScore(daysWaiting: number): number {
  if (!Number.isFinite(daysWaiting) || daysWaiting < 0) return 0;
  if (daysWaiting < 1) return 6; // arrived today; not yet ignored
  if (daysWaiting < 2) return 14;
  if (daysWaiting <= 7) return 25; // peak — long enough to be a real problem
  if (daysWaiting <= 14) return 25 - (daysWaiting - 7) * 1.8; // 25 → ~12.4
  if (daysWaiting <= 30) return 10;
  return 5; // stale: probably dead, not urgent
}

// --- Addressing -------------------------------------------------------------

/** He is in To: — the sender wants something from him specifically. */
export const ADDRESSED_TO = 12;
/** Cc only — informational far more often than actionable. */
export const ADDRESSED_CC = 4;

// --- The correspondent graph ------------------------------------------------

/**
 * Relationship strength, from who *he* emails.
 *
 * Outbound is the signal that matters. Anyone can email you; who you write back
 * to, and how often, is what identifies a real relationship. This is the single
 * cheapest way to separate a client from a SaaS notification, and it needs no
 * heuristics about sender addresses at all.
 */
export function correspondentScore(outboundCount: number): number {
  if (outboundCount >= 10) return 22;
  if (outboundCount >= 3) return 16;
  if (outboundCount >= 1) return 8;
  return 0; // never written to them — could be anyone
}

/** Recently in touch, so the relationship is live rather than historical. */
export const CORRESPONDENT_RECENT = 6;
export const CORRESPONDENT_RECENT_DAYS = 14;

/**
 * He has never written to this address.
 *
 * Every unanswered inbound earns AWAITING_REPLY + aging for free, which on real
 * data floated every build-failure alert and SaaS notification to the top. The
 * correction is this penalty rather than more sender regexes: "he has never
 * replied to this address" is evidence from his own behaviour, and it degrades
 * gracefully where pattern-matching fails.
 *
 * Cost, accepted deliberately: a genuine first-time email from a new client is
 * penalized too. It still clears the floor when it is addressed to him and asks
 * something — 30 + aging + 12 + 10 − 22 — which is the intended behaviour.
 */
export const NEVER_CORRESPONDED = -22;

// --- The calendar/email join ------------------------------------------------

/**
 * The sender is in a meeting with him soon. Their email is very likely about it,
 * and it becomes worthless the moment the meeting starts.
 */
export const MEETING_SOON = 15;
export const MEETING_SOON_HOURS = 48;

/**
 * They met recently and he has not written since. This is the "lots of meetings
 * the days prior" half of the problem — the follow-up he owes and forgot.
 */
export const MET_RECENTLY = 10;
export const MET_RECENTLY_DAYS = 2;

// --- Explicit asks ----------------------------------------------------------

/** Someone asked him a direct question or named a deadline. */
export const EXPLICIT_ASK = 10;

/**
 * Matched against subject + snippet. Deliberately conservative — a false
 * positive here promotes noise, and the other signals already do most of the
 * work. Each pattern is named so the reason is explainable rather than a
 * mystery number.
 */
export const ASK_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "question", re: /\?/ },
  { name: "request", re: /\b(can|could|would|will)\s+you\b/i },
  { name: "asked-to-review", re: /\b(review|approve|sign[- ]?off|confirm|feedback)\b/i },
  { name: "deadline", re: /\b(deadline|due|by\s+(eod|eow|tomorrow|monday|friday)|asap|urgent)\b/i },
  { name: "chasing", re: /\b(following up|circling back|checking in|any update|bump|reminder)\b/i },
  { name: "needs-decision", re: /\b(let me know|thoughts|your call|decide|decision)\b/i },
];

// --- Demotions --------------------------------------------------------------

/**
 * Machine-sent mail. Large enough that nothing rescues it: a maximally-aged,
 * directly-addressed automated message still lands below an ordinary human
 * thread. Build failures and receipts are technically "awaiting reply" forever,
 * and without this the brief becomes a list of them.
 */
/**
 * He has already opened it.
 *
 * Read is not the same as handled, and this deliberately does not filter. The
 * whole premise of the brief is that a six day old unanswered email outranks
 * this morning's noise, and a six day old email is one he has certainly read.
 * Treating "read" as "done" would delete exactly what this was built to surface.
 *
 * What read actually tells us is that the brief is not breaking news to him. So
 * it matters enormously in one case and barely at all in the other:
 *
 * READ_NO_ASK is large enough to cancel AWAITING_REPLY outright. He opened it,
 * nobody asked him anything, and he moved on. That is a decision, not an
 * oversight, and reporting it back to him every morning is the system arguing
 * with him. This is the case of someone who shares links.
 *
 * READ_WITH_ASK is deliberately small. He read a question and has not answered
 * it. Seeing it and owing it are not in tension; if anything that is the more
 * pointed omission, so the demotion here is little more than an acknowledgement
 * that he is aware of it.
 */
/**
 * Out of the inbox.
 *
 * Stronger evidence than read, and the reason is that it works for both habits.
 * Six of the last ten archives here happened *without* the message ever being
 * opened, which is somebody clearing a list view rather than reading. Whether he
 * read it or swiped it away, an archived message is one he has decided about,
 * and that decision does not depend on how he treats unread mail.
 *
 * Applies even when something was asked. Reading a question and archiving it are
 * different acts: the first is noticing, the second is answering the question of
 * whether he intends to do anything.
 */
export const ARCHIVED = -45;

/**
 * Gmail's own opinion, which is trained on years of his behaviour and free.
 *
 * Only the absence is scored. 58 of 81 inbound messages carry IMPORTANT, so its
 * presence is close to the baseline and says almost nothing, while its absence
 * is Gmail actively declining to flag something. Small either way: this is a
 * tiebreaker, not a verdict, and it is the one signal here we did not compute
 * and cannot explain to him.
 */
export const NOT_GMAIL_IMPORTANT = -8;

/**
 * The brief has said this on N mornings and he has done nothing about it.
 *
 * Every other demotion reads the mailbox. This one reads his response to the
 * brief itself, which is why it is the only signal that works no matter how he
 * treats his inbox, and the only one that cannot be defeated by habit.
 *
 * Today repetition makes an item *more* prominent: carry-over holds its
 * position while the age curve keeps adding points, so the longer he ignores
 * something the harder the brief insists. Ten mornings on one thread, no
 * verdict. That is the system arguing with him, and it is unfalsifiable.
 *
 * Starts on the fourth morning, because three is a coincidence and four is a
 * pattern, and grows so an item leaves rather than lingering just under the
 * line. Capped so it stays a demotion and never becomes a hard filter: he can
 * still be wrong, and "Not right" is the honest way to say so.
 */
export const FATIGUE_AFTER_MORNINGS = 4;
export const FATIGUE_PER_MORNING = -9;
export const FATIGUE_MAX = -45;

export const READ_NO_ASK = -34;
export const READ_WITH_ASK = -6;

export const AUTOMATED = -40;

/** Bulk mail on top of automated — a mailing list, not a notification. */
export const LIST_UNSUBSCRIBE = -12;

/**
 * Sender patterns that identify machine-sent mail.
 *
 * Deliberately matched as substrings rather than anchored to the start of the
 * localpart: the first version anchored them and so missed `voice-noreply@`,
 * `bounces+123@`, and every other real-world variant. Verified against live
 * data rather than imagined.
 *
 * This lives in the scoring layer, not the fetch layer. `sources/` records what
 * the headers said; deciding what that *means* is a judgement, and judgements
 * must be tunable without re-fetching every message in every mailbox.
 */
export const AUTOMATED_LOCALPARTS: readonly RegExp[] = [
  /no-?reply/i,
  /do-?not-?reply/i,
  /notification|notify/i,
  /^(mailer|postmaster|bounces?|daemon)\b/i,
  /^(alerts?|billing|receipts?|invoices?|updates?|news(letter)?)$/i,
  /^(support|help|info|hello|hi|team|contact|admin|service)$/i,
];

/**
 * Platform notification relays: "you have a message" emails from apps where the
 * actual conversation lives somewhere else.
 *
 * These are not email. Google Voice, Slack, Discord, LinkedIn and the rest all
 * forward a copy of an in-app message, and the real thread is in that app — he
 * has already been notified there, usually on the same phone the brief arrives
 * on. Surfacing them is both redundant and, left unchecked, floods the brief:
 * one chatty Slack workspace can generate more "unanswered" threads in a day
 * than a month of real correspondence.
 *
 * Google Voice is the case that exposed this, and it is instructive. Its
 * addresses look like `15715778596.18888987905.341xqhvnh5@txt.voice.google.com`
 * — the localpart is digits, so no machine-sender pattern matches. Worse,
 * replying to a text from the inbox creates outbound history, which grants
 * `known-correspondent` and, critically, exempts the address from
 * NEVER_CORRESPONDED. And because the thread id is random, every conversation
 * gets a fresh address, so the count is stuck at one forever: never high enough
 * to mean anything, always high enough to dodge the penalty.
 *
 * Demoted rather than dropped at fetch, so the signal survives if one of these
 * ever turns out to be worth surfacing.
 *
 * Two consequences follow, both applied in score.ts. The correspondent graph is
 * skipped entirely for a relay — neither the bonus nor NEVER_CORRESPONDED, since
 * an address that changes every conversation measures nothing in either
 * direction. And the penalty is sized to dominate rather than merely offset: a
 * relay carrying every remaining positive signal must still land below the
 * floor, or a single detected question would surface it.
 */
export const NOTIFICATION_RELAY = -60;

export const NOTIFICATION_RELAY_DOMAINS: readonly RegExp[] = [
  /(^|\.)txt\.voice\.google\.com$/i,
  /(^|\.)slack\.com$/i,
  /(^|\.)discord(app)?\.com$/i,
  /(^|\.)linkedin\.com$/i,
  /(^|\.)facebookmail\.com$/i,
  /(^|\.)instagram\.com$/i,
  /(^|\.)(x|twitter)\.com$/i,
  /(^|\.)redditmail\.com$/i,
  /(^|\.)teams\.microsoft\.com$/i,
  /(^|\.)zoom\.us$/i,
  /(^|\.)intercom(mail)?\.io$/i,
  /(^|\.)whatsapp\.com$/i,
];

/**
 * Sending domains belonging to bulk-mail infrastructure. `em1.cloudflare.com`
 * and friends are ESP subdomains — a human's reply address never looks like it.
 */
export const AUTOMATED_DOMAINS: readonly RegExp[] = [
  /^(em|mail|mailer|notify|notifications|send|smtp|mg|bounce)[0-9]*\./i,
  /\.(sendgrid|mailgun|sparkpostmail|mandrillapp|amazonses|postmarkapp)\.(net|com|org)$/i,
];

/** A back-and-forth is more likely to be real work than a single blast. */
export const CONVERSATION = 5;
export const CONVERSATION_MIN_MESSAGES = 3;

// --- Selection --------------------------------------------------------------

/** Below this, an item is not worth a line in the brief regardless of rank. */
/**
 * Learned thread verdicts (`thread_rules`).
 *
 * A mute is large but still finite, and deliberately so: "I handled this on a
 * call" is the most common false positive in a system built on awaiting_reply,
 * but a thread that comes roaring back deserves to be heard. Mutes also expire.
 */
/**
 * A date the message actually named, resolved and now imminent.
 *
 * Separate from the `deadline` ask-pattern, which only matches the words. "By
 * Friday" scores the same whether Friday is tomorrow or was three weeks ago;
 * these fire on the day it lands. Overdue outranks tomorrow deliberately — a
 * date he has already blown needs him more than one he still has time for.
 */
export const DEADLINE_TODAY = 24;
export const DEADLINE_OVERDUE = 20;
export const DEADLINE_TOMORROW = 12;

export const THREAD_PIN = 45;
export const THREAD_MUTE = -50;

/** Ceiling on a single learned sender rule, so no rule becomes a hard filter. */
export const SENDER_RULE_MAX = 40;

export const MIN_SCORE_FOR_BRIEF = 25;

/** How many survivors reach the model. Cheap, and keeps the prompt stable. */
export const MAX_CANDIDATES = 50;

/** Threads whose last inbound is older than this are not today's problem. */
export const CANDIDATE_MAX_AGE_DAYS = 45;
