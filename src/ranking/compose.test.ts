import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sanitizeLine } from "./compose.js";

/**
 * The model writes prose that lands in a text message unedited, so the two
 * things worth guaranteeing are that it fits on one line and that it does not
 * read as machine-written. A dash used as punctuation is the clearest tell of
 * the second, and the prompt asking nicely is not a guarantee.
 */

describe("house style, enforced rather than requested", () => {
  it("turns a dash used as punctuation into a comma", () => {
    assert.equal(
      sanitizeLine("Eric is waiting — six days now"),
      "Eric is waiting, six days now",
    );
    assert.equal(sanitizeLine("Hetzner replied - ticket closed"), "Hetzner replied, ticket closed");
    assert.equal(sanitizeLine("Two things – both today"), "Two things, both today");
  });

  it("leaves hyphenated words alone", () => {
    // The rule is about dashes standing in for punctuation, not every hyphen.
    assert.equal(sanitizeLine("Double-booked at 9am"), "Double-booked at 9am");
    assert.equal(sanitizeLine("the 1-on-1 with Eric"), "the 1-on-1 with Eric");
  });

  it("does not leave a comma stacked on punctuation that was already there", () => {
    assert.equal(sanitizeLine("Send it today — , then rest"), "Send it today, then rest");
  });

  it("still collapses to a single line and trims at a word boundary", () => {
    assert.equal(sanitizeLine("one\ntwo\tthree"), "one two three");
    const clipped = sanitizeLine("a".repeat(10) + " " + "b".repeat(40), 30);
    assert.ok(clipped.endsWith("…"), clipped);
    assert.ok(clipped.length <= 30, `${clipped.length} chars`);
  });
});
