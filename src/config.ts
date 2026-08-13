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
export const PUBLIC_BASE_URL = optionalEnv(
  "PUBLIC_BASE_URL",
  `http://localhost:${PORT}`,
);

/** Cold start looks back this many days. Hard constant — never widen it. */
export const COLD_START_DAYS = 7;

/** Sent-metadata lookback used to build the correspondent graph. */
export const SENT_GRAPH_DAYS = 90;

/** Per-account caps, so one enormous mailbox cannot stall a whole sync cycle. */
export const MAX_INBOX_MESSAGES_PER_ACCOUNT = 500;
export const MAX_SENT_MESSAGES_PER_ACCOUNT = 2000;
