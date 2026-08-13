import * as W from "./weights.js";

/**
 * Pure scoring. No database, no clock of its own, no knowledge of "today".
 *
 * `now` is injected so the same candidate always produces the same score for a
 * given instant — which is what makes the snapshot tests meaningful and the
 * daily output stable. A future capability that has nothing to do with mornings
 * calls this same function with a different candidate set.
 */

export interface ThreadCandidate {
  accountId: number;
  accountEmail: string;
  gmailThreadId: string;
  subject: string | null;
  snippet: string | null;

  lastInboundAt: Date | null;
  lastOutboundAt: Date | null;
  awaitingReply: boolean;
  messageCount: number;

  /** Sender of the most recent inbound message. */
  fromEmail: string | null;
  fromName: string | null;
  toEmails: string[];
  ccEmails: string[];
  isAutomated: boolean;
  hasListUnsubscribe: boolean;

  /** From the correspondent graph, for this sender on this account. */
  outboundCount: number;
  lastOutboundToSenderAt: Date | null;

  /** From the calendar/email join. */
  meetingSoonAt: Date | null;
  metRecentlyAt: Date | null;
}

export interface Signal {
  name: string;
  points: number;
  detail?: string;
}

export interface ScoredThread {
  candidate: ThreadCandidate;
  score: number;
  signals: Signal[];
  daysWaiting: number;
}

const MS_PER_DAY = 86_400_000;

function daysBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / MS_PER_DAY;
}

function addressedWeight(candidate: ThreadCandidate): Signal | null {
  const me = candidate.accountEmail.toLowerCase();
  if (candidate.toEmails.includes(me)) {
    return { name: "addressed-to", points: W.ADDRESSED_TO, detail: "in To:" };
  }
  if (candidate.ccEmails.includes(me)) {
    return { name: "addressed-cc", points: W.ADDRESSED_CC, detail: "Cc only" };
  }
  return null;
}

/**
 * Whether the sender looks like a machine.
 *
 * Evaluated here rather than trusted from the stored `is_automated` flag, so the
 * rules can be tuned without re-fetching every message in every mailbox. The
 * stored flag still counts — it carries header evidence (Precedence,
 * Auto-Submitted) that the address alone does not show.
 */
export function looksAutomated(fromEmail: string | null): string | null {
  if (!fromEmail) return null;
  const at = fromEmail.lastIndexOf("@");
  if (at < 0) return null;

  const localPart = fromEmail.slice(0, at);
  const domain = fromEmail.slice(at + 1);

  for (const re of W.AUTOMATED_LOCALPARTS) {
    if (re.test(localPart)) return `sender "${localPart}"`;
  }
  for (const re of W.AUTOMATED_DOMAINS) {
    if (re.test(domain)) return `bulk sending domain "${domain}"`;
  }
  return null;
}

function detectAsk(candidate: ThreadCandidate): Signal | null {
  const text = `${candidate.subject ?? ""} ${candidate.snippet ?? ""}`;
  const matched = W.ASK_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.name);
  if (matched.length === 0) return null;
  return {
    name: "explicit-ask",
    points: W.EXPLICIT_ASK,
    detail: matched.join(", "),
  };
}

export function scoreThread(
  candidate: ThreadCandidate,
  now = new Date(),
): ScoredThread {
  const signals: Signal[] = [];

  const daysWaiting = candidate.lastInboundAt
    ? daysBetween(candidate.lastInboundAt, now)
    : 0;

  // Awaiting a reply is the question the brief answers. Everything else only
  // adjusts the ordering among threads that are already waiting.
  if (candidate.awaitingReply) {
    signals.push({ name: "awaiting-reply", points: W.AWAITING_REPLY });

    const aging = W.agingScore(daysWaiting);
    if (aging > 0) {
      signals.push({
        name: "aging",
        points: aging,
        detail: `${daysWaiting.toFixed(1)}d unanswered`,
      });
    }
  }

  const addressed = addressedWeight(candidate);
  if (addressed) signals.push(addressed);

  const relationship = W.correspondentScore(candidate.outboundCount);
  if (relationship > 0) {
    signals.push({
      name: "known-correspondent",
      points: relationship,
      detail: `he has written to them ${candidate.outboundCount}x`,
    });
  } else {
    // Evidence from his own behaviour, and the main thing separating a person
    // waiting on him from infrastructure that merely emails him.
    signals.push({
      name: "never-corresponded",
      points: W.NEVER_CORRESPONDED,
      detail: "he has never written to this address",
    });
  }

  // Guarded on outboundCount: "the relationship is live" is meaningless without
  // a relationship, and awarding it anyway was enough to lift a maximally
  // boosted notification over the floor.
  if (
    candidate.outboundCount > 0 &&
    candidate.lastOutboundToSenderAt &&
    daysBetween(candidate.lastOutboundToSenderAt, now) <= W.CORRESPONDENT_RECENT_DAYS
  ) {
    signals.push({ name: "relationship-live", points: W.CORRESPONDENT_RECENT });
  }

  if (candidate.meetingSoonAt) {
    signals.push({
      name: "meeting-soon",
      points: W.MEETING_SOON,
      detail: `meets ${candidate.meetingSoonAt.toISOString().slice(0, 16)}`,
    });
  }

  if (candidate.metRecentlyAt) {
    signals.push({
      name: "met-recently",
      points: W.MET_RECENTLY,
      detail: "met, nothing sent since",
    });
  }

  const ask = detectAsk(candidate);
  if (ask) signals.push(ask);

  if (candidate.messageCount >= W.CONVERSATION_MIN_MESSAGES) {
    signals.push({
      name: "conversation",
      points: W.CONVERSATION,
      detail: `${candidate.messageCount} messages`,
    });
  }

  // Demotions last, so a reader of the breakdown sees what was earned and then
  // what was taken away.
  const automatedSender = looksAutomated(candidate.fromEmail);
  if (candidate.isAutomated || automatedSender) {
    signals.push({
      name: "automated",
      points: W.AUTOMATED,
      detail: automatedSender ?? "headers indicate machine-sent",
    });
  }
  if (candidate.hasListUnsubscribe) {
    signals.push({ name: "bulk-mail", points: W.LIST_UNSUBSCRIBE });
  }

  const score = signals.reduce((total, s) => total + s.points, 0);
  return { candidate, score, signals, daysWaiting };
}

/**
 * Deterministic ordering.
 *
 * Ties break on fixed, data-derived keys — never on iteration or arrival order.
 * Two runs over unchanged data must produce byte-identical output, or the brief
 * appears to reshuffle itself overnight for no reason.
 */
export function rankThreads(scored: ScoredThread[]): ScoredThread[] {
  return [...scored].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;

    const aTime = a.candidate.lastInboundAt?.getTime() ?? 0;
    const bTime = b.candidate.lastInboundAt?.getTime() ?? 0;
    if (bTime !== aTime) return bTime - aTime;

    return a.candidate.gmailThreadId.localeCompare(b.candidate.gmailThreadId);
  });
}
