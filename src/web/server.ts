import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { HOST, PORT, PUBLIC_BASE_URL, requireEnv } from "../config.js";
import { assertEncryptionReady } from "../auth/crypto.js";
import { pool } from "../db/pool.js";
import { listAccounts } from "../db/queries/accounts.js";
import { getBriefByToken } from "../db/queries/briefs.js";
import {
  deleteSetting,
  getSetting,
  normalizePhoneNumber,
  setSetting,
  SETTING_KEYS,
} from "../db/queries/settings.js";
import { renderAccountsPage, type AdminNotice } from "./admin.js";
import { renderBriefPage, type BriefPayload } from "./briefPage.js";
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

/**
 * Basic auth credentials are cached by the browser and replayed on cross-origin
 * form posts, so authentication alone does not stop CSRF. Requiring a matching
 * Origin does, and costs nothing for a same-origin form.
 */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(PUBLIC_BASE_URL).origin;
  } catch {
    return false;
  }
}

const MAX_BODY_BYTES = 8 * 1024;

async function readFormBody(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

async function handleSettingsPost(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!sameOrigin(req)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Cross-origin form posts are refused\n");
    return;
  }

  const form = await readFormBody(req);
  const raw = (form.get(SETTING_KEYS.briefRecipient) ?? "").trim();

  let query: string;
  try {
    if (raw === "") {
      await deleteSetting(SETTING_KEYS.briefRecipient);
      query = "?saved=cleared";
    } else {
      // Validating on save turns a bad number into a form error instead of a
      // failed brief at 6:30am.
      await setSetting(SETTING_KEYS.briefRecipient, normalizePhoneNumber(raw));
      query = "?saved=1";
    }
  } catch (err) {
    query = `?error=${encodeURIComponent(err instanceof Error ? err.message : "Invalid value")}`;
  }

  // POST-redirect-GET, so a refresh does not resubmit.
  res.writeHead(303, { Location: `/${query}` });
  res.end();
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", PUBLIC_BASE_URL);
  const path = url.pathname;

  if (req.method === "POST") {
    if (path !== "/settings") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found\n");
      return;
    }
    if (!isAuthorized(req)) {
      challenge(res);
      return;
    }
    await handleSettingsPost(req, res);
    return;
  }

  if (req.method !== "GET") {
    res.writeHead(405, { Allow: "GET, POST" });
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

  // The brief page is linked from the message and must open without a login —
  // he reads it on a phone at 6:30am. The token is unguessable and expiring, and
  // grants nothing beyond one already-composed brief.
  const briefMatch = /^\/brief\/([A-Za-z0-9_-]{16,64})$/.exec(path);
  if (briefMatch?.[1]) {
    const brief = await getBriefByToken(briefMatch[1]);
    if (!brief?.payload) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found\n");
      return;
    }
    const { rows } = await pool.query<{ skipped_accounts: string[] }>(
      "select skipped_accounts from briefs where id = $1",
      [brief.id],
    );
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
    });
    res.end(
      renderBriefPage(
        brief.local_date,
        brief.payload as BriefPayload,
        rows[0]?.skipped_accounts ?? [],
      ),
    );
    return;
  }

  if (!isAuthorized(req)) {
    challenge(res);
    return;
  }

  if (path === "/") {
    const saved = url.searchParams.get("saved");
    const error = url.searchParams.get("error");
    const notice: AdminNotice | null = error
      ? { ok: false, message: error }
      : saved === "cleared"
        ? { ok: true, message: "Recipient cleared — falling back to CLIENT_SMS_NUMBER." }
        : saved
          ? { ok: true, message: "Saved." }
          : null;

    const [accounts, recipient] = await Promise.all([
      listAccounts(),
      getSetting(SETTING_KEYS.briefRecipient),
    ]);

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderAccountsPage(accounts, recipient, notice));
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
