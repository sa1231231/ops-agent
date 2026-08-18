import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deadlineFor, extractDeadline } from "./deadlines.js";

/**
 * Confidently wrong is worse than silent.
 *
 * A missed deadline is recoverable — the thread still surfaces on its other
 * signals. Telling him something is due today when it is not is the kind of
 * error that makes a person stop reading, so the false-positive cases below
 * matter more than the coverage ones.
 */

const TZ = "America/New_York";
/** A Friday, 2pm ET. */
const FRIDAY = new Date("2026-08-14T18:00:00Z");
const on = (text: string, sentAt = FRIDAY) => extractDeadline(text, sentAt, TZ);

describe("resolving a named date", () => {
  it("reads same-day language as the day it was sent", () => {
    for (const phrase of ["by EOD", "end of day", "need this today", "by COB"]) {
      assert.equal(on(phrase)?.date, "2026-08-14", phrase);
    }
  });

  it("reads tomorrow", () => {
    assert.equal(on("can you send it by tomorrow")?.date, "2026-08-15");
  });

  it("resolves a weekday to the next one on or after the send date", () => {
    // Sent Friday: "by Monday" is the 17th, "by Friday" is the same day.
    assert.equal(on("please confirm by monday")?.date, "2026-08-17");
    assert.equal(on("due friday")?.date, "2026-08-14");
  });

  it("treats 'next <weekday>' said on that weekday as the following week", () => {
    assert.equal(on("let's do it next friday")?.date, "2026-08-21");
  });

  it("resolves end of week to the Friday of that week", () => {
    const monday = new Date("2026-08-10T14:00:00Z");
    assert.equal(on("by EOW", monday)?.date, "2026-08-14");
  });

  it("reads an explicit month and day", () => {
    assert.equal(on("please respond by August 20")?.date, "2026-08-20");
    assert.equal(on("due Sep 3rd")?.date, "2026-09-03");
  });

  it("rolls an earlier month into next year rather than the past", () => {
    assert.equal(on("by Feb 2")?.date, "2027-02-02");
  });

  it("reads a numeric date only with a leading preposition", () => {
    assert.equal(on("get back to me by 8/20")?.date, "2026-08-20");
    // Ratios, version numbers and scores must not become deadlines.
    assert.equal(on("we rated it 9/10 overall"), null);
    assert.equal(on("upgrade to 4/5 nodes"), null);
  });

  it("resolves relative to the message, not to now", () => {
    // "by Friday" in a two-week-old message meant that Friday. Treating it as
    // the upcoming one would invent a deadline nobody set.
    const old = new Date("2026-07-28T14:00:00Z"); // a Tuesday
    assert.equal(on("by friday", old)?.date, "2026-07-31");
  });

  it("says nothing when there is no date", () => {
    for (const text of [
      "thanks, looks good",
      "can you review this when you get a chance",
      "the deadline has been removed",
    ]) {
      assert.equal(on(text), null, text);
    }
  });
});

describe("state, as of today", () => {
  const state = (text: string, sentAt = FRIDAY) =>
    deadlineFor(text, sentAt, FRIDAY, TZ)?.state ?? null;

  it("flags a date that has arrived", () => {
    assert.equal(state("by EOD"), "today");
  });

  it("flags tomorrow separately from today", () => {
    assert.equal(state("by tomorrow"), "tomorrow");
  });

  it("flags a date he has already blown", () => {
    const lastWeek = new Date("2026-08-07T14:00:00Z");
    assert.equal(state("by monday", lastWeek), "overdue"); // Aug 10
  });

  it("scores overdue above tomorrow, since the damage is already happening", async () => {
    const W = await import("./weights.js");
    assert.ok(W.DEADLINE_OVERDUE > W.DEADLINE_TOMORROW);
    assert.ok(W.DEADLINE_TODAY > W.DEADLINE_OVERDUE);
  });

  it("forgets a deadline old enough to be archaeology", () => {
    const ages = new Date("2026-06-01T14:00:00Z");
    assert.equal(deadlineFor("by june 2", ages, FRIDAY, TZ), null);
  });

  it("keeps a future date without treating it as urgent", () => {
    assert.equal(state("by August 28"), "later");
  });

  it("never reports a date without a phrase to justify it", () => {
    const found = deadlineFor("please confirm by monday", FRIDAY, FRIDAY, TZ);
    assert.ok(found?.phrase.includes("monday"), "the reason must be inspectable");
  });
});

describe("machines do not get deadlines", () => {
  it("ignores marketing copy, which is made of deadline words", async () => {
    const { scoreThread } = await import("./score.js");
    const base = {
      accountId: 1, accountEmail: "sam@servicecallsaver.com",
      gmailThreadId: "t", subject: "Last chance: $100 off, offer ends today",
      snippet: "Book today", lastInboundAt: FRIDAY, lastOutboundAt: null,
      awaitingReply: true, messageCount: 1,
      fromName: null, toEmails: ["sam@servicecallsaver.com"], ccEmails: [],
      isAutomated: false, hasListUnsubscribe: false,
      outboundCount: 0, lastOutboundToSenderAt: null,
      meetingSoonAt: null, metRecentlyAt: null, isUnread: true,
      deadline: deadlineFor("offer ends today", FRIDAY, FRIDAY, TZ),
    };
    assert.ok(base.deadline, "fixture precondition: the words do parse");

    // Every false positive found against live data was a newsletter. The
    // automated penalty would have cancelled the boost anyway, but only by
    // arithmetic accident — the signal should not fire at all.
    const machine = scoreThread({ ...base, fromEmail: "news@marketing.example.com" }, FRIDAY);
    assert.equal(
      machine.signals.filter((s) => s.name.startsWith("deadline-")).length,
      0,
      "a machine sender was credited with a deadline",
    );

    const human = scoreThread({ ...base, fromEmail: "eric@kalman.com" }, FRIDAY);
    assert.equal(human.signals.filter((s) => s.name.startsWith("deadline-")).length, 1);
  });
});

describe("timezone", () => {
  it("uses the brief's timezone, not UTC, to decide which day it is", () => {
    // 9pm ET is already tomorrow in UTC. A UTC-floored implementation reports
    // the wrong day for a third of every day.
    const lateEvening = new Date("2026-08-14T01:30:00Z"); // Aug 13, 9:30pm ET
    assert.equal(extractDeadline("by EOD", lateEvening, TZ)?.date, "2026-08-13");
  });
});
