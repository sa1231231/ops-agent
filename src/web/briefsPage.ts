import type { BriefSummaryWithRuns } from "../db/queries/briefs.js";
import type { MissedThread, RecordedVerdict } from "../db/queries/rules.js";
import { formatLocalTime } from "../time.js";
import { escapeHtml } from "./admin.js";
import type { LegacyComposed } from "./briefPage.js";
import { renderWhy, SCORING_STYLE, type SignalLike } from "./scoring.js";
import {
  isApproval,
  NOT_IMPORTANT_CHOICES,
  priorityIndexFromNote,
  PRESENTATION_CHOICES,
  PRIORITY_CHOICES,
  verdictLabel,
} from "./feedback.js";

/**
 * Briefs: what went out, what you thought of it, and what it may have missed.
 *
 * Everything on this page hangs off a specific morning. That is the organising
 * idea, and it is why the live "ranking right now" list is gone: it rescored
 * today's mail on every page load to answer a question that is always asked
 * about a *past* brief, so it could not actually answer it. The explanation now
 * sits on the item itself, read from the scoring snapshot stored with that
 * brief — the same numbers, at the moment they mean something.
 */

/**
 * One day per view.
 *
 * A scrolling wall of cards pushed everything below it out of sight, and the
 * question below it - "did the brief miss these" - is the one that needs
 * answering while the morning is still fresh. Older and Newer under a single
 * card gets there in one click and keeps the rest of the page reachable.
 */
export const BRIEFS_PER_PAGE = 1;

/** A brief's stored scoring snapshot: why each candidate scored what it did. */
interface ScoringSnapshotRow {
  threadKey: string;
  score?: number | null;
  signals?: SignalLike[];
}

interface StoredPayload {
  composed?: LegacyComposed;
  meetings?: string[];
  conflicts?: string[];
  text?: string;
  error?: string;
  scoring?: ScoringSnapshotRow[];
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
  li { margin-bottom: .75rem; }
  li:last-child { margin-bottom: .2rem; }
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

  /* Item text left, controls right, on one line. The controls sit in the same
     place on every row, which is what makes them scannable; the text keeps the
     full width it needs and wraps underneath itself rather than being squeezed
     into a column beside them. */
  .itemrow { display: flex; align-items: baseline; gap: 1rem; }
  .itemtext { flex: 1; min-width: 0; }

  /* Quiet until wanted: two words at the end of an item, barely there, full
     contrast on hover. They repeat on every line, and at full strength they
     compete with the brief itself for attention. */
  .judge {
    display: flex; align-items: center; gap: .1rem;
    flex: none; margin-left: auto; position: relative;
  }
  .judge form { margin: 0; display: inline; }
  .judge button, .judge summary {
    font: inherit; font-size: .74rem; cursor: pointer; padding: .1rem .45rem;
    border: 0; border-radius: 5px; background: none; color: inherit;
    opacity: .38; list-style: none;
  }
  .judge button:hover, .judge summary:hover {
    opacity: 1; background: color-mix(in srgb, CanvasText 8%, transparent);
  }
  .judge .yes:hover { color: #15803d; }
  .judge .no:hover  { color: #b91c1c; }
  @media (prefers-color-scheme: dark) {
    .judge .yes:hover { color: #4ade80; } .judge .no:hover { color: #f87171; }
  }
  .judge details[open] > summary { opacity: 1; font-weight: 600; }
  .judge .dot { opacity: .2; font-size: .7rem; }

  /* The menu, once opened. A bordered card so it reads as one question with
     several answers rather than a stack of unrelated buttons.

     Floated over the page rather than pushed into the row: the controls are
     narrow and right-aligned now, so a menu in the flow would either stretch
     that column and crush the text beside it, or reflow the whole card every
     time one is opened. */
  .menu {
    position: absolute; right: 0; top: calc(100% + .3rem); z-index: 5;
    width: min(28rem, 78vw); padding: .3rem;
    display: flex; flex-direction: column; gap: .1rem; border-radius: 8px;
    border: 1px solid color-mix(in srgb, CanvasText 22%, transparent);
    background: Canvas;
    box-shadow: 0 8px 24px color-mix(in srgb, CanvasText 18%, transparent);
  }
  .menu button {
    text-align: left; font: inherit; font-size: .8rem; cursor: pointer;
    padding: .35rem .5rem; border-radius: 6px; background: none; color: inherit;
    border: 0; opacity: 1;
  }
  .menu button:hover { background: color-mix(in srgb, CanvasText 9%, transparent); }
  .menu .fbeffect { display: block; opacity: .5; font-size: .72rem; margin-top: .05rem; }

  /* Already judged: a fact, not a control. */
  .judged {
    display: inline-block; font-size: .72rem; flex: none; margin-left: auto;
    white-space: nowrap;
    padding: .1rem .45rem; border-radius: 5px;
    background: color-mix(in srgb, CanvasText 8%, transparent); opacity: .75;
  }
  .judged.ok { background: color-mix(in srgb, #16a34a 15%, transparent); color: #15803d; }
  @media (prefers-color-scheme: dark) { .judged.ok { color: #4ade80; } }

  .missedrow {
    display: flex; align-items: center; gap: 1rem; padding: .7rem 0;
    border-top: 1px solid color-mix(in srgb, CanvasText 10%, transparent);
  }
  .missedrow > div:first-child { flex: 1; min-width: 0; }
  .missedrow .judge { margin-top: 0; }
  .msubject { font-weight: 600; font-size: .92rem; }
  .mfrom { opacity: .55; font-size: .78rem; margin-top: .05rem; }
${SCORING_STYLE}`;

function statusClass(status: string): string {
  return status === "sent" ? "sent" : status === "failed" ? "failed" : "pending";
}

/** What was already decided, shown in place of the buttons. */
function judged(choiceId: string | null): string {
  return `<span class="judged ${isApproval(choiceId) ? "ok" : ""}">${escapeHtml(
    verdictLabel(choiceId),
  )}</span>`;
}

const menuOption = (c: { id: string; label: string; effect: string }) => `
  <button type="submit" name="choice" value="${c.id}">
    ${escapeHtml(c.label)}<span class="fbeffect">${escapeHtml(c.effect)}</span>
  </button>`;

/**
 * One gesture, several destinations.
 *
 * The choice is what routes the verdict — "this sender is noise" and "this
 * conversation is finished" are different claims with different lifespans, so a
 * bare thumbs-down that could mean either is unactionable. Each option still
 * states its own effect: pressing a button is never a mystery.
 */
function threadControls(
  briefId: number,
  threadKey: string,
  recorded: string | null | undefined,
): string {
  if (recorded !== undefined) return judged(recorded);

  const hidden = `
    <input type="hidden" name="brief_id" value="${briefId}">
    <input type="hidden" name="thread_key" value="${escapeHtml(threadKey)}">`;

  return `
    <div class="judge">
      <form method="post" action="/feedback">${hidden}
        <button type="submit" name="choice" value="good" class="yes">Good call</button>
      </form>
      <span class="dot">&middot;</span>
      <details name="judge">
        <summary class="no">Not right</summary>
        <form method="post" action="/feedback">${hidden}
          <div class="menu">
            ${[...NOT_IMPORTANT_CHOICES, ...PRESENTATION_CHOICES].map(menuOption).join("")}
          </div>
        </form>
      </details>
    </div>`;
}

/**
 * Priorities are judged differently because they are not scored objects.
 *
 * Everything under "needs attention" is a real thread with a score behind it, so
 * a verdict there can become arithmetic. A priority is a sentence the model
 * wrote — no sender rule can demote it. These feed standing instructions and the
 * suggestions query, and the labels say so rather than implying an effect that
 * cannot exist.
 */
function priorityControls(
  briefId: number,
  index: number,
  text: string,
  recorded: string | null | undefined,
): string {
  if (recorded !== undefined) return judged(recorded);

  const hidden = `
    <input type="hidden" name="brief_id" value="${briefId}">
    <input type="hidden" name="priority_index" value="${index}">
    <input type="hidden" name="note" value="${escapeHtml(text)}">`;

  return `
    <div class="judge">
      <form method="post" action="/feedback">${hidden}
        <button type="submit" name="choice" value="priority-good" class="yes">Good call</button>
      </form>
      <span class="dot">&middot;</span>
      <details name="judge">
        <summary class="no">Not right</summary>
        <form method="post" action="/feedback">${hidden}
          <div class="menu">${PRIORITY_CHOICES.map(menuOption).join("")}</div>
        </form>
      </details>
    </div>`;
}

/**
 * Verdicts already recorded for the briefs on this page.
 *
 * Keyed so a lookup is exact: threads by `<brief>|<thread_key>`, priorities by
 * `<brief>|#<n>` recovered from the note, which is how they were written.
 */
function verdictIndex(recorded: RecordedVerdict[]): Map<string, string | null> {
  const index = new Map<string, string | null>();
  for (const r of recorded) {
    if (r.briefId === null) continue;
    const key = r.threadKey
      ? `${r.briefId}|${r.threadKey}`
      : `${r.briefId}|#${priorityIndexFromNote(r.note) ?? "?"}`;
    // Rows arrive newest first, so the first one wins.
    if (!index.has(key)) index.set(key, r.choice);
  }
  return index;
}

function renderCard(brief: BriefSummaryWithRuns, verdicts: Map<string, string | null>): string {
  const payload = (brief.payload ?? {}) as StoredPayload;
  const c = payload.composed;

  // Why each item was chosen, as scored on the morning it went out. Recomputing
  // it now would answer a different question — the mail has moved on since.
  const snapshot = new Map<string, ScoringSnapshotRow>(
    (payload.scoring ?? []).map((row) => [row.threadKey, row]),
  );

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
             <ol>${c.priorities
               .map(
                 (p, i) =>
                   `<li><div class="itemrow">
                      <div class="itemtext">${escapeHtml(p)}</div>
                      ${priorityControls(
                        brief.id,
                        i + 1,
                        p,
                        verdicts.get(`${brief.id}|#${i + 1}`),
                      )}
                    </div></li>`,
               )
               .join("")}</ol>`
          : ""
      }
      ${
        c.emails.length
          ? `<div class="label">Needs attention (${c.emails.length})</div>
             <ol>${c.emails
               .map((e) => {
                 const row = snapshot.get(e.thread_key);
                 // No `reason` here. It reads as commentary on a line that has
                 // already said the thing, and two sentences where one will do
                 // is what makes a page tiring rather than informative. It is
                 // still composed and stored: carry-over depends on it.
                 return `<li>
                   <div class="itemrow">
                     <div class="itemtext">${escapeHtml(e.line)}</div>
                     ${threadControls(
                       brief.id,
                       e.thread_key,
                       verdicts.get(`${brief.id}|${e.thread_key}`),
                     )}
                   </div>
                   ${renderWhy(row?.score ?? null, row?.signals ?? [])}
                 </li>`;
               })
               .join("")}</ol>`
          : `<div class="label">Needs attention</div><div class="line" style="opacity:.55">Nothing surfaced.</div>`
      }`
    : payload.error
      ? `<div class="err">${escapeHtml(payload.error)}</div>`
      : `<div class="line" style="opacity:.55">No payload recorded.</div>`;

  const sentTime = brief.sent_at ? formatLocalTime(new Date(brief.sent_at)) : "not sent";

  return `
    <article class="card">
      <div class="card-head">
        <span class="date">${escapeHtml(brief.local_date)}</span>
        <span class="pill ${statusClass(brief.status)}">${escapeHtml(brief.status)}</span>
        <span class="meta">sent ${escapeHtml(sentTime)}${
          brief.runsThatDay > 1 ? ` (last of ${brief.runsThatDay} that day)` : ""
        }</span>
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

/**
 * The false negatives, found without anyone looking for them.
 *
 * He will never report the email he was not shown — he does not know it exists.
 * But we resync these mailboxes anyway, so his own outbox finds them: he
 * answered something, and a brief had gone out in between that did not mention
 * it. That is a question with an honest answer, which is why the list only holds
 * threads where a brief actually had the chance.
 *
 * Yes or no, and nothing else. Replying is not the same as mattering — he fires
 * off one-liners and sits on hard things — so the system does not get to decide
 * this one on its own.
 */
function missedPanel(missed: MissedThread[]): string {
  // Nothing to ask means nothing to show. This is a queue of questions, not a
  // status readout, and a heading followed by "there is nothing here" is a
  // section that asks to be read and then wastes the reading. Empty is the
  // normal state, so the normal state is silence.
  if (missed.length === 0) return "";

  return `
    <div class="block">
      <h2 class="section">Did the brief miss these?</h2>
      <p class="section-sub">
        You answered these yourself, and a brief went out in between without
        mentioning them. Nothing changes until you answer.
      </p>
      ${
        missed
          .map(
                (m) => `
        <div class="missedrow">
          <div>
            <div class="msubject">${escapeHtml(m.subject ?? "(no subject)")}</div>
            <div class="mfrom">${escapeHtml(m.fromEmail ?? "unknown")} &rarr; ${escapeHtml(
              m.accountEmail,
            )} &middot; you replied ${escapeHtml(formatLocalTime(m.repliedAt))}</div>
          </div>
          <div class="judge">
            <form method="post" action="/feedback">
              <input type="hidden" name="thread_key" value="${escapeHtml(m.threadKey)}">
              <button type="submit" name="choice" value="missed" class="yes">Yes</button>
            </form>
            <span class="dot">&middot;</span>
            <form method="post" action="/feedback">
              <input type="hidden" name="thread_key" value="${escapeHtml(m.threadKey)}">
              <button type="submit" name="choice" value="not-missed" class="no">No</button>
            </form>
          </div>
        </div>`,
              )
              .join("")
      }
    </div>`;
}

/**
 * Closes an open "Not right" menu when you click away from it or press Escape.
 *
 * `<details>` is a disclosure widget, not a dropdown: nothing in HTML closes one
 * on an outside click, so an opened menu stayed open until you clicked its
 * summary again. The grouping attribute above means opening a second menu closes
 * the first, which handles most of it, but clicking anywhere else on the page
 * still left one hanging.
 *
 * Eight lines of inline vanilla JS rather than the "no JS" the rest of this
 * console holds to. The rule exists to keep out frameworks and build steps, and
 * this is neither. Everything still works with scripting off, which is the part
 * that actually matters: the menu opens, the options are real submit buttons,
 * and the only thing lost is the convenience of dismissing it by clicking away.
 */
const DISMISS_SCRIPT = `
  document.addEventListener('click', function (e) {
    document.querySelectorAll('details[name="judge"][open]').forEach(function (d) {
      if (!d.contains(e.target)) d.open = false;
    });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    document.querySelectorAll('details[name="judge"][open]').forEach(function (d) {
      d.open = false;
    });
  });
`;

export function renderBriefsPage(
  briefs: BriefSummaryWithRuns[],
  requestedPage: number,
  total: number,
  missed: MissedThread[],
  recorded: RecordedVerdict[],
): string {
  const lastPage = Math.max(1, Math.ceil(total / BRIEFS_PER_PAGE));
  // A hand-edited page number past the end should read as the last page rather
  // than "page 99 of 1".
  const page = Math.min(Math.max(1, requestedPage), lastPage);
  const verdicts = verdictIndex(recorded);

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
  <title>Briefs - ops-agent</title>
  <style>${STYLE}</style>
</head>
<body>
  <main>
    <header>
      <h1>Briefs</h1>
      <a href="/rules">Rules →</a>
    </header>
    <div class="sub"><a href="/">← Accounts</a></div>

    <div class="block">
      <h2 class="section">History</h2>
      <p class="section-sub">Giving feedback here will teach the AI.</p>
      ${
        briefs.length === 0
          ? `<div class="empty">No briefs yet. One is recorded each morning after delivery.</div>`
          : briefs.map((b) => renderCard(b, verdicts)).join("")
      }

      <nav>
        ${prev}${next}
        <span class="count">day ${page} of ${lastPage}</span>
      </nav>
    </div>

    ${missedPanel(missed)}
  </main>
  <script>${DISMISS_SCRIPT}</script>
</body>
</html>`;
}
