import type { Signal } from "./score.js";
import * as W from "./weights.js";

/**
 * Learned rules, applied at scoring time.
 *
 * Kept separate from `score.ts` and passed in rather than fetched, so the
 * scorer stays a pure function of its inputs. A rule set is loaded once per run
 * and reused across every candidate; tests construct one by hand.
 *
 * **The invariant: a rule adjusts a score, it never makes a decision.** There is
 * deliberately no way to express "never show this". A hard exclusion cannot be
 * overridden by evidence, and the day a muted sender finally says something that
 * matters, the brief would stay silent and stop being trusted.
 */

export interface SenderRule {
  id: number;
  /** Lowercase address, or a domain with a leading "@". */
  pattern: string;
  scope: "address" | "domain";
  /** Null applies to every mailbox. */
  accountId: number | null;
  /** Points at full confidence. Positive promotes, negative demotes. */
  adjustment: number;
  /** How many verdicts back this rule. */
  confidence: number;
  reason: string | null;
}

export interface ThreadRule {
  id: number;
  threadKey: string;
  verdict: "pin" | "mute";
  expiresAt: Date | null;
  reason: string | null;
}

export interface RuleSet {
  senders: SenderRule[];
  /** Keyed by "<accountId>:<gmailThreadId>". */
  threads: Map<string, ThreadRule>;
}

export const EMPTY_RULES: RuleSet = { senders: [], threads: new Map() };

/**
 * How much of a rule's adjustment actually applies, by how much evidence backs it.
 *
 * A single irritated morning must not blacklist a real correspondent, and a
 * young rule must stay weak enough that other signals can still overrule it —
 * which is exactly what keeps the "but one day it *will* matter" case reachable.
 * Rules earn their strength.
 */
export function confidenceScale(votes: number): number {
  if (!Number.isFinite(votes) || votes <= 1) return 0.25;
  if (votes === 2) return 0.45;
  if (votes <= 4) return 0.65;
  if (votes <= 7) return 0.85;
  return 1;
}

export function effectivePoints(rule: SenderRule): number {
  return Math.round(rule.adjustment * confidenceScale(rule.confidence));
}

function domainOf(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}

/**
 * The one sender rule that applies, most specific first.
 *
 * Address beats domain, and an account-scoped rule beats a global one. Only one
 * ever applies: stacking an address rule on top of its own domain rule would
 * double-count the same judgement.
 */
export function matchSenderRule(
  fromEmail: string | null,
  accountId: number,
  rules: readonly SenderRule[],
): SenderRule | null {
  if (!fromEmail) return null;
  const address = fromEmail.toLowerCase();
  const domain = `@${domainOf(address)}`;

  const applicable = rules.filter(
    (r) =>
      (r.accountId === null || r.accountId === accountId) &&
      (r.scope === "address" ? r.pattern === address : r.pattern === domain),
  );
  if (applicable.length === 0) return null;

  // Sort by specificity so the winner is deterministic when several match.
  return [...applicable].sort((a, b) => {
    const score = (r: SenderRule) =>
      (r.scope === "address" ? 2 : 0) + (r.accountId !== null ? 1 : 0);
    const diff = score(b) - score(a);
    return diff !== 0 ? diff : a.id - b.id;
  })[0] ?? null;
}

export function threadKeyOf(accountId: number, gmailThreadId: string): string {
  return `${accountId}:${gmailThreadId}`;
}

export function matchThreadRule(
  threadKey: string,
  rules: RuleSet,
  now: Date,
): ThreadRule | null {
  const rule = rules.threads.get(threadKey);
  if (!rule) return null;
  // An expired mute is not a mute. A thread that comes back to life months
  // after he handled it on a call is genuinely new information.
  if (rule.expiresAt && rule.expiresAt <= now) return null;
  return rule;
}

/** Signals contributed by learned rules, appended after the built-in ones. */
export function ruleSignals(
  fromEmail: string | null,
  accountId: number,
  gmailThreadId: string,
  rules: RuleSet,
  now: Date,
): { signals: Signal[]; firedSenderRuleIds: number[] } {
  const signals: Signal[] = [];
  const fired: number[] = [];

  const sender = matchSenderRule(fromEmail, accountId, rules.senders);
  if (sender) {
    const points = effectivePoints(sender);
    if (points !== 0) {
      signals.push({
        name: sender.adjustment >= 0 ? "sender-promoted" : "sender-demoted",
        points,
        detail: `${sender.pattern}${
          sender.reason ? `, ${sender.reason}` : ""
        } (${sender.confidence} vote${sender.confidence === 1 ? "" : "s"})`,
      });
      fired.push(sender.id);
    }
  }

  const thread = matchThreadRule(threadKeyOf(accountId, gmailThreadId), rules, now);
  if (thread) {
    signals.push({
      name: thread.verdict === "pin" ? "thread-pinned" : "thread-muted",
      points: thread.verdict === "pin" ? W.THREAD_PIN : W.THREAD_MUTE,
      detail: thread.reason ?? (thread.verdict === "pin" ? "kept until closed" : "handled elsewhere"),
    });
  }

  return { signals, firedSenderRuleIds: fired };
}
