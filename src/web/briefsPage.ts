import { BRIEF_RETENTION_DAYS } from "../config.js";
import type { BriefSummary } from "../db/queries/briefs.js";
import type { ScoredThread } from "../signals/score.js";
import { formatLocalTime } from "../time.js";
import { escapeHtml } from "./admin.js";
import type { LegacyComposed } from "./briefPage.js";
import { renderScoringSection, SCORING_STYLE } from "./scoringPage.js";
import { NOT_IMPORTANT_CHOICES, OTHER_CHOICES } from "./feedback.js";

/**
 * Briefs: what was sent, and why it was chosen.
 *
 * One page rather than two. The history is for comparison — seeing a week of
 * mornings side by side is how you notice the same item keeps surfacing, or that
 * ranking drifted after a weight change — and the live scoring above it is what
 * you change in response. Splitting them meant reading one and remembering it
 * while looking at the other.
 */

export const BRIEFS_PER_PAGE = 10;

interface StoredPayload {
  composed?: LegacyComposed;
  meetings?: string[];
  conflicts?: string[];
  text?: string;
  error?: string;
}

const STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    margin: 0; padding: 2.5rem 1.5rem 4rem; background: Canvas; color: CanvasText;
  }
  main { max-width: 860px; margin: 0 auto; }
  header { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; }
  h1 { font-size: 1.35rem; margin: 0; letter-spacing: -.01em; }
  a { color: inherit; }
  .sub { opacity: .6; font-size: .875rem; margin: .3rem 0 2rem; }
  .card {
    border: 1px solid color-mix(in srgb, CanvasText 13%, transparent);
    border-radius: 10px; padding: 1.1rem 1.25rem; margin-bottom: 1rem;
  }
  .card-head {
    display: flex; align-items: baseline; gap: .7rem; flex-wrap: wrap;
    margin-bottom: .85rem;
  }
  .date { font-weight: 650; font-size: 1.02rem; }
  .meta { opacity: .5; font-size: .78rem; margin-left: auto; }
  .pill {
    display: inline-block; padding: .12rem .5rem; border-radius: 999px;
    font-size: .7rem; font-weight: 700; text-transform: uppercase; letter-spacing: .04em;
  }
  .sent   { background: color-mix(in srgb, #16a34a 18%, transparent); color: #15803d; }
  .failed { background: color-mix(in srgb, #dc2626 18%, transparent); color: #b91c1c; }
  .pending{ background: color-mix(in srgb, #d97706 20%, transparent); color: #b45309; }
  @media (prefers-color-scheme: dark) {
    .sent { color: #4ade80; } .failed { color: #f87171; } .pending { color: #fbbf24; }
  }
  .line { margin: .2rem 0; }
  .label {
    font-size: .68rem; text-transform: uppercase; letter-spacing: .07em;
    opacity: .5; font-weight: 700; margin: .9rem 0 .35rem;
  }
  ol { margin: 0; padding-left: 1.3rem; }
  li { margin-bottom: .3rem; }
  li .why { opacity: .55; font-size: .84rem; }
  .err {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: .8rem; color: #b91c1c; overflow-wrap: anywhere;
  }
  @media (prefers-color-scheme: dark) { .err { color: #f87171; } }
  .skipped { font-size: .8rem; color: #b45309; margin-top: .7rem; }
  .foot {
    display: flex; gap: 1rem; margin-top: .9rem; padding-top: .7rem;
    border-top: 1px solid color-mix(in srgb, CanvasText 9%, transparent);
    font-size: .78rem; opacity: .55;
  }
  nav { display: flex; gap: .6rem; align-items: center; margin-top: 2rem; }
  nav a, nav span {
    padding: .4rem .8rem; border-radius: 6px; font-size: .85rem;
    border: 1px solid color-mix(in srgb, CanvasText 18%, transparent);
    text-decoration: none;
  }
  nav span { opacity: .35; }
  nav .count { border: 0; opacity: .5; margin-left: auto; }
  .empty { padding: 2.5rem 0; opacity: .6; }
  .sched { font-variant-numeric: tabular-nums; }
  .sched div {
    padding: .2rem 0; white-space: pre-wrap;
    border-bottom: 1px solid color-mix(in srgb, CanvasText 8%, transparent);
  }
  .sched div:last-child { border-bottom: 0; }
  .conflict { color: #b45309; font-size: .88rem; margin-top: .4rem; }
  @media (prefers-color-scheme: dark) { .conflict { color: #fbbf24; } }
  h2.section {
    font-size: .72rem; text-transform: uppercase; letter-spacing: .07em;
    opacity: .55; font-weight: 700; margin: 0 0 .3rem;
  }
  .section-sub { opacity: .55; font-size: .82rem; margin: 0 0 1rem; }
  .block { margin-bottom: 3rem; }
  .block + .block {
    padding-top: 2.25rem;
    border-top: 1px solid color-mix(in srgb, CanvasText 12%, transparent);
  }
  .fb { display: flex; align-items: center; gap: .5rem; margin: .3rem 0 .8rem; }
  .fb form.inline { margin: 0; }
  .fbgood, .fbwrap > summary {
    font: inherit; font-size: .74rem; cursor: pointer; padding: .12rem .5rem;
    border-radius: 5px; border: 1px solid color-mix(in srgb, CanvasText 20%, transparent);
    background: none; color: inherit; opacity: .65; list-style: none;
  }
  .fbgood:hover, .fbwrap > summary:hover { opacity: 1; }
  .fbwrap { display: inline-block; }
  .fbwrap[open] > summary { opacity: 1; font-weight: 600; }
  .fbwrap form {
    margin: .5rem 0 0; display: flex; flex-direction: column; gap: .25rem;
    max-width: 420px;
  }
  .fbopt {
    text-align: left; font: inherit; font-size: .8rem; cursor: pointer;
    padding: .4rem .6rem; border-radius: 6px; background: none; color: inherit;
    border: 1px solid color-mix(in srgb, CanvasText 15%, transparent);
  }
  .fbopt:hover { border-color: color-mix(in srgb, CanvasText 45%, transparent); }
  .fbeffect { display: block; opacity: .5; font-size: .72rem; margin-top: .1rem; }
${SCORING_STYLE}`;

function statusClass(status: string): string {
  return status === "sent" ? "sent" : status === "failed" ? "failed" : "pending";
}

/**
 * One gesture, four destinations.
 *
 * The choice is what routes the verdict — "this sender is noise" and "this
 * conversation is finished" are different claims with different lifespans, and a
 * bare thumbs-down that could mean either is unactionable. Each option states
 * its own effect, so pressing a button is never a mystery.
 */
function feedbackControls(briefId: number, threadKey: string): string {
  const hidden = `
    <input type="hidden" name="brief_id" value="${briefId}">
    <input type="hidden" name="thread_key" value="${escapeHtml(threadKey)}">`;

  const option = (c: { id: string; label: string; effect: string }) => `
    <button type="submit" name="choice" value="${c.id}" class="fbopt">
      ${escapeHtml(c.label)}<span class="fbeffect">${escapeHtml(c.effect)}</span>
    </button>`;

  return `
    <div class="fb">
      <form class="inline" method="post" action="/feedback">${hidden}
        <button type="submit" name="choice" value="good" class="fbgood">Good call</button>
      </form>
      <details class="fbwrap">
        <summary>Not right</summary>
        <form method="post" action="/feedback">${hidden}
          ${[...NOT_IMPORTANT_CHOICES, ...OTHER_CHOICES].map(option).join("")}
        </form>
      </details>
    </div>`;
}

function renderCard(brief: BriefSummary): string {
  const payload = (brief.payload ?? {}) as StoredPayload;
  const c = payload.composed;

  // Older rows carry a model-written schedule line instead of rendered meetings.
  const schedule = payload.meetings?.length
    ? `<div class="label">Meetings (${payload.meetings.length})</div>
       <div class="sched">${payload.meetings
         .map((m) => `<div>${escapeHtml(m)}</div>`)
         .join("")}</div>`
    : c?.meetings_line
      ? `<div class="line">${escapeHtml(c.meetings_line)}</div>`
      : "";

  const conflicts = payload.conflicts?.length
    ? payload.conflicts
        .map((x) => `<div class="line conflict">${escapeHtml(x)}</div>`)
        .join("")
    : c?.conflicts_line
      ? `<div class="line conflict">${escapeHtml(c.conflicts_line)}</div>`
      : "";

  const body = c
    ? `
      ${schedule}
      ${conflicts}
      ${
        c.priorities.length
          ? `<div class="label">Priorities</div>
             <ol>${c.priorities.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ol>`
          : ""
      }
      ${
        c.emails.length
          ? `<div class="label">Needs attention (${c.emails.length})</div>
             <ol>${c.emails
               .map(
                 (e) =>
                   `<li>${escapeHtml(e.line)}${
                     e.reason ? ` <span class="why">— ${escapeHtml(e.reason)}</span>` : ""
                   }${feedbackControls(brief.id, e.thread_key)}</li>`,
               )
               .join("")}</ol>`
          : `<div class="label">Needs attention</div><div class="line" style="opacity:.55">Nothing surfaced.</div>`
      }`
    : payload.error
      ? `<div class="err">${escapeHtml(payload.error)}</div>`
      : `<div class="line" style="opacity:.55">No payload recorded.</div>`;

  const sentTime = brief.sent_at ? formatLocalTime(new Date(brief.sent_at)) : "—";

  return `
    <article class="card">
      <div class="card-head">
        <span class="date">${escapeHtml(brief.local_date)}</span>
        <span class="pill ${statusClass(brief.status)}">${escapeHtml(brief.status)}</span>
        <span class="meta">sent ${escapeHtml(sentTime)}</span>
      </div>
      ${body}
      ${
        brief.skipped_accounts?.length
          ? `<div class="skipped">Skipped: ${escapeHtml(brief.skipped_accounts.join(", "))}</div>`
          : ""
      }
      <div class="foot">
        <a href="/brief/${escapeHtml(brief.share_token)}">Open shared page</a>
        ${brief.message_sid ? `<span>sid ${escapeHtml(brief.message_sid)}</span>` : "<span>not delivered</span>"}
      </div>
    </article>`;
}

export function renderBriefsPage(
  briefs: BriefSummary[],
  requestedPage: number,
  total: number,
  scored: ScoredThread[],
): string {
  const lastPage = Math.max(1, Math.ceil(total / BRIEFS_PER_PAGE));
  // A hand-edited page number past the end should read as the last page rather
  // than "page 99 of 1".
  const page = Math.min(Math.max(1, requestedPage), lastPage);

  const prev =
    page > 1
      ? `<a href="/briefs?page=${page - 1}">← Newer</a>`
      : `<span>← Newer</span>`;
  const next =
    page < lastPage
      ? `<a href="/briefs?page=${page + 1}">Older →</a>`
      : `<span>Older →</span>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Briefs — ops-agent</title>
  <style>${STYLE}</style>
</head>
<body>
  <main>
    <header>
      <h1>Briefs</h1>
      <a href="/rules">Rules →</a>
    </header>
    <div class="sub"><a href="/">← Accounts</a> &nbsp;·&nbsp; What went out, what would go out right now, and what you thought of it.</div>

    <div class="block">
      <h2 class="section">Ranking right now</h2>
      <p class="section-sub">
        Recomputed live against the mail currently synced and the weights currently deployed.
      </p>
      ${renderScoringSection(scored)}
    </div>

    <div class="block">
      <h2 class="section">History</h2>
      <p class="section-sub">
        ${total} brief${total === 1 ? "" : "s"} kept. Older than ${BRIEF_RETENTION_DAYS} days are deleted automatically.
      </p>
      ${
        briefs.length === 0
          ? `<div class="empty">No briefs yet. One is recorded each morning after delivery.</div>`
          : briefs.map(renderCard).join("")
      }

      <nav>
        ${prev}${next}
        <span class="count">page ${page} of ${lastPage}</span>
      </nav>
    </div>
  </main>
</body>
</html>`;
}
