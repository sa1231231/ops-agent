import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

process.env.GOOGLE_CLIENT_ID ??= "test-client-id";
process.env.GOOGLE_CLIENT_SECRET ??= "test-client-secret";
process.env.OAUTH_REDIRECT_URI ??= "http://localhost/oauth/callback";

const { GoogleTokenError, refreshAccessToken } = await import("./google.js");

/**
 * The distinction these tests protect is the one that cost a real morning:
 * Google returning 500 on a token refresh is not the same as Google rejecting
 * the token, and only the second one means an account needs reconnecting.
 */

type Handler = () => Response;

const realFetch = globalThis.fetch;
let queue: Handler[] = [];
let calls = 0;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

before(() => {
  globalThis.fetch = (async () => {
    calls++;
    const next = queue.shift();
    if (!next) throw new Error("unexpected fetch");
    return next();
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
});

function reset(handlers: Handler[]) {
  queue = handlers;
  calls = 0;
}

const ok = () => json(200, { access_token: "at", expires_in: 3600, scope: "s" });
const boom = () => json(500, { error: "internal_failure" });
const revoked = () =>
  json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });

describe("refreshAccessToken", () => {
  it("retries a 500 and succeeds", async () => {
    reset([boom, ok]);
    const tokens = await refreshAccessToken("rt");
    assert.equal(tokens.accessToken, "at");
    assert.equal(calls, 2);
  });

  it("gives up after three attempts and reports the transient code", async () => {
    reset([boom, boom, boom]);
    const err = await refreshAccessToken("rt").then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof GoogleTokenError);
    assert.equal(err.code, "internal_failure");
    assert.equal(err.isPermanent, false);
    assert.equal(calls, 3);
  });

  it("does not retry invalid_grant", async () => {
    reset([revoked, ok]);
    const err = await refreshAccessToken("rt").then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof GoogleTokenError);
    assert.equal(err.code, "invalid_grant");
    assert.equal(err.isPermanent, true);
    assert.equal(calls, 1);
  });

  it("treats an unreachable endpoint as transient, not as a dead grant", async () => {
    reset([
      () => {
        throw new TypeError("fetch failed");
      },
      ok,
    ]);
    const tokens = await refreshAccessToken("rt");
    assert.equal(tokens.accessToken, "at");
    assert.equal(calls, 2);
  });

  it("never puts the refresh token in the error message", async () => {
    reset([revoked]);
    const err = await refreshAccessToken("super-secret-refresh-token").then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof Error);
    assert.ok(!err.message.includes("super-secret-refresh-token"));
  });
});
