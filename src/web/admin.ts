import type { Account } from "../db/queries/accounts.js";

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
  .note { margin-top: 2.5rem; font-size: .8rem; opacity: .55; max-width: 62ch; }
`;

export function renderAccountsPage(accounts: Account[]): string {
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
        </tr>`;
    })
    .join("");

  const active = accounts.filter((a) => a.status === "active").length;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ops-agent</title>
  <style>${STYLE}</style>
</head>
<body>
  <main>
    <header><h1>ops-agent</h1></header>
    <div class="sub">${active} of ${accounts.length} account${accounts.length === 1 ? "" : "s"} healthy</div>

    ${
      accounts.length === 0
        ? `<div class="empty">No accounts connected yet.</div>`
        : `<table>
             <thead>
               <tr><th>Account</th><th>Status</th><th>Last sync</th><th>Connected</th></tr>
             </thead>
             <tbody>${rows}</tbody>
           </table>`
    }

    <a class="btn" href="/connect">Connect account</a>

    <p class="note">
      Read-only access to Gmail and Calendar. Reconnecting an account in
      <span class="pill bad">auth error</span> repairs it — the morning brief keeps
      working meanwhile and names any account it had to skip.
    </p>
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
