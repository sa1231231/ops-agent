import { pool } from "../pool.js";
import { encrypt } from "../../auth/crypto.js";
import type { TokenSet } from "../../auth/google.js";

export type AccountStatus = "active" | "auth_error" | "disabled";

export interface Account {
  id: number;
  email: string;
  domain: string;
  status: AccountStatus;
  scopes: string[];
  gmail_history_id: string | null;
  last_sync_at: Date | null;
  last_error: string | null;
  connected_at: Date;
}

/** Everything after the "@". Recorded for display only — never for branching. */
export function domainOf(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}

/**
 * Inserts a newly-authorized account, or re-arms an existing one.
 *
 * Reconnecting is the documented fix for a revoked or expired grant, so this
 * must clear `status` and `last_error` — otherwise an account stays red on the
 * console after a successful repair.
 */
export async function upsertAccount(
  email: string,
  tokens: TokenSet,
): Promise<Account> {
  const { rows } = await pool.query<Account>(
    `insert into accounts (
       email, domain, status, access_token_enc, refresh_token_enc,
       token_expires_at, scopes, last_error, connected_at, updated_at
     )
     values ($1, $2, 'active', $3, $4, $5, $6, null, now(), now())
     on conflict (email) do update set
       status            = 'active',
       access_token_enc  = excluded.access_token_enc,
       refresh_token_enc = excluded.refresh_token_enc,
       token_expires_at  = excluded.token_expires_at,
       scopes            = excluded.scopes,
       last_error        = null,
       updated_at        = now()
     returning id, email, domain, status, scopes, gmail_history_id,
               last_sync_at, last_error, connected_at`,
    [
      email,
      domainOf(email),
      encrypt(tokens.accessToken),
      tokens.refreshToken ? encrypt(tokens.refreshToken) : null,
      tokens.expiresAt,
      tokens.scope.split(/\s+/).filter(Boolean),
    ],
  );

  const account = rows[0];
  if (!account) throw new Error("upsertAccount returned no row");
  return account;
}

export async function listAccounts(): Promise<Account[]> {
  const { rows } = await pool.query<Account>(
    `select id, email, domain, status, scopes, gmail_history_id,
            last_sync_at, last_error, connected_at
       from accounts
      order by domain, email`,
  );
  return rows;
}

export async function markAccountError(
  accountId: number,
  message: string,
): Promise<void> {
  await pool.query(
    `update accounts
        set status = 'auth_error', last_error = $2, updated_at = now()
      where id = $1`,
    [accountId, message.slice(0, 1000)],
  );
}

/**
 * Most recent successful sync across all accounts.
 *
 * Read from the accounts table rather than the in-memory job state so it
 * survives a restart and reflects the scheduled worker too, not just runs
 * triggered from the console.
 */
export async function lastSyncedAt(): Promise<Date | null> {
  const { rows } = await pool.query<{ at: Date | null }>(
    "select max(last_sync_at) as at from accounts",
  );
  return rows[0]?.at ?? null;
}
