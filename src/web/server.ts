import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { HOST, PORT, PUBLIC_BASE_URL, requireEnv } from "../config.js";
import { BRIEF_HOUR } from "../time.js";
import { assertEncryptionReady } from "../auth/crypto.js";
import { pool } from "../db/pool.js";
import {
  disconnectAccount,
  getAccountTokens,
  lastSyncedAt,
  listAccounts,
} from "../db/queries/accounts.js";
import { decrypt } from "../auth/crypto.js";
import { revokeToken } from "../auth/google.js";
import {
  countBriefs,
  getBriefByToken,
  listBriefs,
} from "../db/queries/briefs.js";
import {
  briefHour,
  deleteSetting,
  getSetting,
  normalizeHour,
  normalizePhoneNumber,
  setSetting,
  SETTING_KEYS,
} from "../db/queries/settings.js";
import { renderAccountsPage, type AdminNotice } from "./admin.js";
import { jobState, startJob } from "./jobs.js";
import { renderBriefPage, type BriefPayload } from "./briefPage.js";
import { BRIEFS_PER_PAGE, renderBriefsPage } from "./briefsPage.js";
import { handleCallback, handleConnect } from "./oauth.js";

/**
 * Admin console: server-rendered, no framework, no client JS, no build step.
 * Everything else the client ever sees is the morning message.
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

  let query: string;
  try {
    // One endpoint, two independent forms: each posts only its own field, so
    // saving the hour must not wipe the recipient.
    if (form.has(SETTING_KEYS.briefHour)) {
      await setSetting(
        SETTING_KEYS.briefHour,
        normalizeHour(form.get(SETTING_KEYS.briefHour) ?? ""),
      );
      query = "?saved=" + encodeURIComponent("Brief time saved.");
    } else {
      const raw = (form.get(SETTING_KEYS.briefRecipient) ?? "").trim();
      if (raw === "") {
        await deleteSetting(SETTING_KEYS.briefRecipient);
        query = "?saved=cleared";
      } else {
        // Validating on save turns a bad number into a form error instead of a
        // failed brief at 6am.
        await setSetting(SETTING_KEYS.briefRecipient, normalizePhoneNumber(raw));
        query = "?saved=1";
      }
    }
  } catch (err) {
    query = `?error=${encodeURIComponent(err instanceof Error ? err.message : "Invalid value")}`;
  }

  // POST-redirect-GET, so a refresh does not resubmit.
  res.writeHead(303, { Location: `/${query}` });
  res.end();
}

/**
 * Starts a job and redirects immediately.
 *
 * These take far longer than a request should — a cold-start sync across
 * fifteen mailboxes is minutes, and the brief waits on a model call — so the
 * work runs in the background and the console polls by refreshing itself.
 */
async function handleRunPost(
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!sameOrigin(req)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Cross-origin form posts are refused\n");
    return;
  }

  const form = await readFormBody(req);
  let started: boolean;
  let label: string;

  if (path === "/run/sync") {
    label = "Sync";
    started = startJob("sync", async () => {
      const { syncAll } = await import("../jobs/sync.js");
      const summary = await syncAll();
      return {
        summary:
          `${summary.synced.length} account(s) synced` +
          (summary.skipped.length ? `, ${summary.skipped.length} skipped` : ""),
        detail: summary.skipped.length
          ? summary.skipped.map((s) => `${s.email}: ${s.reason}`).join("\n")
          : undefined,
      };
    });
  } else {
    const preview = form.get("mode") !== "send";
    label = preview ? "Preview" : "Send";
    started = startJob("brief", async () => {
      const { runBrief } = await import("../jobs/brief.js");
      // force: the console button means "now", not "if it happens to be 6am".
      const result = await runBrief(new Date(), { dryRun: preview, force: true });
      return { summary: result.message, detail: result.text };
    });
  }

  const notice = started
    ? `${label} started`
    : `${label} is already running`;
  res.writeHead(303, { Location: `/?saved=${encodeURIComponent(notice)}` });
  res.end();
}

/**
 * Disconnects an account: revokes at Google, then erases everything read from
 * it. The row survives, marked disabled, so reconnecting the same address later
 * is an ordinary upsert.
 */
async function handleDisconnectPost(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!sameOrigin(req)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Cross-origin form posts are refused\n");
    return;
  }

  const form = await readFormBody(req);
  const accountId = Number.parseInt(form.get("account_id") ?? "", 10);
  if (!Number.isInteger(accountId)) {
    res.writeHead(303, { Location: "/?error=Invalid+account" });
    res.end();
    return;
  }

  const account = await getAccountTokens(accountId);

  // Best effort, and deliberately before the local wipe: telling Google is what
  // makes the access actually gone rather than merely unused. A failure here
  // must not block the disconnect.
  let revoked = false;
  if (account?.refresh_token_enc) {
    try {
      revoked = await revokeToken(decrypt(account.refresh_token_enc));
    } catch (err) {
      console.error("[disconnect] revoke failed:", err instanceof Error ? err.message : err);
    }
  }

  await disconnectAccount(accountId);

  const note = `Disconnected ${account?.email ?? "account"}${
    revoked ? " and revoked access at Google" : ""
  }. Stored mail and calendar data erased.`;
  res.writeHead(303, { Location: `/?saved=${encodeURIComponent(note)}` });
  res.end();
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", PUBLIC_BASE_URL);
  const path = url.pathname;

  if (req.method === "POST") {
    const postPaths = ["/settings", "/run/sync", "/run/brief", "/accounts/disconnect"];
    if (!postPaths.includes(path)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found\n");
      return;
    }
    if (!isAuthorized(req)) {
      challenge(res);
      return;
    }
    if (path === "/settings") {
      await handleSettingsPost(req, res);
    } else if (path === "/accounts/disconnect") {
      await handleDisconnectPost(req, res);
    } else {
      await handleRunPost(path, req, res);
    }
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
          ? { ok: true, message: saved === "1" ? "Saved." : saved }
          : null;

    const [accounts, recipient, synced, hour] = await Promise.all([
      listAccounts(),
      getSetting(SETTING_KEYS.briefRecipient),
      lastSyncedAt(),
      briefHour(BRIEF_HOUR),
    ]);

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      renderAccountsPage(
        accounts,
        recipient,
        notice,
        { sync: jobState("sync"), brief: jobState("brief") },
        synced,
        hour,
      ),
    );
    return;
  }

  if (path === "/briefs") {
    // Clamped rather than trusted: a hand-edited page number should show an
    // empty page, not throw or scan the whole table.
    const requested = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
    const page = Number.isFinite(requested) && requested > 0 ? requested : 1;

    const [total, briefs] = await Promise.all([
      countBriefs(),
      listBriefs(BRIEFS_PER_PAGE, (page - 1) * BRIEFS_PER_PAGE),
    ]);

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderBriefsPage(briefs, page, total));
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
