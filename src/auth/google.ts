import { requireEnv } from "../config.js";
import { SCOPE_STRING } from "./scopes.js";

/**
 * Google OAuth 2.0, implemented directly against the three endpoints we need.
 *
 * One code path for every account. Workspace and personal accounts go through
 * exactly this flow and are stored identically — there is deliberately no
 * per-domain branching, and no domain-wide delegation anywhere.
 *
 * Tokens are never logged, including in error paths.
 */

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";

export interface TokenSet {
  accessToken: string;
  /** Absent on refresh responses — Google only issues it during code exchange. */
  refreshToken?: string;
  expiresAt: Date;
  scope: string;
}

export function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: requireEnv("GOOGLE_CLIENT_ID"),
    redirect_uri: requireEnv("OAUTH_REDIRECT_URI"),
    response_type: "code",
    scope: SCOPE_STRING,
    // offline + consent is what guarantees a refresh_token. Without `consent`,
    // re-authorizing an already-connected account returns no refresh token and
    // the account silently dies when its access token expires.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    state,
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

/**
 * OAuth error codes that mean the grant itself is gone.
 *
 * This is the whole distinction that matters here. `invalid_grant` is Google
 * saying "that refresh token is no longer valid" — revoked, password changed,
 * consent withdrawn — and no amount of retrying fixes it. Everything else,
 * including a 500 `internal_failure`, is Google saying "not right now", which is
 * a completely different situation and must not be reported to a human as a
 * dead account.
 */
const PERMANENT_TOKEN_ERRORS = new Set([
  "invalid_grant",
  "invalid_client",
  "unauthorized_client",
  "invalid_scope",
]);

export class GoogleTokenError extends Error {
  constructor(
    /** 0 when the request never got a response at all. */
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GoogleTokenError";
  }

  /** True when reconnecting is the only fix; false when waiting is. */
  get isPermanent(): boolean {
    return PERMANENT_TOKEN_ERRORS.has(this.code);
  }
}

async function postToken(body: URLSearchParams): Promise<GoogleTokenResponse> {
  let res: Response;
  try {
    res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (err) {
    // DNS, TLS, connection reset. Never a statement about the token.
    throw new GoogleTokenError(
      0,
      "network_error",
      `Could not reach Google's token endpoint: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const json = (await res.json().catch(() => ({}))) as GoogleTokenResponse;

  if (!res.ok || json.error) {
    // Google's error/description are safe to surface; the token fields are not.
    const code = json.error ?? (res.ok ? "unknown" : `http_${res.status}`);
    throw new GoogleTokenError(
      res.status,
      code,
      `Google token endpoint ${res.status}: ${code}` +
        (json.error_description ? `: ${json.error_description}` : ""),
    );
  }
  return json;
}

const REFRESH_ATTEMPTS = 3;
const REFRESH_BACKOFF_MS = [400, 1600];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function toTokenSet(json: GoogleTokenResponse): TokenSet {
  if (!json.access_token) {
    throw new Error("Google returned no access_token");
  }
  // Expire a minute early so a token cannot lapse mid-request.
  const ttl = (json.expires_in ?? 3600) - 60;
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: new Date(Date.now() + ttl * 1000),
    scope: json.scope ?? "",
  };
}

export async function exchangeCode(code: string): Promise<TokenSet> {
  const tokens = toTokenSet(
    await postToken(
      new URLSearchParams({
        code,
        client_id: requireEnv("GOOGLE_CLIENT_ID"),
        client_secret: requireEnv("GOOGLE_CLIENT_SECRET"),
        redirect_uri: requireEnv("OAUTH_REDIRECT_URI"),
        grant_type: "authorization_code",
      }),
    ),
  );

  if (!tokens.refreshToken) {
    throw new Error(
      "Google returned no refresh_token. Without one this account cannot sync " +
        "beyond the first hour. Revoke ops-agent's access at " +
        "myaccount.google.com/permissions and reconnect.",
    );
  }
  return tokens;
}

/**
 * Exchanges a refresh token for an access token, retrying Google's bad seconds.
 *
 * Refresh happens roughly once an hour per account across fifteen accounts, so
 * over a week this endpoint is called a couple of thousand times and it will
 * return a 500 occasionally no matter what we do. Absorbing that here is the
 * right layer: a blip that resolves in under two seconds should never become an
 * account status a human has to interpret, let alone a line in the client's
 * brief saying his mailbox was skipped.
 *
 * Permanent errors are not retried. Hammering the endpoint with a refresh token
 * Google has already told us is dead earns nothing but rate limiting.
 */
export async function refreshAccessToken(
  refreshToken: string,
): Promise<TokenSet> {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: requireEnv("GOOGLE_CLIENT_ID"),
    client_secret: requireEnv("GOOGLE_CLIENT_SECRET"),
    grant_type: "refresh_token",
  });

  for (let attempt = 1; ; attempt++) {
    try {
      return toTokenSet(await postToken(body));
    } catch (err) {
      const retryable =
        err instanceof GoogleTokenError && !err.isPermanent && attempt < REFRESH_ATTEMPTS;
      if (!retryable) throw err;
      console.warn(
        `[auth] token refresh attempt ${attempt} failed (${(err as GoogleTokenError).code}), retrying`,
      );
      await sleep(REFRESH_BACKOFF_MS[attempt - 1] ?? 1600);
    }
  }
}

/** Identifies which mailbox a token belongs to, so the user picks the account. */
export async function fetchUserEmail(accessToken: string): Promise<string> {
  const res = await fetch(USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Google userinfo endpoint returned ${res.status}`);
  }
  const json = (await res.json()) as { email?: string };
  if (!json.email) {
    throw new Error("Google userinfo returned no email address");
  }
  return json.email.toLowerCase();
}

/**
 * Asks Google to revoke the grant.
 *
 * Best-effort: the local disconnect must succeed regardless. But telling Google
 * is the difference between "we stopped looking" and the access actually being
 * gone, and it means the entry disappears from his Google account permissions
 * rather than lingering there.
 */
export async function revokeToken(refreshToken: string): Promise<boolean> {
  try {
    const res = await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refreshToken }),
    });
    // 400 usually means it was already revoked or expired, which is fine.
    return res.ok;
  } catch {
    return false;
  }
}
