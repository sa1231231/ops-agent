import { pool } from "../db/pool.js";
import { decrypt, encrypt } from "./crypto.js";
import { refreshAccessToken } from "./google.js";

/**
 * Hands out a usable access token for an account, refreshing and persisting
 * when the stored one has expired.
 *
 * Sync touches ~15 accounts every 20 minutes, so tokens expire constantly.
 * Centralizing refresh here means callers never think about expiry, and a
 * revoked grant surfaces as one recognizable error type rather than an opaque
 * 401 from whichever API happened to be called first.
 */

export class TokenRevokedError extends Error {
  constructor(
    readonly accountId: number,
    readonly email: string,
    cause: string,
  ) {
    super(`Google refused to refresh the token for ${email}: ${cause}`);
    this.name = "TokenRevokedError";
  }
}

interface TokenRow {
  email: string;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  token_expires_at: Date | null;
}

// Refresh a little early: a token that expires mid-request would fail a call
// that was valid when it started.
const EXPIRY_SKEW_MS = 60_000;

export async function getAccessToken(accountId: number): Promise<string> {
  const { rows } = await pool.query<TokenRow>(
    `select email, access_token_enc, refresh_token_enc, token_expires_at
       from accounts where id = $1`,
    [accountId],
  );

  const row = rows[0];
  if (!row) throw new Error(`No account with id ${accountId}`);

  const stillValid =
    row.access_token_enc &&
    row.token_expires_at &&
    row.token_expires_at.getTime() - EXPIRY_SKEW_MS > Date.now();

  if (stillValid && row.access_token_enc) {
    return decrypt(row.access_token_enc);
  }

  if (!row.refresh_token_enc) {
    throw new TokenRevokedError(
      accountId,
      row.email,
      "no refresh token stored, reconnect this account",
    );
  }

  let fresh;
  try {
    fresh = await refreshAccessToken(decrypt(row.refresh_token_enc));
  } catch (err) {
    // invalid_grant means revoked, password-changed, or consent withdrawn.
    // Not retryable — the account needs a human to reconnect it.
    throw new TokenRevokedError(
      accountId,
      row.email,
      err instanceof Error ? err.message : String(err),
    );
  }

  await pool.query(
    `update accounts
        set access_token_enc = $2,
            token_expires_at = $3,
            -- Google only returns refresh_token on the initial exchange, so
            -- keep the existing one unless it actually rotated.
            refresh_token_enc = coalesce($4, refresh_token_enc),
            updated_at = now()
      where id = $1`,
    [
      accountId,
      encrypt(fresh.accessToken),
      fresh.expiresAt,
      fresh.refreshToken ? encrypt(fresh.refreshToken) : null,
    ],
  );

  return fresh.accessToken;
}
