import { randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";
import { buildAuthUrl, exchangeCode, fetchUserEmail } from "../auth/google.js";
import { hasOnlyExpectedScopes } from "../auth/scopes.js";
import { upsertAccount } from "../db/queries/accounts.js";
import { renderMessagePage } from "./admin.js";

/**
 * The single OAuth path. Every account — Workspace or personal — goes through
 * exactly these two handlers.
 */

const STATE_TTL_MS = 10 * 60 * 1000;

// In-memory is sufficient: one web instance, and a restart mid-consent just
// means the user clicks Connect again.
const pendingStates = new Map<string, number>();

function issueState(): string {
  const now = Date.now();
  for (const [value, expiry] of pendingStates) {
    if (expiry < now) pendingStates.delete(value);
  }
  const state = randomBytes(24).toString("base64url");
  pendingStates.set(state, now + STATE_TTL_MS);
  return state;
}

function consumeState(state: string | null): boolean {
  if (!state) return false;
  const expiry = pendingStates.get(state);
  // Single-use: delete on sight so a replayed callback cannot reuse it.
  pendingStates.delete(state);
  return expiry !== undefined && expiry >= Date.now();
}

export function handleConnect(res: ServerResponse): void {
  res.writeHead(302, { Location: buildAuthUrl(issueState()) });
  res.end();
}

function send(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

export async function handleCallback(
  url: URL,
  res: ServerResponse,
): Promise<void> {
  const error = url.searchParams.get("error");
  if (error) {
    // Most commonly access_denied — the user backed out of the consent screen.
    send(res, 400, renderMessagePage("Connection cancelled", `Google returned "${error}".`, false));
    return;
  }

  if (!consumeState(url.searchParams.get("state"))) {
    send(
      res,
      400,
      renderMessagePage(
        "Connection failed",
        "That authorization link was invalid, already used, or expired. Start again from Connect account.",
        false,
      ),
    );
    return;
  }

  const code = url.searchParams.get("code");
  if (!code) {
    send(res, 400, renderMessagePage("Connection failed", "Google returned no authorization code.", false));
    return;
  }

  try {
    const tokens = await exchangeCode(code);

    // Defense in depth: refuse to store a grant broader than we asked for.
    if (tokens.scope && !hasOnlyExpectedScopes(tokens.scope)) {
      throw new Error(
        `Refusing to store a token with unexpected scopes: ${tokens.scope}`,
      );
    }

    const email = await fetchUserEmail(tokens.accessToken);
    const account = await upsertAccount(email, tokens);

    send(
      res,
      200,
      renderMessagePage(
        "Account connected",
        `${account.email} is connected and read-only. It will be included in the next sync.`,
        true,
      ),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[oauth] callback failed:", message);
    send(res, 500, renderMessagePage("Connection failed", message, false));
  }
}
