import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ALL_CHOICES,
  isApproval,
  isPriorityChoice,
  PRIORITY_CHOICES,
  priorityIndexFromNote,
  priorityNote,
  verdictLabel,
} from "./feedback.js";

/**
 * The vocabulary is shared across three files that never call each other: the
 * page offers a choice, the handler routes it, the page later reads back what
 * was recorded. Nothing here fails loudly when they drift — the page just
 * quietly stops knowing what was already judged — so the seams are tested.
 */

describe("priority verdicts, which have no thread key", () => {
  it("survives the round trip through the note field", () => {
    for (const index of [1, 2, 3]) {
      assert.equal(priorityIndexFromNote(priorityNote(index, "Send the redline")), index);
    }
  });

  it("keeps the priority text, so the verdict is readable later", () => {
    assert.match(priorityNote(2, "Prep the 1:1"), /Prep the 1:1/);
  });

  it("is not confused by a colon in the priority itself", () => {
    // "priority 1: Call Eric re: contract" must not parse as priority "re".
    assert.equal(priorityIndexFromNote(priorityNote(1, "Call Eric re: contract")), 1);
  });

  it("returns null rather than a wrong index for anything else", () => {
    for (const note of [null, "", "some free text", "priority: 1"]) {
      assert.equal(priorityIndexFromNote(note), null, String(note));
    }
  });
});

describe("recorded verdicts read back as words", () => {
  it("labels every choice that can be recorded", () => {
    const ids = [
      "good",
      "priority-good",
      "missed",
      "not-missed",
      ...ALL_CHOICES.map((c) => c.id),
      ...PRIORITY_CHOICES.map((c) => c.id),
    ];
    for (const id of ids) {
      assert.notEqual(verdictLabel(id), "Judged", `${id} has no label`);
    }
  });

  it("falls back rather than showing a raw id for something unknown", () => {
    assert.equal(verdictLabel("some-future-choice"), "Judged");
    assert.equal(verdictLabel(null), "Judged");
  });

  it("knows which verdicts were approvals", () => {
    assert.ok(isApproval("good"));
    assert.ok(isApproval("not-missed"), "confirming an omission is approval, not a complaint");
    assert.ok(!isApproval("missed"));
    assert.ok(!isApproval("sender-noise"));
  });
});

describe("routing", () => {
  it("treats every priority option as a priority, so none reaches the sender rules", () => {
    // A priority has no thread behind it; routing one into upsertSenderRule
    // would demote whatever sender happened to be looked up.
    for (const c of PRIORITY_CHOICES) assert.ok(isPriorityChoice(c.id), c.id);
    assert.ok(isPriorityChoice("priority-good"));
    for (const c of ALL_CHOICES) assert.ok(!isPriorityChoice(c.id), c.id);
    assert.ok(!isPriorityChoice("missed"));
    assert.ok(!isPriorityChoice("not-missed"));
  });
});
