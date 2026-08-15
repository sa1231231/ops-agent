import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapWithConcurrency } from "./googleApi.js";

/**
 * This is the throttle the whole sync depends on twice over: once inside an
 * account, over its messages, and once across accounts. The second use is what
 * keeps fifteen mailboxes from opening a hundred and fifty requests and
 * exhausting a five-connection pool, so the ceiling is worth pinning down.
 */

describe("mapWithConcurrency", () => {
  it("never runs more than the limit at once", async () => {
    let running = 0;
    let peak = 0;

    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running -= 1;
    });

    assert.ok(peak <= 4, `ran ${peak} at once, limit was 4`);
    assert.equal(peak, 4, "should actually use the budget, not serialize");
  });

  it("returns results in input order, not completion order", async () => {
    // syncAll pairs each result with its account by index. If a slow item
    // landed out of order, a failure would be reported against the wrong
    // mailbox, which is worse than not reporting it.
    const results = await mapWithConcurrency([30, 1, 20, 2], 4, async (delay) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return delay;
    });
    assert.deepEqual(results, [30, 1, 20, 2]);
  });

  it("handles an empty list without hanging", async () => {
    assert.deepEqual(await mapWithConcurrency([], 4, async (x) => x), []);
  });

  it("copes with a limit larger than the list", async () => {
    const results = await mapWithConcurrency([1, 2], 10, async (x) => x * 2);
    assert.deepEqual(results, [2, 4]);
  });
});
