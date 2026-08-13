import type { Account } from "../db/queries/accounts.js";
import { BRIEF_TZ, formatLocalDateTime, timeZoneLabel } from "../time.js";
import type { JobState } from "./jobs.js";

/** Everything rendered here is server-side; there is no client JS and no build. */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function relativeTime(date: Date | null): string {
  if (!date) return "never";
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** A sync that has not run in this long is stale even if it never errored. */
const STALE_SYNC_MS = 90 * 60 * 1000;

function statusOf(account: Account): { label: string; cls: string } {
  if (account.status === "auth_error") return { label: "auth error", cls: "bad" };
  if (account.status === "disabled") return { label: "disabled", cls: "off" };
  if (!account.last_sync_at) return { label: "never synced", cls: "warn" };
  if (Date.now() - account.last_sync_at.getTime() > STALE_SYNC_MS) {
    return { label: "stale", cls: "warn" };
  }
  return { label: "active", cls: "ok" };
}

const STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    margin: 0; padding: 2.5rem 1.5rem; background: Canvas; color: CanvasText;
  }
  main { max-width: 1000px; margin: 0 auto; }
  header { display: flex; align-items: baseline; gap: 1rem; margin-bottom: .35rem; }
  h1 { font-size: 1.35rem; margin: 0; letter-spacing: -.01em; }
  .sub { opacity: .6; font-size: .875rem; margin-bottom: 1.75rem; }
  table { width: 100%; border-collapse: collapse; }
  th {
    text-align: left; font-size: .7rem; text-transform: uppercase;
    letter-spacing: .06em; opacity: .55; padding: 0 .75rem .5rem; font-weight: 600;
  }
  td { padding: .7rem .75rem; border-top: 1px solid color-mix(in srgb, CanvasText 12%, transparent); }
  td.email { font-weight: 500; }
  .domain { opacity: .55; font-size: .8rem; }
  .pill {
    display: inline-block; padding: .12rem .5rem; border-radius: 999px;
    font-size: .72rem; font-weight: 600; white-space: nowrap;
  }
  .ok   { background: color-mix(in srgb, #16a34a 18%, transparent); color: #15803d; }
  .warn { background: color-mix(in srgb, #d97706 20%, transparent); color: #b45309; }
  .bad  { background: color-mix(in srgb, #dc2626 18%, transparent); color: #b91c1c; }
  .off  { background: color-mix(in srgb, CanvasText 10%, transparent); opacity: .7; }
  @media (prefers-color-scheme: dark) {
    .ok { color: #4ade80; } .warn { color: #fbbf24; } .bad { color: #f87171; }
  }
  .err {
    font-size: .78rem; color: #b91c1c; margin-top: .25rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    overflow-wrap: anywhere;
  }
  @media (prefers-color-scheme: dark) { .err { color: #f87171; } }
  a.btn {
    display: inline-block; margin-top: 1.75rem; padding: .5rem .9rem;
    border-radius: 7px; background: CanvasText; color: Canvas;
    text-decoration: none; font-weight: 600; font-size: .875rem;
  }
  .empty { padding: 2.5rem 0; opacity: .6; }
  a.nav { font-size: .85rem; opacity: .7; text-decoration: none; margin-left: auto; }
  a.nav:hover { opacity: 1; }
  .note { margin-top: 2.5rem; font-size: .8rem; opacity: .55; max-width: 62ch; }
  .settings {
    margin-top: 2.5rem; padding-top: 1.75rem;
    border-top: 1px solid color-mix(in srgb, CanvasText 12%, transparent);
  }
  .settings h2 {
    font-size: .72rem; text-transform: uppercase; letter-spacing: .06em;
    opacity: .55; margin: 0 0 .9rem; font-weight: 700;
  }
  label { display: block; font-size: .85rem; margin-bottom: .35rem; }
  .row { display: flex; gap: .5rem; max-width: 420px; }
  input {
    flex: 1; padding: .5rem .65rem; font: inherit; font-size: .9rem;
    border: 1px solid color-mix(in srgb, CanvasText 25%, transparent);
    border-radius: 6px; background: Canvas; color: CanvasText;
  }
  button {
    padding: .5rem .95rem; font: inherit; font-size: .875rem; font-weight: 600;
    border: 0; border-radius: 6px; background: CanvasText; color: Canvas; cursor: pointer;
  }
  .hint { font-size: .78rem; opacity: .5; margin: .55rem 0 0; max-width: 52ch; }
  .ok-note { font-size: .82rem; color: #15803d; margin: .55rem 0 0; }
  @media (prefers-color-scheme: dark) { .ok-note { color: #4ade80; } }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .95em; }
  .actions { display: flex; gap: .5rem; flex-wrap: wrap; }
  .actions form { margin: 0; display: flex; flex-direction: column; gap: .3rem; }
  .caption { font-size: .72rem; opacity: .45; }
  td.act { text-align: right; white-space: nowrap; }
  td.act form { margin: 0; }
  .linkbtn {
    background: none; border: 0; padding: 0; color: #b91c1c;
    font: inherit; font-size: .82rem; cursor: pointer; text-decoration: underline;
  }
  @media (prefers-color-scheme: dark) { .linkbtn { color: #f87171; } }
  a.link { font-size: .82rem; }
  select {
    padding: .5rem .65rem; font: inherit; font-size: .9rem;
    border: 1px solid color-mix(in srgb, CanvasText 25%, transparent);
    border-radius: 6px; background: Canvas; color: CanvasText;
  }
  button:disabled { opacity: .4; cursor: not-allowed; }
  button.danger { background: #b91c1c; color: #fff; }
  .job {
    margin-top: 1rem; padding: .75rem .9rem; border-radius: 8px;
    border: 1px solid color-mix(in srgb, CanvasText 12%, transparent);
  }
  .job-head { display: flex; align-items: center; gap: .6rem; }
  .job-when { margin-left: auto; font-size: .78rem; opacity: .5; }
  .job-sum { font-size: .85rem; opacity: .75; margin-top: .45rem; }
  pre.preview {
    margin: .6rem 0 0; padding: .7rem .85rem; border-radius: 6px; overflow-x: auto;
    background: color-mix(in srgb, CanvasText 6%, transparent);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: .78rem; line-height: 1.5; white-space: pre-wrap; word-break: break-word;
  }
`;

export interface AdminNotice {
  ok: boolean;
  message: string;
}

export interface JobPanel {
  sync: JobState;
  brief: JobState;
}

function relativeAgo(date: Date | null): string {
  return date ? relativeTime(date) : "never";
}

/** Absolute timestamp plus relative age: one answers "when", the other "how stale". */
function lastSyncedLabel(at: Date | null): string {
  if (!at) return "Never synced";
  return `Last synced ${formatLocalDateTime(at)} (${relativeTime(at)})`;
}

function renderJob(name: string, label: string, job: JobState): string {
  const status = job.running
    ? `<span class="pill warn">running…</span>`
    : job.error
      ? `<span class="pill bad">failed</span>`
      : job.summary
        ? `<span class="pill ok">ok</span>`
        : `<span class="pill off">idle</span>`;

  return `
    <div class="job">
      <div class="job-head">
        <strong>${escapeHtml(label)}</strong>
        ${status}
        <span class="job-when">${escapeHtml(relativeAgo(job.finishedAt ?? job.startedAt))}</span>
      </div>
      ${job.error ? `<div class="err">${escapeHtml(job.error)}</div>` : ""}
      ${job.summary ? `<div class="job-sum">${escapeHtml(job.summary)}</div>` : ""}
      ${job.detail ? `<pre class="preview">${escapeHtml(job.detail)}</pre>` : ""}
    </div>`;
}

export function renderAccountsPage(
  accounts: Account[],
  recipient: string | null = null,
  notice: AdminNotice | null = null,
  jobs: JobPanel | null = null,
  lastSynced: Date | null = null,
  briefHourValue = 6,
): string {
  const zone = timeZoneLabel();
  const rows = accounts
    .map((account) => {
      const status = statusOf(account);
      return `
        <tr>
          <td class="email">
            ${escapeHtml(account.email)}
            <div class="domain">${escapeHtml(account.domain)}</div>
          </td>
          <td>
            <span class="pill ${status.cls}">${status.label}</span>
            ${account.last_error ? `<div class="err">${escapeHtml(account.last_error)}</div>` : ""}
          </td>
          <td>${relativeTime(account.last_sync_at)}</td>
          <td>${relativeTime(account.connected_at)}</td>
          <td class="act">${
            account.status === "disabled"
              ? `<a class="link" href="/connect">Reconnect</a>`
              : `<form method="post" action="/accounts/disconnect">
                   <input type="hidden" name="account_id" value="${account.id}">
                   <button type="submit" class="linkbtn">Disconnect</button>
                 </form>`
          }</td>
        </tr>`;
    })
    .join("");

  const active = accounts.filter((a) => a.status === "active").length;
  const busy = Boolean(jobs && (jobs.sync.running || jobs.brief.running));

  const jobSection = jobs
    ? `
    <section class="settings">
      <h2>Run now</h2>
      <div class="actions">
        <form method="post" action="/run/sync">
          <button type="submit" ${jobs.sync.running ? "disabled" : ""}>Sync accounts</button>
          <div class="caption">${escapeHtml(lastSyncedLabel(lastSynced))}</div>
        </form>
        <form method="post" action="/run/brief">
          <input type="hidden" name="mode" value="preview">
          <button type="submit" ${busy ? "disabled" : ""}>Preview brief</button>
          <div class="caption">Composes and discards</div>
        </form>
        <form method="post" action="/run/brief">
          <input type="hidden" name="mode" value="send">
          <button type="submit" class="danger" ${busy ? "disabled" : ""}>Send brief now</button>
          <div class="caption">Real SMS, once per day</div>
        </form>
      </div>
      ${renderJob("sync", "Sync", jobs.sync)}
      ${renderJob("brief", "Brief", jobs.brief)}
    </section>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ops-agent</title>
  ${busy ? '<meta http-equiv="refresh" content="4">' : ""}
  <style>${STYLE}</style>
</head>
<body>
  <main>
    <header><h1>ops-agent</h1><a class="nav" href="/briefs">Brief history →</a></header>
    <div class="sub">${active} of ${accounts.length} account${accounts.length === 1 ? "" : "s"} healthy</div>

    ${
      accounts.length === 0
        ? `<div class="empty">No accounts connected yet.</div>`
        : `<table>
             <thead>
               <tr><th>Account</th><th>Status</th><th>Last sync</th><th>Connected</th><th></th></tr>
             </thead>
             <tbody>${rows}</tbody>
           </table>`
    }

    <a class="btn" href="/connect">Connect account</a>

    <section class="settings">
      <h2>Morning brief</h2>
      <form method="post" action="/settings">
        <label for="recipient">Delivered by SMS to</label>
        <div class="row">
          <input id="recipient" name="brief_recipient_sms" type="tel"
                 value="${escapeHtml(recipient ?? "")}"
                 placeholder="+15715551234" autocomplete="tel">
          <button type="submit">Save</button>
        </div>
        ${
          notice
            ? `<p class="${notice.ok ? "ok-note" : "err"}">${escapeHtml(notice.message)}</p>`
            : ""
        }
        <p class="hint">
          E.164 format. A bare 10-digit US number is accepted and normalised.
          ${recipient ? "" : "Falling back to <code>CLIENT_SMS_NUMBER</code> until set."}
        </p>
      </form>

      <form method="post" action="/settings" style="margin-top:1.4rem">
        <label for="hour">Sent at</label>
        <div class="row">
          <select id="hour" name="brief_hour">
            ${Array.from({ length: 24 }, (_, h) => {
              const label = `${String(h).padStart(2, "0")}:00 ${zone}`;
              return `<option value="${h}"${h === briefHourValue ? " selected" : ""}>${label}</option>`;
            }).join("")}
          </select>
          <button type="submit">Save</button>
        </div>
        <p class="hint">${escapeHtml(BRIEF_TZ)}</p>
      </form>
    </section>
    ${jobSection}
  </main>
</body>
</html>`;
}

export function renderMessagePage(
  title: string,
  body: string,
  ok: boolean,
): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} — ops-agent</title>
  <style>${STYLE}</style>
</head>
<body>
  <main>
    <header><h1>${escapeHtml(title)}</h1></header>
    <p class="${ok ? "" : "err"}">${escapeHtml(body)}</p>
    <a class="btn" href="/">Back to accounts</a>
  </main>
</body>
</html>`;
}
