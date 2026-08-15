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

async function postToken(body: URLSearchParams): Promise<GoogleTokenResponse> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const json = (await res.json().catch(() => ({}))) as GoogleTokenResponse;

  if (!res.ok || json.error) {
    // Google's error/description are safe to surface; the token fields are not.
    throw new Error(
      `Google token endpoint ${res.status}: ${json.error ?? "unknown"}` +
        (json.error_description ? `: ${json.error_description}` : ""),
    );
  }
  return json;
}

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

export async function refreshAccessToken(
  refreshToken: string,
): Promise<TokenSet> {
  return toTokenSet(
    await postToken(
      new URLSearchParams({
        refresh_token: refreshToken,
        client_id: requireEnv("GOOGLE_CLIENT_ID"),
        client_secret: requireEnv("GOOGLE_CLIENT_SECRET"),
        grant_type: "refresh_token",
      }),
    ),
  );
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
