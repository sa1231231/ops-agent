import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { conflictLines, estimateSegments, meetingLines, renderPlainText, toGsm7 } from "./render.js";
import type { Conflict, Meeting } from "../ranking/meetings.js";
import type { ComposedBrief } from "../ranking/compose.js";

/**
 * The message is the product. These lock in the two things that are easy to
 * break silently: which conflicts he is told about, and whether the text stays
 * inside GSM-7 (a single stray character doubles the bill).
 */

/** 2026-08-14, times given in ET, which is BRIEF_TZ. */
function meeting(hourET: number, minute: number, title: string, durationMin = 30): Meeting {
  const startsAt = new Date(Date.UTC(2026, 7, 14, hourET + 4, minute));
  return {
    title,
    startsAt,
    endsAt: new Date(startsAt.getTime() + durationMin * 60_000),
    allDay: false,
    attendeeEmails: [],
    organizerEmail: null,
    hasAgenda: true,
    accounts: ["sam@servicecallsaver.com"],
  };
}

const overlap = (a: Meeting, b: Meeting): Conflict => ({ a, b, kind: "overlap" });
const backToBack = (a: Meeting, b: Meeting): Conflict => ({ a, b, kind: "back-to-back" });

describe("only genuine double-bookings reach the message", () => {
  it("says nothing about meetings that merely run back-to-back", () => {
    // His standups do this every single morning. A line that fires daily is one
    // he learns to skip, which costs him the days it matters.
    const a = meeting(8, 30, "cisa standup");
    const b = meeting(9, 0, "cdp standup");
    assert.deepEqual(conflictLines([backToBack(a, b)]), []);
  });

  it("flags two meetings at the same time", () => {
    const a = meeting(9, 0, "cdp standup");
    const b = meeting(9, 15, "Client call");
    const [line, ...rest] = conflictLines([overlap(a, b)]);
    assert.equal(rest.length, 0, "one conflict, one line");
    assert.match(line ?? "", /^Double-booked - 9:00 AM cdp standup \/ 9:15 AM Client call$/);
  });

  it("collapses a triple booking into one line, not three pairs", () => {
    // Three mutually overlapping meetings produce three pairs from the detector.
    // Printing them raw reads as three separate problems.
    const a = meeting(9, 0, "Standup");
    const b = meeting(9, 10, "Client call");
    const c = meeting(9, 20, "Vendor sync");
    const lines = conflictLines([overlap(a, b), overlap(a, c), overlap(b, c)]);

    assert.equal(lines.length, 1, `expected one clustered line, got ${lines.length}`);
    assert.match(lines[0] ?? "", /^Triple-booked - /);
    for (const title of ["Standup", "Client call", "Vendor sync"]) {
      assert.ok(lines[0]?.includes(title), `missing ${title}`);
    }
  });

  it("keeps unrelated double-bookings on separate lines", () => {
    const morning = [meeting(9, 0, "A"), meeting(9, 5, "B")] as const;
    const afternoon = [meeting(14, 0, "C"), meeting(14, 5, "D")] as const;
    const lines = conflictLines([
      overlap(morning[0], morning[1]),
      overlap(afternoon[0], afternoon[1]),
    ]);
    assert.equal(lines.length, 2, "two unrelated clashes are two problems");
  });

  it("orders each cluster by start time regardless of pair order", () => {
    const early = meeting(9, 0, "Early");
    const late = meeting(9, 30, "Late");
    const [line] = conflictLines([overlap(late, early)]);
    assert.ok(
      (line ?? "").indexOf("Early") < (line ?? "").indexOf("Late"),
      `earlier meeting should read first: ${line}`,
    );
  });
});

describe("the meeting list", () => {
  it("renders one line per meeting, time first, in the brief timezone", () => {
    const lines = meetingLines([meeting(7, 0, "Freedom Chase"), meeting(13, 0, "1 on 1")]);
    assert.deepEqual(lines, ["7:00 AM  Freedom Chase", "1:00 PM  1 on 1"]);
  });

  it("truncates a long title at a word boundary", () => {
    const [line] = meetingLines([
      meeting(9, 0, "Quarterly planning review with the entire operations team and vendors"),
    ]);
    assert.ok((line ?? "").length < 62, `too long: ${line}`);
    assert.match(line ?? "", /\.\.\.$/);
    assert.doesNotMatch(line ?? "", /\s\.\.\.$/, "should not leave a dangling space");
  });
});

describe("the rendered message", () => {
  const brief: ComposedBrief = {
    emails: [
      { thread_key: "1:a", line: "Hetzner needs a cause statement", reason: "deadline today" },
      { thread_key: "1:b", line: "Dubravka is waiting on a reply", reason: "still open, day 2" },
    ],
    priorities: ["Send the cause statement", "Fix the worker", "Prep the 1:1"],
  };

  const render = (over: Partial<Parameters<typeof renderPlainText>[1]> = {}) =>
    renderPlainText(brief, {
      localDate: "2026-08-14",
      skippedAccounts: [],
      meetings: ["7:00 AM  Freedom Chase"],
      conflicts: [],
      greetingName: "Payeman",
      ...over,
    });

  it("opens with the greeting and carries no date line", () => {
    const text = render();
    assert.ok(text.startsWith("Good morning, Payeman\n"), text.slice(0, 40));
    assert.doesNotMatch(text, /Aug|2026-08-14/, "the phone already shows him the date");
  });

  it("falls back to a bare greeting when no name is set", () => {
    assert.ok(render({ greetingName: "" }).startsWith("Good morning\n"));
  });

  it("puts a blank line between every numbered item, in both sections", () => {
    const text = render();
    assert.match(text, /1\. Send the cause statement\n\n2\. Fix the worker/);
    assert.match(text, /1\. Hetzner needs a cause statement\n\n2\. Dubravka/);
  });

  it("never leaves more than one blank line anywhere", () => {
    // The section separators and the per-item blanks butt against each other;
    // the collapse is what stops that showing up as a gap.
    assert.doesNotMatch(render(), /\n{3}/);
  });

  it("leaves the reasons out of the message", () => {
    const text = render();
    assert.doesNotMatch(text, /deadline today|still open, day 2/);
  });

  it("orders meetings, then priorities, then replies", () => {
    const text = render();
    assert.ok(
      text.indexOf("MEETINGS") < text.indexOf("PRIORITIES") &&
        text.indexOf("PRIORITIES") < text.indexOf("NEEDS ATTENTION"),
      "section order changed",
    );
  });

  it("stays inside GSM-7, so a segment is 153 characters and not 67", () => {
    const text = render({
      meetings: ["9:00 AM  Café — “strategy” session…"],
    });
    assert.doesNotMatch(text, /[^\x0A\x20-\x7E]/, "a single non-GSM-7 character doubles the bill");
    assert.equal(estimateSegments(text), Math.ceil(text.length / 153));
  });

  it("names accounts it could not read rather than staying silent", () => {
    assert.match(render({ skippedAccounts: ["ops@acme.com"] }), /Could not read: ops@acme\.com/);
  });

  it("carries no link", () => {
    // The brief page still exists and the console still links to it; the
    // message is meant to stand alone rather than spend a segment on a URL.
    assert.doesNotMatch(render(), /https?:\/\//);
  });

  it("says so plainly when the calendar is empty", () => {
    assert.match(render({ meetings: [] }), /Nothing on the calendar today\./);
  });
});

describe("toGsm7", () => {
  it("substitutes rather than deletes the characters the model actually emits", () => {
    assert.equal(toGsm7("don’t — “x” … 1/2"), "don't - \"x\" ... 1/2");
  });
});
