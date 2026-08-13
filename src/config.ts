import "dotenv/config";

/** Required env var. Throws at first use rather than yielding `undefined`. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

export function optionalEnv(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export const PORT = Number(optionalEnv("PORT", "3000"));

/**
 * Loopback by default. This runs on a public VPS, and binding to all interfaces
 * would put the admin console on the open internet behind nothing but Basic auth
 * over plain HTTP. Reach it locally over an SSH tunnel instead:
 *
 *   ssh -L 3000:localhost:3000 <user>@<host>
 *
 * That also keeps the OAuth redirect URI on localhost, which is the only host
 * for which Google permits a plain http:// redirect.
 *
 * Railway terminates TLS and routes to the container, so set HOST=0.0.0.0 there.
 */
export const HOST = optionalEnv("HOST", "127.0.0.1");
export const PUBLIC_BASE_URL = optionalEnv(
  "PUBLIC_BASE_URL",
  `http://localhost:${PORT}`,
);

/** Cold start looks back this many days. Hard constant — never widen it. */
export const COLD_START_DAYS = 7;

/** Sent-metadata lookback used to build the correspondent graph. */
export const SENT_GRAPH_DAYS = 90;

/**
 * Briefs are kept this long, then deleted.
 *
 * Long enough to spot ranking drift across a few weeks, short enough that the
 * table does not accumulate message content indefinitely. Matches the share
 * link's own 30-day expiry, so a live link never points at a deleted brief.
 */
export const BRIEF_RETENTION_DAYS = 30;

/** Per-account caps, so one enormous mailbox cannot stall a whole sync cycle. */
export const MAX_INBOX_MESSAGES_PER_ACCOUNT = 500;
export const MAX_SENT_MESSAGES_PER_ACCOUNT = 2000;
