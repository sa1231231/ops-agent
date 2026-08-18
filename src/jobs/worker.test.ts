import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { retryableEmails } from "./worker.js";

/**
 * The pre-brief retry exists to rescue accounts that failed for a reason that
 * passes. Handing it a revoked grant spends the deadline on a request whose
 * answer is already known.
 */
describe("retryableEmails", () => {
  const transient = { email: "a@example.com", reason: "500", permanent: false };
  const revoked = { email: "b@example.com", reason: "invalid_grant", permanent: true };

  it("retries recoverable failures", () => {
    assert.deepEqual(retryableEmails([transient]), ["a@example.com"]);
  });

  it("leaves revoked accounts alone", () => {
    assert.deepEqual(retryableEmails([revoked]), []);
  });

  it("retries only the recoverable half of a mixed batch", () => {
    assert.deepEqual(retryableEmails([revoked, transient]), ["a@example.com"]);
  });

  it("is empty when nothing failed", () => {
    assert.deepEqual(retryableEmails([]), []);
  });
});
