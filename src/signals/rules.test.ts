import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  confidenceScale,
  effectivePoints,
  matchSenderRule,
  type RuleSet,
  type SenderRule,
} from "./rules.js";
import { scoreThread, type ThreadCandidate } from "./score.js";
import * as W from "./weights.js";

/**
 * The governing invariant: **a rule adjusts a score, it never makes a decision.**
 *
 * A hard exclusion cannot be overridden by evidence, so the day a demoted sender
 * finally says something that matters the brief would stay silent. Everything
 * here exists to prove that no learned rule can become a filter.
 */

const NOW = new Date("2026-08-14T10:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

function candidate(over: Partial<ThreadCandidate> = {}): ThreadCandidate {
  return {
    accountId: 1,
    accountEmail: "sam@servicecallsaver.com",
    gmailThreadId: "t-1",
    subject: "Subject",
    snippet: "Body",
    lastInboundAt: daysAgo(3),
    lastOutboundAt: null,
    awaitingReply: true,
    messageCount: 1,
    fromEmail: "vendor@acme.com",
    fromName: "Vendor",
    toEmails: ["sam@servicecallsaver.com"],
    ccEmails: [],
    isAutomated: false,
    hasListUnsubscribe: false,
    isUnread: true,
    isArchived: false,
    isImportant: true,
    reportedMornings: 0,
    outboundCount: 5,
    lastOutboundToSenderAt: daysAgo(2),
    meetingSoonAt: null,
    metRecentlyAt: null,
    ...over,
  };
}

function rule(over: Partial<SenderRule> = {}): SenderRule {
  return {
    id: 1,
    pattern: "vendor@acme.com",
    scope: "address",
    accountId: null,
    adjustment: -30,
    confidence: 1,
    reason: null,
    ...over,
  };
}

const ruleSet = (senders: SenderRule[]): RuleSet => ({
  senders,
  threads: new Map(),
});

describe("rules earn their strength", () => {
  it("applies only a quarter of a rule backed by one verdict", () => {
    assert.equal(confidenceScale(1), 0.25);
    assert.equal(effectivePoints(rule({ adjustment: -40, confidence: 1 })), -10);
  });

  it("reaches full strength only after sustained agreement", () => {
    assert.equal(confidenceScale(8), 1);
    assert.equal(effectivePoints(rule({ adjustment: -40, confidence: 8 })), -40);
  });

  it("never weakens as evidence accumulates", () => {
    for (let votes = 1; votes < 12; votes++) {
      assert.ok(
        confidenceScale(votes + 1) >= confidenceScale(votes),
        `scale dropped between ${votes} and ${votes + 1}`,
      );
    }
  });
});

describe("no rule can become a filter", () => {
  it("lets an urgent thread outrank a fully-confident demotion", () => {
    // The case the whole design exists for: he muted this sender months ago,
    // and today they finally send something that genuinely needs him.
    const urgent = candidate({
      lastInboundAt: daysAgo(4),
      subject: "Can you confirm by EOD?",
      snippet: "We need your sign-off today, can you confirm?",
      messageCount: 6,
      outboundCount: 12,
      meetingSoonAt: new Date(NOW.getTime() + 3_600_000),
      metRecentlyAt: daysAgo(1),
    });

    const scored = scoreThread(
      urgent,
      NOW,
      ruleSet([rule({ adjustment: -W.SENDER_RULE_MAX, confidence: 20 })]),
    );

    assert.ok(
      scored.score >= W.MIN_SCORE_FOR_BRIEF,
      `a maximally demoted sender was silenced entirely (scored ${scored.score})`,
    );
  });

  it("still demotes an ordinary thread from that sender below the floor", () => {
    // The other half: the rule has to actually work on the common case, or it
    // is just decoration.
    const ordinary = candidate({ outboundCount: 0, lastOutboundToSenderAt: null });
    const before = scoreThread(ordinary, NOW).score;
    const after = scoreThread(
      ordinary,
      NOW,
      ruleSet([rule({ adjustment: -W.SENDER_RULE_MAX, confidence: 20 })]),
    ).score;

    assert.ok(after < before, "the rule did nothing");
    assert.ok(after < W.MIN_SCORE_FOR_BRIEF, `still surfaced at ${after}`);
  });

  it("reports which rules fired so a real send can count them", () => {
    const scored = scoreThread(candidate(), NOW, ruleSet([rule({ id: 7 })]));
    assert.deepEqual(scored.firedSenderRuleIds, [7]);
  });

  it("attributes nothing when no rule matches", () => {
    const scored = scoreThread(candidate({ fromEmail: "someone@else.com" }), NOW, ruleSet([rule()]));
    assert.deepEqual(scored.firedSenderRuleIds, []);
  });
});

describe("matching is specific and deterministic", () => {
  it("prefers an address rule over a domain rule for the same sender", () => {
    const matched = matchSenderRule("vendor@acme.com", 1, [
      rule({ id: 1, pattern: "@acme.com", scope: "domain" }),
      rule({ id: 2, pattern: "vendor@acme.com", scope: "address" }),
    ]);
    assert.equal(matched?.id, 2, "domain rule beat the more specific address rule");
  });

  it("prefers an account-scoped rule over a global one", () => {
    const matched = matchSenderRule("vendor@acme.com", 3, [
      rule({ id: 1, accountId: null }),
      rule({ id: 2, accountId: 3 }),
    ]);
    assert.equal(matched?.id, 2);
  });

  it("ignores a rule scoped to a different account", () => {
    assert.equal(matchSenderRule("vendor@acme.com", 9, [rule({ accountId: 3 })]), null);
  });

  it("applies a domain rule to any address at that domain", () => {
    const rules = [rule({ pattern: "@acme.com", scope: "domain" })];
    assert.ok(matchSenderRule("anyone@acme.com", 1, rules));
    assert.equal(matchSenderRule("anyone@acme.com.evil.com", 1, rules), null);
  });

  it("is case-insensitive about the address", () => {
    assert.ok(matchSenderRule("Vendor@ACME.com", 1, [rule()]));
  });
});

describe("thread rules", () => {
  const muted = (expiresAt: Date | null): RuleSet => ({
    senders: [],
    threads: new Map([
      ["1:t-1", { id: 1, threadKey: "1:t-1", verdict: "mute" as const, expiresAt, reason: null }],
    ]),
  });

  it("demotes a thread he handled outside email", () => {
    const before = scoreThread(candidate(), NOW).score;
    const after = scoreThread(candidate(), NOW, muted(null)).score;
    assert.equal(after, before + W.THREAD_MUTE);
  });

  it("stops applying once the mute expires", () => {
    // A thread that comes back to life months later is genuinely new
    // information, not something he already dealt with.
    const expired = muted(new Date(NOW.getTime() - 1000));
    assert.equal(scoreThread(candidate(), NOW, expired).score, scoreThread(candidate(), NOW).score);
  });

  it("pins a thread that must not age out", () => {
    const pinned: RuleSet = {
      senders: [],
      threads: new Map([
        ["1:t-1", { id: 1, threadKey: "1:t-1", verdict: "pin" as const, expiresAt: null, reason: null }],
      ]),
    };
    assert.equal(
      scoreThread(candidate(), NOW, pinned).score,
      scoreThread(candidate(), NOW).score + W.THREAD_PIN,
    );
  });

  it("only matches its own thread", () => {
    const other = candidate({ gmailThreadId: "t-2" });
    assert.equal(scoreThread(other, NOW, muted(null)).score, scoreThread(other, NOW).score);
  });
});

describe("scoring stays pure", () => {
  it("produces the same result for the same inputs regardless of rules object identity", () => {
    const a = scoreThread(candidate(), NOW, ruleSet([rule()]));
    const b = scoreThread(candidate(), NOW, ruleSet([rule()]));
    assert.equal(a.score, b.score);
  });

  it("defaults to no rules when none are passed", () => {
    assert.equal(scoreThread(candidate(), NOW).firedSenderRuleIds.length, 0);
  });
});
