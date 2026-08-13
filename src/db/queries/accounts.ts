import { pool, withTransaction } from "../pool.js";
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

/**
 * Disconnects an account and erases what was read from it.
 *
 * The row itself stays, marked `disabled`, so the console keeps a record and so
 * reconnecting the same address later is an ordinary upsert rather than a
 * conflict. Everything derived from the mailbox goes: messages, threads, the
 * correspondent graph, and calendar events — "no longer using it" has to mean
 * the data stops influencing ranking, not just that syncing stops.
 *
 * gmail_history_id is cleared too, so a future reconnect cold-starts cleanly
 * instead of resuming from a cursor whose messages were deleted.
 */
export async function disconnectAccount(accountId: number): Promise<void> {
  await withTransaction(async (client) => {
    await client.query("delete from messages where account_id = $1", [accountId]);
    await client.query("delete from threads where account_id = $1", [accountId]);
    await client.query("delete from correspondents where account_id = $1", [accountId]);
    await client.query("delete from events where account_id = $1", [accountId]);
    await client.query(
      `update accounts
          set status = 'disabled',
              access_token_enc = null,
              refresh_token_enc = null,
              token_expires_at = null,
              gmail_history_id = null,
              last_error = null,
              last_sync_at = null,
              updated_at = now()
        where id = $1`,
      [accountId],
    );
  });
}

export async function getAccountTokens(
  accountId: number,
): Promise<{ email: string; refresh_token_enc: string | null } | null> {
  const { rows } = await pool.query<{ email: string; refresh_token_enc: string | null }>(
    "select email, refresh_token_enc from accounts where id = $1",
    [accountId],
  );
  return rows[0] ?? null;
}
