import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ALL_CHOICES,
  isApproval,
  isPriorityChoice,
  priorityChoiceById,
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

describe("priority choices", () => {
  it("gives every option a distinct effect", () => {
    // The bug this replaced: four options all declaring "Recorded against the
    // priorities prompt". Choosing between them changed nothing, so the menu
    // read as vague next to the attention one.
    const effects = PRIORITY_CHOICES.map((c) => c.effect);
    assert.equal(new Set(effects).size, effects.length, effects.join(" | "));
  });

  it("keeps ids unique and namespaced so routing cannot mistake one", () => {
    const ids = PRIORITY_CHOICES.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.ok(id.startsWith("priority-"), id);
  });

  it("proposes instructions that obey the brief's own house style", () => {
    // These are injected into the prompt verbatim, so a dash here would teach
    // the model the punctuation the brief spends a rule forbidding.
    for (const c of PRIORITY_CHOICES) {
      if (c.proposes === null) continue;
      assert.ok(!/[\u2013\u2014\u2015]/.test(c.proposes), c.id);
      assert.ok(!/ - /.test(c.proposes), c.id);
      assert.ok(c.proposes.length <= 240, `${c.id} is too long for a house rule`);
    }
  });

  it("resolves a choice by id and returns null for anything else", () => {
    assert.equal(priorityChoiceById("priority-vague")?.proposes !== null, true);
    assert.equal(priorityChoiceById("priority-not-mine")?.proposes, null);
    assert.equal(priorityChoiceById("sender-noise"), null);
    assert.equal(priorityChoiceById("priority-good"), null);
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
