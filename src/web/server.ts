import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { HOST, optionalEnv, PORT, PUBLIC_BASE_URL, requireEnv } from "../config.js";
import { startScheduler } from "../jobs/scheduler.js";
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
  briefGreetingName,
  briefHour,
  deleteSetting,
  getSetting,
  normalizeGreetingName,
  normalizeHour,
  normalizePhoneNumber,
  setSetting,
  SETTING_KEYS,
} from "../db/queries/settings.js";
import {
  activeBriefRules,
  addBriefRule,
  deleteBriefRule,
  deleteSenderRule,
  deleteThreadRule,
  feedbackForBriefs,
  listSenderRules,
  listThreadRules,
  missedThreads,
  recordFeedback,
  setThreadRule,
  upsertSenderRule,
  resetLearnedState,
  weightSuggestions,
  type Verdict,
} from "../db/queries/rules.js";
import { renderAccountsPage, type AdminNotice } from "./admin.js";
import { renderRulesPage } from "./rulesPage.js";
import {
  choiceById,
  isPriorityChoice,
  MUTE_DAYS,
  priorityNote,
  PROPOSED_ADJUSTMENT,
} from "./feedback.js";
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
    } else if (form.has(SETTING_KEYS.briefGreetingName)) {
      const name = normalizeGreetingName(form.get(SETTING_KEYS.briefGreetingName) ?? "");
      if (name === "") {
        await deleteSetting(SETTING_KEYS.briefGreetingName);
        query = "?saved=" + encodeURIComponent('Greeting is now just "Good morning".');
      } else {
        await setSetting(SETTING_KEYS.briefGreetingName, name);
        query = "?saved=" + encodeURIComponent(`Greeting saved: "Good morning, ${name}".`);
      }
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
 * Sync, then brief. Starts in the background and redirects immediately.
 *
 * A run takes far longer than a request should — a cold-start sync across
 * fifteen mailboxes is minutes, and the brief waits on a model call — so the
 * work runs detached and the console polls by refreshing itself.
 */
async function handleRunPost(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!sameOrigin(req)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Cross-origin form posts are refused\n");
    return;
  }

  const started = startJob(async () => {
    const { syncAll } = await import("../jobs/sync.js");
    const { runBrief } = await import("../jobs/brief.js");

    // Same rule as the scheduled worker: a sync that fails outright must not
    // cost him the brief. Postgres already holds days of thread state.
    let syncNote: string;
    try {
      const sync = await syncAll();
      syncNote =
        `Synced ${sync.synced.length} account(s)` +
        (sync.skipped.length ? `, ${sync.skipped.length} skipped` : "");
    } catch (err) {
      syncNote = `Sync failed (${err instanceof Error ? err.message : String(err)}); briefed from stored data`;
    }

    // force: the button means "now", not "if it happens to be the brief hour".
    const result = await runBrief(new Date(), { force: true });
    return `${syncNote}. ${result.message}`;
  });

  const notice = started ? "Run started" : "A run is already in progress";
  res.writeHead(303, { Location: `/?saved=${encodeURIComponent(notice)}` });
  res.end();
}


/**
 * A verdict becomes a rule.
 *
 * He picks a plain-English option; this decides which layer receives it. He
 * never has to think in points — and every rule created here is a signed
 * adjustment, never an exclusion, so a demoted sender can always be overruled by
 * enough other evidence.
 */
async function handleFeedbackPost(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!sameOrigin(req)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Cross-origin form posts are refused\n");
    return;
  }

  const form = await readFormBody(req);
  const threadKey = (form.get("thread_key") ?? "").trim();
  const choiceId = (form.get("choice") ?? "").trim();
  const briefIdRaw = Number.parseInt(form.get("brief_id") ?? "", 10);
  const briefId = Number.isInteger(briefIdRaw) ? briefIdRaw : null;

  if (!choiceId) {
    res.writeHead(303, { Location: "/briefs?error=Incomplete+feedback" });
    res.end();
    return;
  }

  // A priority is a sentence the model wrote, not a scored thread, so no rule
  // can act on it. Recorded against the priorities prompt and nothing else —
  // pretending otherwise would imply an effect that cannot exist.
  if (isPriorityChoice(choiceId)) {
    await recordFeedback({
      briefId,
      threadKey: null,
      verdict: choiceId === "priority-good" ? "good" : "badly-written",
      choice: choiceId,
      note: priorityNote(
        Number.parseInt(form.get("priority_index") ?? "0", 10),
        form.get("note") ?? "",
      ),
    });
    res.writeHead(303, {
      Location: `/briefs?saved=${encodeURIComponent("Recorded against the priorities.")}`,
    });
    res.end();
    return;
  }

  if (!threadKey) {
    res.writeHead(303, { Location: "/briefs?error=Incomplete+feedback" });
    res.end();
    return;
  }

  // The sender and the score at the time both come from the brief's stored
  // scoring snapshot rather than from recomputing: the mail has moved on since,
  // and a rule should be attributed to what he actually saw.
  let fromEmail: string | null = null;
  let scoreAtTime: number | null = Number.parseInt(form.get("score") ?? "", 10);
  if (!Number.isInteger(scoreAtTime)) scoreAtTime = null;

  if (briefId !== null) {
    const { rows } = await pool.query<{ from_email: string | null; score: number | null }>(
      `select item->>'from' as from_email, (item->>'score')::int as score
         from briefs b, jsonb_array_elements(b.payload->'scoring') item
        where b.id = $1 and item->>'threadKey' = $2
        limit 1`,
      [briefId, threadKey],
    );
    fromEmail = rows[0]?.from_email ?? null;
    scoreAtTime = rows[0]?.score ?? scoreAtTime;
  }

  // A miss reported from the outcome panel has no brief behind it — the whole
  // point is that no brief ever mentioned it — so the sender comes from the
  // thread instead.
  if (!fromEmail) {
    const [accountId, gmailThreadId] = [
      Number.parseInt(threadKey.slice(0, threadKey.indexOf(":")), 10),
      threadKey.slice(threadKey.indexOf(":") + 1),
    ];
    if (Number.isInteger(accountId)) {
      const { rows } = await pool.query<{ from_email: string | null }>(
        `select from_email from messages
          where account_id = $1 and gmail_thread_id = $2 and direction = 'inbound'
          order by sent_at desc nulls last limit 1`,
        [accountId, gmailThreadId],
      );
      fromEmail = rows[0]?.from_email ?? null;
    }
  }

  const choice = choiceById(choiceId);
  const verdict: Verdict =
    choiceId === "good"
      ? "good"
      : choiceId === "missed"
        ? "missed"
        : choiceId === "not-missed"
          ? "correctly-omitted"
          : (choice?.verdict ?? "not-important");

  await recordFeedback({
    briefId,
    threadKey,
    verdict,
    choice: choiceId,
    scoreAtTime,
  });

  let note = "Recorded.";

  switch (choiceId) {
    case "good":
      // No rule. An approval is evidence for the suggestions query, not a
      // reason to start promoting a sender on one data point.
      note = "Marked as a good call.";
      break;

    case "missed":
      if (fromEmail) {
        await upsertSenderRule({
          pattern: fromEmail,
          scope: "address",
          adjustment: PROPOSED_ADJUSTMENT.senderImportant,
          reason: "marked as missed",
          sourceBrief: briefId,
        });
        note = `Promoted ${fromEmail}. It will rank higher next time.`;
      } else {
        await setThreadRule({ threadKey, verdict: "pin", reason: "marked as missed" });
        note = "Pinned that thread.";
      }
      break;

    case "sender-noise":
      if (fromEmail) {
        await upsertSenderRule({
          pattern: fromEmail,
          scope: "address",
          adjustment: PROPOSED_ADJUSTMENT.senderNoise,
          reason: "marked as rarely important",
          sourceBrief: briefId,
        });
        note = `Demoted ${fromEmail}.`;
      }
      break;

    case "domain-noise":
      if (fromEmail?.includes("@")) {
        const domain = `@${fromEmail.slice(fromEmail.lastIndexOf("@") + 1)}`;
        await upsertSenderRule({
          pattern: domain,
          scope: "domain",
          adjustment: PROPOSED_ADJUSTMENT.domainNoise,
          reason: "whole domain marked as noise",
          sourceBrief: briefId,
        });
        note = `Demoted everything from ${domain}.`;
      }
      break;

    case "thread-handled":
      await setThreadRule({
        threadKey,
        verdict: "mute",
        expiresAt: new Date(Date.now() + MUTE_DAYS * 86_400_000),
        reason: "handled outside email",
      });
      note = `Muted that thread for ${MUTE_DAYS} days.`;
      break;

    case "not-missed":
      // No rule, deliberately. He confirmed the ranking was right to leave it
      // out, and the ranking already does that on its own — writing a rule to
      // reinforce a decision the weights reached unaided would be double
      // counting. It is recorded, so a replay can tell a correct omission from
      // an untested one.
      note = "Recorded. It was right to leave that out.";
      break;

    case "cc-noise":
    case "badly-written":
      // Recorded only. These accumulate into the suggestions query rather than
      // changing scoring on one opinion — a single verdict is not evidence that
      // a global weight is wrong.
      note = "Recorded. It will show up in suggestions once there is a pattern.";
      break;
  }

  res.writeHead(303, { Location: `/briefs?saved=${encodeURIComponent(note)}` });
  res.end();
}

async function handleRulesPost(
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

  if (path === "/rules/house") {
    const rule = (form.get("rule") ?? "").replace(/\s+/g, " ").trim();
    if (rule) await addBriefRule(rule.slice(0, 240));
    res.writeHead(303, { Location: "/rules?saved=Added." });
    res.end();
    return;
  }

  const id = Number.parseInt(form.get("id") ?? "", 10);
  const kind = form.get("kind") ?? "";
  if (Number.isInteger(id)) {
    if (kind === "sender") await deleteSenderRule(id);
    else if (kind === "thread") await deleteThreadRule(id);
    else if (kind === "house") await deleteBriefRule(id);
  }
  res.writeHead(303, { Location: "/rules?saved=Removed." });
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

/**
 * Clears everything learned, for a handover to a different person's mailboxes.
 *
 * Gated on typing the word, because it is the only irreversible button here and
 * the feedback corpus cannot be rebuilt from anything else. A misclick that
 * erases months of tuning is not recoverable by reconnecting.
 */
async function handleResetPost(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!sameOrigin(req)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Cross-origin form posts are refused\n");
    return;
  }

  const form = await readFormBody(req);
  if ((form.get("confirm") ?? "").trim().toLowerCase() !== "reset") {
    res.writeHead(303, {
      Location: "/?error=" + encodeURIComponent('Type "reset" to confirm.'),
    });
    res.end();
    return;
  }

  const counts = await resetLearnedState();
  const note =
    `Cleared ${counts.feedback} verdict${counts.feedback === 1 ? "" : "s"}, ` +
    `${counts.senderRules} sender rule${counts.senderRules === 1 ? "" : "s"}, ` +
    `${counts.threadRules} thread rule${counts.threadRules === 1 ? "" : "s"}, ` +
    `and ${counts.briefs} brief${counts.briefs === 1 ? "" : "s"}. ` +
    `Standing instructions kept.`;
  res.writeHead(303, { Location: `/?saved=${encodeURIComponent(note)}` });
  res.end();
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", PUBLIC_BASE_URL);
  const path = url.pathname;

  if (req.method === "POST") {
    const postPaths = [
      "/settings", "/run", "/accounts/disconnect", "/accounts/reset",
      "/feedback", "/rules/house", "/rules/delete",
    ];
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
    } else if (path === "/feedback") {
      await handleFeedbackPost(req, res);
    } else if (path.startsWith("/rules/")) {
      await handleRulesPost(path, req, res);
    } else if (path === "/accounts/disconnect") {
      await handleDisconnectPost(req, res);
    } else if (path === "/accounts/reset") {
      await handleResetPost(req, res);
    } else {
      await handleRunPost(req, res);
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
        ? { ok: true, message: "Recipient cleared, falling back to CLIENT_SMS_NUMBER." }
        : saved
          ? { ok: true, message: saved === "1" ? "Saved." : saved }
          : null;

    const [accounts, recipient, synced, hour, greeting] = await Promise.all([
      listAccounts(),
      getSetting(SETTING_KEYS.briefRecipient),
      lastSyncedAt(),
      briefHour(BRIEF_HOUR),
      briefGreetingName(),
    ]);

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      renderAccountsPage(
        accounts,
        recipient,
        notice,
        jobState(),
        synced,
        hour,
        greeting,
      ),
    );
    return;
  }

  if (path === "/briefs") {
    // Clamped rather than trusted: a hand-edited page number should show an
    // empty page, not throw or scan the whole table.
    const requested = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
    const page = Number.isFinite(requested) && requested > 0 ? requested : 1;

    const [total, briefs, missed] = await Promise.all([
      countBriefs(),
      listBriefs(BRIEFS_PER_PAGE, (page - 1) * BRIEFS_PER_PAGE),
      missedThreads(),
    ]);

    // Second round-trip: which of these were already judged, so the page states
    // the verdict instead of offering the buttons again. Pressing one twice
    // would count a single opinion as two votes of confidence.
    const recorded = await feedbackForBriefs(briefs.map((b) => b.id));

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderBriefsPage(briefs, page, total, missed, recorded));
    return;
  }

  if (path === "/rules") {
    const [senders, threads, house, suggestions, counted] = await Promise.all([
      listSenderRules(),
      listThreadRules(),
      activeBriefRules(),
      weightSuggestions(),
      pool.query<{ n: string }>("select count(*)::text as n from feedback"),
    ]);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      renderRulesPage(
        senders, threads, house, suggestions,
        Number(counted.rows[0]?.n ?? 0),
      ),
    );
    return;
  }

  // Scoring folded into /briefs. Kept as a redirect because it is bookmarked.
  if (path === "/scoring") {
    res.writeHead(303, { Location: "/briefs" });
    res.end();
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

  // Opt-in, so exactly one thing in a deployment drives the schedule. Started
  // after the database check: a scheduler in a process that cannot reach
  // Postgres just emails the operator every hour.
  if (optionalEnv("ENABLE_SCHEDULER", "") === "1") startScheduler();

  server.listen(PORT, HOST, () => {
    console.log(`[web] listening on ${HOST}:${PORT} (${PUBLIC_BASE_URL})`);
    if (HOST === "127.0.0.1") {
      console.log(`[web] loopback only, tunnel in with: ssh -L ${PORT}:localhost:${PORT} <user>@<host>`);
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
