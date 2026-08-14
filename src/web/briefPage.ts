import type { ComposedBrief } from "../ranking/compose.js";
import { escapeHtml } from "./admin.js";

/**
 * The full brief, linked from the message.
 *
 * Reachable without login via an unguessable, expiring token — he opens it on a
 * phone, half awake, and a password prompt at 6:30am defeats the purpose. The
 * token carries no account access; it renders one day's already-composed brief
 * and nothing else.
 */

export interface BriefPayload {
  composed: ComposedBrief;
  text: string;
  briefUrl: string;
  /** Rendered schedule. Absent on briefs stored before the model stopped writing it. */
  meetings?: string[];
  conflicts?: string[];
}

/**
 * Briefs already in the database carry a model-written schedule summary. The
 * history exists to be compared across weeks, so old rows keep rendering rather
 * than showing a blank Today section after the format change.
 */
export type LegacyComposed = ComposedBrief & {
  meetings_line?: string;
  conflicts_line?: string;
};

const STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    margin: 0; padding: 2rem 1.25rem 4rem; background: Canvas; color: CanvasText;
  }
  main { max-width: 640px; margin: 0 auto; }
  h1 { font-size: 1.3rem; margin: 0 0 .25rem; letter-spacing: -.01em; }
  .date { opacity: .6; font-size: .9rem; margin-bottom: 2rem; }
  section { margin-bottom: 2rem; }
  h2 {
    font-size: .72rem; text-transform: uppercase; letter-spacing: .07em;
    opacity: .55; margin: 0 0 .75rem; font-weight: 700;
  }
  ol { margin: 0; padding-left: 1.35rem; }
  li { margin-bottom: .85rem; }
  li .why { display: block; opacity: .6; font-size: .85rem; margin-top: .1rem; }
  .lead { font-size: 1.02rem; margin: 0 0 .4rem; }
  ul.sched { list-style: none; margin: 0; padding: 0; }
  ul.sched li {
    margin: 0; padding: .45rem 0;
    border-bottom: 1px solid color-mix(in srgb, CanvasText 9%, transparent);
    font-variant-numeric: tabular-nums; white-space: pre-wrap;
  }
  ul.sched li:last-child { border-bottom: 0; }
  .warn {
    border-left: 3px solid #d97706; padding: .5rem .85rem; margin: .75rem 0;
    background: color-mix(in srgb, #d97706 9%, transparent); border-radius: 0 5px 5px 0;
  }
  .skipped {
    border-left: 3px solid #dc2626;
    background: color-mix(in srgb, #dc2626 8%, transparent);
    padding: .5rem .85rem; border-radius: 0 5px 5px 0; font-size: .88rem;
  }
  footer { margin-top: 3rem; font-size: .78rem; opacity: .45; }
  .empty { opacity: .6; }
`;

export function renderBriefPage(
  localDate: string,
  payload: BriefPayload,
  skippedAccounts: string[],
): string {
  const b = (payload.composed ?? { emails: [], priorities: [] }) as LegacyComposed;

  const schedule = payload.meetings?.length
    ? `<ul class="sched">${payload.meetings
        .map((m) => `<li>${escapeHtml(m)}</li>`)
        .join("")}</ul>`
    : b.meetings_line
      ? `<p class="lead">${escapeHtml(b.meetings_line)}</p>`
      : `<p class="empty">Nothing on the calendar today.</p>`;

  const conflicts = payload.conflicts?.length
    ? payload.conflicts
        .map((c) => `<div class="warn">${escapeHtml(c)}</div>`)
        .join("")
    : b.conflicts_line
      ? `<div class="warn">${escapeHtml(b.conflicts_line)}</div>`
      : "";

  const emails = b.emails.length
    ? `<ol>${b.emails
        .map(
          (e) =>
            `<li>${escapeHtml(e.line)}${
              e.reason ? `<span class="why">${escapeHtml(e.reason)}</span>` : ""
            }</li>`,
        )
        .join("")}</ol>`
    : `<p class="empty">Nothing needs you.</p>`;

  const priorities = b.priorities.length
    ? `<ol>${b.priorities.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ol>`
    : `<p class="empty">—</p>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>Brief — ${escapeHtml(localDate)}</title>
  <style>${STYLE}</style>
</head>
<body>
  <main>
    <h1>Good morning</h1>
    <div class="date">${escapeHtml(localDate)}</div>

    <section>
      <h2>Meetings</h2>
      ${schedule}
      ${conflicts}
    </section>

    <section>
      <h2>Priorities</h2>
      ${priorities}
    </section>

    <section>
      <h2>Needs attention</h2>
      ${emails}
    </section>

    ${
      skippedAccounts.length
        ? `<section><div class="skipped">Could not read: ${escapeHtml(
            skippedAccounts.join(", "),
          )}. Everything else is complete.</div></section>`
        : ""
    }

    <footer>Read-only. ops-agent never sends, moves, or changes anything in your accounts.</footer>
  </main>
</body>
</html>`;
}
