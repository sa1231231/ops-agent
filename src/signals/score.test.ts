import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  looksAutomated,
  notificationRelay,
  rankThreads,
  scoreThread,
  type ThreadCandidate,
} from "./score.js";
import * as W from "./weights.js";

/**
 * These fixtures, not the live mailboxes, are the contract for ranking.
 *
 * Real data is useful for finding blind spots but is a bad regression test: it
 * changes hourly, and the three connected accounts happen to contain almost no
 * human correspondence. Tuning weights against that sample would overfit to it.
 */

const NOW = new Date("2026-08-13T10:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

function candidate(overrides: Partial<ThreadCandidate> = {}): ThreadCandidate {
  return {
    accountId: 1,
    accountEmail: "sam@servicecallsaver.com",
    gmailThreadId: "t-default",
    subject: "Subject",
    snippet: "Body text",
    lastInboundAt: daysAgo(1),
    lastOutboundAt: null,
    awaitingReply: true,
    messageCount: 1,
    fromEmail: "person@example.com",
    fromName: "A Person",
    toEmails: ["sam@servicecallsaver.com"],
    ccEmails: [],
    isAutomated: false,
    hasListUnsubscribe: false,
    isUnread: true,
    isArchived: false,
    isImportant: true,
    reportedMornings: 0,
    outboundCount: 3,
    lastOutboundToSenderAt: daysAgo(5),
    meetingSoonAt: null,
    metRecentlyAt: null,
    ...overrides,
  };
}

const score = (o: Partial<ThreadCandidate> = {}) => scoreThread(candidate(o), NOW).score;

describe("the core requirement: importance is not recency", () => {
  it("a six-day-old unanswered human email outranks this morning's newsletter", () => {
    const aging = score({
      gmailThreadId: "t-human",
      lastInboundAt: daysAgo(6),
      subject: "Re: contract redline — can you confirm?",
    });

    const fresh = score({
      gmailThreadId: "t-news",
      lastInboundAt: new Date(NOW.getTime() - 3_600_000),
      fromEmail: "newsletter@em1.vendor.com",
      outboundCount: 0,
      hasListUnsubscribe: true,
      subject: "Last chance: 20% off",
    });

    assert.ok(aging > fresh, `expected ${aging} > ${fresh}`);
  });

  it("peaks between two and seven days rather than decaying from now", () => {
    assert.ok(W.agingScore(4) > W.agingScore(0.2), "4d should beat 5 hours");
    assert.ok(W.agingScore(4) > W.agingScore(25), "4d should beat 25d");
    assert.equal(W.agingScore(3), W.agingScore(7), "plateau across the peak");
  });
});

describe("automated mail cannot reach the brief", () => {
  it("stays below the floor even when maximally boosted otherwise", () => {
    const best = score({
      fromEmail: "no-reply@vendor.com",
      lastInboundAt: daysAgo(5),
      toEmails: ["sam@servicecallsaver.com"],
      subject: "[ACTION REQUIRED] can you confirm by EOD?",
      messageCount: 5,
      outboundCount: 0,
    });
    assert.ok(best < W.MIN_SCORE_FOR_BRIEF, `automated scored ${best}`);
  });

  it("recognises machine senders the anchored regex used to miss", () => {
    for (const address of [
      "voice-noreply@google.com",
      "hello@notify.railway.app",
      "bounces+7@list.example.com",
      "em@em1.cloudflare.com",
      "support@hetzner.com",
      "notifications@servicecallsaver.com",
    ]) {
      assert.ok(looksAutomated(address), `should flag ${address}`);
    }
  });

  it("does not flag ordinary human addresses", () => {
    for (const address of [
      "eric@kalman.com",
      "dzvoicestudio@gmail.com",
      "sarah.chen@acme.co.uk",
    ]) {
      assert.equal(looksAutomated(address), null, `should not flag ${address}`);
    }
  });
});

describe("the correspondent graph carries the ranking", () => {
  it("someone he writes to outranks an identical stranger", () => {
    const known = score({ outboundCount: 12 });
    const stranger = score({ outboundCount: 0, lastOutboundToSenderAt: null });
    assert.ok(known > stranger, `${known} should beat ${stranger}`);
  });

  it("still lets a first-time human with a direct ask clear the floor", () => {
    const newClient = score({
      outboundCount: 0,
      lastOutboundToSenderAt: null,
      lastInboundAt: daysAgo(3),
      subject: "Quote request — can you confirm availability?",
    });
    assert.ok(
      newClient >= W.MIN_SCORE_FOR_BRIEF,
      `a real new client scored ${newClient}, below the floor`,
    );
  });
});

describe("answered threads are finished business", () => {
  it("scores below one still awaiting a reply", () => {
    const waiting = score({ awaitingReply: true });
    const answered = score({ awaitingReply: false, lastOutboundAt: daysAgo(0.5) });
    assert.ok(waiting > answered, `${waiting} should beat ${answered}`);
  });
});

describe("stability — the brief must not reshuffle overnight", () => {
  it("is deterministic for identical input", () => {
    const c = candidate();
    assert.equal(scoreThread(c, NOW).score, scoreThread(c, NOW).score);
  });

  it("breaks ties on fixed keys, not array order", () => {
    const a = scoreThread(candidate({ gmailThreadId: "aaa" }), NOW);
    const b = scoreThread(candidate({ gmailThreadId: "zzz" }), NOW);
    assert.equal(a.score, b.score, "fixture precondition: scores must tie");

    const forward = rankThreads([a, b]).map((t) => t.candidate.gmailThreadId);
    const reversed = rankThreads([b, a]).map((t) => t.candidate.gmailThreadId);
    assert.deepEqual(forward, reversed, "input order must not affect ranking");
    assert.deepEqual(forward, ["aaa", "zzz"]);
  });
});

describe("the calendar join", () => {
  it("boosts a sender he is about to meet", () => {
    const withMeeting = score({ meetingSoonAt: new Date(NOW.getTime() + 3_600_000) });
    assert.ok(withMeeting > score(), "an imminent meeting should raise the score");
  });

  it("boosts a follow-up owed after a recent meeting", () => {
    const owed = score({ metRecentlyAt: daysAgo(1) });
    assert.ok(owed > score(), "an unanswered post-meeting thread should rise");
  });
});

describe("platform notification relays are not email", () => {
  it("keeps a Google Voice text below the floor despite a reply history", () => {
    // The exact shape that broke ranking: digits for a localpart, so no
    // machine-sender pattern matches, and one inbox reply granting
    // known-correspondent while exempting NEVER_CORRESPONDED.
    const score = scoreThread(
      candidate({
        fromEmail: "15715778596.18888987905.341xqhvnh5@txt.voice.google.com",
        outboundCount: 1,
        lastInboundAt: daysAgo(6),
      }),
      NOW,
    ).score;
    assert.ok(score < W.MIN_SCORE_FOR_BRIEF, `relay scored ${score}`);
  });

  it("covers the platforms that would otherwise flood the brief", () => {
    for (const address of [
      "15715778596.1@txt.voice.google.com",
      "notifications@slack.com",
      "noreply@discord.com",
      "messages-noreply@linkedin.com",
      "notification@facebookmail.com",
      "no-reply@zoom.us",
    ]) {
      assert.ok(notificationRelay(address), `should flag ${address}`);
    }
  });

  it("does not flag ordinary senders", () => {
    for (const address of ["eric@kalman.com", "sam@servicecallsaver.com"]) {
      assert.equal(notificationRelay(address), null, `should not flag ${address}`);
    }
  });

  it("does not stack with the automated penalty", () => {
    // notifications@slack.com matches both rules; only one should apply.
    const scored = scoreThread(candidate({ fromEmail: "notifications@slack.com" }), NOW);
    const demotions = scored.signals.filter((s) => s.points <= W.AUTOMATED);
    assert.equal(demotions.length, 1, "exactly one large demotion");
    assert.equal(demotions[0]?.name, "notification-relay");
  });
});

/**
 * Read is not handled.
 *
 * The premise of the brief is that a six day old unanswered email outranks this
 * morning's noise, and a six day old email is one he has certainly opened. So
 * "he read it" can only demote when nothing was asked of him. These tests exist
 * to stop a future tightening of the read penalty from quietly deleting the
 * thing the system was built to surface.
 */
describe("already-read", () => {
  const shared = {
    subject: "Good article for singers",
    snippet: "Thought you would enjoy this one, sharing it along.",
    lastInboundAt: daysAgo(8),
    awaitingReply: true,
  };
  const asked = {
    subject: "Contract redline",
    snippet: "Can you review the redline and confirm before Friday?",
    lastInboundAt: daysAgo(8),
    awaitingReply: true,
  };

  it("demotes a read share far below the same share unread", () => {
    const unread = scoreThread(candidate({ ...shared, isUnread: true }), NOW);
    const read = scoreThread(candidate({ ...shared, isUnread: false }), NOW);
    assert.ok(
      read.score < unread.score - 40,
      `read ${read.score} vs unread ${unread.score}`,
    );
  });

  it("stops age accruing once he has read it and nothing was asked", () => {
    const read = scoreThread(candidate({ ...shared, isUnread: false }), NOW);
    assert.equal(
      read.signals.filter((s) => s.name === "aging").length,
      0,
      "days since are not evidence of neglect on something he read and dismissed",
    );
  });

  it("keeps a read question waiting, and keeps its age", () => {
    const read = scoreThread(candidate({ ...asked, isUnread: false }), NOW);
    assert.ok(
      read.signals.some((s) => s.name === "aging"),
      "reading a question does not answer it, so it still ages",
    );
    assert.ok(read.score >= W.MIN_SCORE_FOR_BRIEF, `scored ${read.score}`);
  });

  it("still ranks a read week-old question above an unread share from today", () => {
    // The constraint this whole file exists to protect, restated with read
    // state in play: recency is not importance.
    const oldQuestion = scoreThread(candidate({ ...asked, isUnread: false }), NOW);
    const freshShare = scoreThread(
      candidate({ ...shared, isUnread: true, lastInboundAt: daysAgo(0) }),
      NOW,
    );
    assert.ok(
      oldQuestion.score > freshShare.score,
      `question ${oldQuestion.score} vs share ${freshShare.score}`,
    );
  });

  it("says nothing about read state on a thread that is not waiting", () => {
    const replied = scoreThread(
      candidate({ ...shared, awaitingReply: false, isUnread: false }),
      NOW,
    );
    assert.equal(replied.signals.filter((s) => s.name === "already-read").length, 0);
  });
});

describe("archived", () => {
  const base = {
    subject: "Good article for singers",
    snippet: "Sharing this along, thought you would enjoy it.",
    lastInboundAt: daysAgo(8),
    awaitingReply: true,
  };

  it("demotes harder than reading it, and stops age accruing", () => {
    const read = scoreThread(candidate({ ...base, isUnread: false }), NOW);
    const filed = scoreThread(
      candidate({ ...base, isUnread: false, isArchived: true }),
      NOW,
    );
    assert.ok(filed.score < read.score, `${filed.score} vs ${read.score}`);
    assert.equal(filed.signals.filter((s) => s.name === "aging").length, 0);
  });

  it("counts even when he never opened it", () => {
    // Six of the last ten archives happened without the message being read.
    // Clearing a list view is triage too.
    const swiped = scoreThread(
      candidate({ ...base, isUnread: true, isArchived: true }),
      NOW,
    );
    assert.ok(swiped.signals.some((s) => s.name === "archived"));
    assert.ok(!swiped.signals.some((s) => s.name === "already-read"));
  });

  it("still demotes when something was asked, unlike reading", () => {
    const asked = { ...base, snippet: "Can you review this and confirm?" };
    const filed = scoreThread(
      candidate({ ...asked, isUnread: false, isArchived: true }),
      NOW,
    );
    assert.ok(filed.signals.some((s) => s.name === "archived"));
  });
});

describe("report fatigue", () => {
  const nagged = {
    subject: "Watch this and learn",
    snippet: "Sharing a clip you might like.",
    lastInboundAt: daysAgo(8),
    awaitingReply: true,
  };

  it("says nothing for the first three mornings", () => {
    for (const mornings of [0, 1, 2, 3]) {
      const t = scoreThread(candidate({ ...nagged, reportedMornings: mornings }), NOW);
      assert.equal(
        t.signals.filter((s) => s.name === "report-fatigue").length,
        0,
        `fired at ${mornings} mornings`,
      );
    }
  });

  it("starts on the fourth and grows", () => {
    const fourth = scoreThread(candidate({ ...nagged, reportedMornings: 4 }), NOW);
    const eighth = scoreThread(candidate({ ...nagged, reportedMornings: 8 }), NOW);
    const points = (t: typeof fourth) =>
      t.signals.find((s) => s.name === "report-fatigue")?.points ?? 0;
    assert.ok(points(fourth) < 0);
    assert.ok(points(eighth) < points(fourth));
    assert.ok(points(eighth) >= W.FATIGUE_MAX, "must stay capped");
  });

  it("holds back when something was actually asked", () => {
    // Putting off a real request is exactly when the brief should keep saying it.
    const asked = scoreThread(
      candidate({
        ...nagged,
        snippet: "Can you confirm the redline before Friday?",
        reportedMornings: 9,
      }),
      NOW,
    );
    assert.equal(asked.signals.filter((s) => s.name === "report-fatigue").length, 0);
  });

  it("holds back while a deadline is live", () => {
    const due = scoreThread(
      candidate({
        ...nagged,
        reportedMornings: 9,
        deadline: { state: "today", phrase: "by the 14th", date: "2026-08-13" },
      }),
      NOW,
    );
    assert.equal(due.signals.filter((s) => s.name === "report-fatigue").length, 0);
  });
});

describe("gmail importance", () => {
  it("is a tiebreaker, never a verdict", () => {
    const base = { awaitingReply: true, lastInboundAt: daysAgo(3) };
    const marked = scoreThread(candidate({ ...base, isImportant: true }), NOW);
    const not = scoreThread(candidate({ ...base, isImportant: false }), NOW);
    assert.ok(not.score < marked.score);
    assert.ok(
      marked.score - not.score < W.AWAITING_REPLY,
      "must never outweigh the thread actually waiting",
    );
  });
});
