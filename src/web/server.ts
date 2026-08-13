import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { HOST, PORT, PUBLIC_BASE_URL, requireEnv } from "../config.js";
import { assertEncryptionReady } from "../auth/crypto.js";
import { pool } from "../db/pool.js";
import { listAccounts } from "../db/queries/accounts.js";
import { renderAccountsPage } from "./admin.js";
import { handleCallback, handleConnect } from "./oauth.js";

/**
 * Admin console: server-rendered, no framework, no client JS, no build step.
 * Everything else the client ever sees is the WhatsApp message.
 */

/** Constant-time compare over digests, so inputs of any length are safe. */
function secretMatches(candidate: string, expected: string): boolean {
  const a = createHash("sha256").update(candidate).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function isAuthorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (!header?.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  // Username is ignored; the password carries the secret.
  const password = decoded.slice(decoded.indexOf(":") + 1);
  return secretMatches(password, requireEnv("ADMIN_SECRET"));
}

function challenge(res: ServerResponse): void {
  res.writeHead(401, {
    "WWW-Authenticate": 'Basic realm="ops-agent", charset="UTF-8"',
    "Content-Type": "text/plain; charset=utf-8",
  });
  res.end("Authentication required\n");
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", PUBLIC_BASE_URL);
  const path = url.pathname;

  if (req.method !== "GET") {
    res.writeHead(405, { Allow: "GET" });
    res.end();
    return;
  }

  // Unauthenticated: liveness, and the OAuth callback. The callback is
  // protected instead by a single-use `state` that only /connect can mint.
  if (path === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok\n");
    return;
  }

  if (path === "/oauth/callback") {
    await handleCallback(url, res);
    return;
  }

  if (!isAuthorized(req)) {
    challenge(res);
    return;
  }

  if (path === "/") {
    const html = renderAccountsPage(await listAccounts());
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (path === "/connect") {
    handleConnect(res);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found\n");
}

const server = createServer((req, res) => {
  route(req, res).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[web] unhandled:", message);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "text/plain" });
    }
    res.end("Internal error\n");
  });
});

async function main(): Promise<void> {
  // Fail at boot rather than at first connect, when a user is mid-consent.
  assertEncryptionReady();
  requireEnv("ADMIN_SECRET");
  requireEnv("GOOGLE_CLIENT_ID");
  requireEnv("GOOGLE_CLIENT_SECRET");
  requireEnv("OAUTH_REDIRECT_URI");
  await pool.query("select 1");

  server.listen(PORT, HOST, () => {
    console.log(`[web] listening on ${HOST}:${PORT} (${PUBLIC_BASE_URL})`);
    if (HOST === "127.0.0.1") {
      console.log(`[web] loopback only — tunnel in with: ssh -L ${PORT}:localhost:${PORT} <user>@<host>`);
    }
  });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      void pool.end().then(() => process.exit(0));
    });
  });
}

main().catch((err: unknown) => {
  console.error("[web] failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
});
