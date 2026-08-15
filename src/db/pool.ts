import { Pool } from "pg";
import "dotenv/config";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env and fill it in.\n" +
      "Locally this must be Railway's DATABASE_PUBLIC_URL, the private-network " +
      "DATABASE_URL is only reachable from inside Railway.",
  );
}

// Railway Postgres presents a self-signed certificate. Verifying it would fail,
// so outside localhost we encrypt without verifying the chain. This protects the
// password on the wire but not against an active MITM — acceptable for the TCP
// proxy, and moot in production where traffic stays on Railway's private network.
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(connectionString);

export const pool = new Pool({
  connectionString,
  ssl: isLocal ? undefined : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

// A pool-level error would otherwise crash the process on an idle-client drop,
// which Railway's proxy does routinely.
pool.on("error", (err) => {
  console.error("[db] idle client error:", err.message);
});

export async function withTransaction<T>(
  fn: (client: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
