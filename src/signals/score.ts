import type { Deadline } from "./deadlines.js";
import { EMPTY_RULES, ruleSignals, type RuleSet } from "./rules.js";
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
  /** Gmail still marks the newest inbound message unread. */
  isUnread: boolean;

  /** From the correspondent graph, for this sender on this account. */
  outboundCount: number;
  lastOutboundToSenderAt: Date | null;

  /** From the calendar/email join. */
  meetingSoonAt: Date | null;
  metRecentlyAt: Date | null;

  /**
   * A date the message named, already resolved against a timezone. Resolved
   * upstream so this module stays free of zone handling and stays pure.
   */
  deadline?: Deadline | null;
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
  /** `sender_rules` that contributed, so a real send can bump their fire count. */
  firedSenderRuleIds: number[];
}

const MS_PER_DAY = 86_400_000;

function daysBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / MS_PER_DAY;
}

function addressedWeight(candidate: ThreadCandidate): Signal | null {
  const me = candidate.accountEmail.toLowerCase();
  if (candidate.toEmails.includes(me)) {
    return { name: "addressed-to", points: W.ADDRESSED_TO, detail: "addressed to you" };
  }
  if (candidate.ccEmails.includes(me)) {
    return { name: "addressed-cc", points: W.ADDRESSED_CC, detail: "you were only Cc'd" };
  }
  return null;
}

/** A platform relaying an in-app message, where the real thread lives elsewhere. */
export function notificationRelay(fromEmail: string | null): string | null {
  if (!fromEmail) return null;
  const domain = fromEmail.slice(fromEmail.lastIndexOf("@") + 1);
  return W.NOTIFICATION_RELAY_DOMAINS.some((re) => re.test(domain)) ? domain : null;
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
    if (re.test(localPart)) return `sender name "${localPart}" looks automated`;
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
  rules: RuleSet = EMPTY_RULES,
): ScoredThread {
  const signals: Signal[] = [];

  const daysWaiting = candidate.lastInboundAt
    ? daysBetween(candidate.lastInboundAt, now)
    : 0;

  // Computed before the awaiting-reply block because the read penalty depends on
  // it: "he opened it and nobody asked him anything" is a very different claim
  // from "he opened a direct question and has not answered".
  const ask = detectAsk(candidate);

  // Awaiting a reply is the question the brief answers. Everything else only
  // adjusts the ordering among threads that are already waiting.
  if (candidate.awaitingReply) {
    signals.push({ name: "awaiting-reply", points: W.AWAITING_REPLY });

    // He has already seen it. Only meaningful while the thread is otherwise
    // waiting: an unread message he never opened is the ordinary case and earns
    // nothing here either way.
    const seenAndUnasked = !candidate.isUnread && ask === null;
    if (!candidate.isUnread) {
      signals.push(
        ask
          ? {
              name: "already-read",
              points: W.READ_WITH_ASK,
              detail: "you have read it, but it does ask something",
            }
          : {
              name: "already-read",
              points: W.READ_NO_ASK,
              detail: "you have read it and nothing was asked",
            },
      );
    }

    // Age is pressure only while something is actually waiting. He opened it,
    // nobody asked him anything, and he moved on: the days since are not
    // evidence of neglect, they are just days. Letting the curve run anyway was
    // what kept a shared article climbing for eight days after he had read it,
    // and no flat penalty fixes that because the curve outgrows any constant.
    const aging = seenAndUnasked ? 0 : W.agingScore(daysWaiting);
    if (aging > 0) {
      signals.push({
        name: "aging",
        points: aging,
        detail: `unanswered ${Math.round(daysWaiting)} day${Math.round(daysWaiting) === 1 ? "" : "s"}`,
      });
    }
  }

  const addressed = addressedWeight(candidate);
  if (addressed) signals.push(addressed);

  // Resolved once: a relay address changes every conversation, so the graph
  // cannot say anything about it and is skipped in both directions.
  const relay = notificationRelay(candidate.fromEmail);
  const automatedSender = relay ? null : looksAutomated(candidate.fromEmail);
  const machine = Boolean(relay) || candidate.isAutomated || Boolean(automatedSender);

  const relationship = relay ? 0 : W.correspondentScore(candidate.outboundCount);
  if (relay) {
    // no relationship signal either way
  } else if (relationship > 0) {
    signals.push({
      name: "known-correspondent",
      points: relationship,
      detail: `you have written to them ${candidate.outboundCount} times`,
    });
  } else {
    // Evidence from his own behaviour, and the main thing separating a person
    // waiting on him from infrastructure that merely emails him.
    signals.push({
      name: "never-corresponded",
      points: W.NEVER_CORRESPONDED,
      detail: "you have never written to this address",
    });
  }

  // Guarded on outboundCount: "the relationship is live" is meaningless without
  // a relationship, and awarding it anyway was enough to lift a maximally
  // boosted notification over the floor.
  if (
    !relay &&
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
      // No timestamp. It was an ISO string, which is unreadable in a sentence,
      // and formatting one here would drag a timezone into a module that is
      // deliberately free of them.
      detail: "you are meeting them soon",
    });
  }

  if (candidate.metRecentlyAt) {
    signals.push({
      name: "met-recently",
      points: W.MET_RECENTLY,
      detail: "you met recently and nothing was sent after",
    });
  }

  // A named date that has arrived. This is the main thing that makes the
  // section broader than "unanswered email" — nobody has to reply for a
  // commitment to need him today.
  //
  // Suppressed for machines, and that is the whole difference between this
  // working and not. Marketing copy is built out of "today", "last chance" and
  // "next Thursday"; against live data every single false positive here was a
  // newsletter. Relying on the automated penalty to cancel the boost afterwards
  // would leave it correct only by arithmetic accident.
  if (candidate.deadline && !machine) {
    const { state, phrase, date } = candidate.deadline;
    const points =
      state === "today"
        ? W.DEADLINE_TODAY
        : state === "overdue"
          ? W.DEADLINE_OVERDUE
          : state === "tomorrow"
            ? W.DEADLINE_TOMORROW
            : 0;
    if (points > 0) {
      signals.push({
        name: `deadline-${state}`,
        points,
        detail: `"${phrase}" resolves to ${date}`,
      });
    }
  }

  // Detected once, above, because the read penalty branches on it.
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
  // Exclusive with `automated`: most relays also match a machine-sender pattern,
  // and stacking both would read as an arbitrary -100 in the scoring view.
  if (relay) {
    signals.push({
      name: "notification-relay",
      points: W.NOTIFICATION_RELAY,
      detail: `${relay}, the conversation lives in that app`,
    });
  } else {
    if (candidate.isAutomated || automatedSender) {
      signals.push({
        name: "automated",
        points: W.AUTOMATED,
        detail: automatedSender ?? "machine sent",
      });
    }
  }
  if (candidate.hasListUnsubscribe) {
    signals.push({ name: "bulk-mail", points: W.LIST_UNSUBSCRIBE });
  }

  // Learned rules last, so the breakdown reads as "here is what the system
  // worked out, and here is what he told it". They are ordinary signed points
  // like everything above — never a veto.
  const learned = ruleSignals(
    candidate.fromEmail,
    candidate.accountId,
    candidate.gmailThreadId,
    rules,
    now,
  );
  signals.push(...learned.signals);

  const score = signals.reduce((total, s) => total + s.points, 0);
  return {
    candidate,
    score,
    signals,
    daysWaiting,
    firedSenderRuleIds: learned.firedSenderRuleIds,
  };
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
