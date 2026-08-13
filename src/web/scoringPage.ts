import type { ScoredThread } from "../signals/score.js";
import * as W from "../signals/weights.js";
import { escapeHtml } from "./admin.js";

/**
 * Why the brief chose what it chose.
 *
 * This is the tuning instrument. Without it, "the brief feels wrong" has no
 * path to "the never-corresponded penalty is too harsh" without someone running
 * a script against the database.
 *
 * It recomputes live rather than reading a snapshot, so it always reflects the
 * weights currently deployed and the mail currently synced — change a weight,
 * redeploy, reload, and the difference is visible immediately.
 */

const STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    margin: 0; padding: 2.5rem 1.5rem 4rem; background: Canvas; color: CanvasText;
  }
  main { max-width: 1100px; margin: 0 auto; }
  header { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; }
  h1 { font-size: 1.35rem; margin: 0; letter-spacing: -.01em; }
  a { color: inherit; }
  .sub { opacity: .6; font-size: .85rem; margin: .3rem 0 1.75rem; }
  .row {
    border: 1px solid color-mix(in srgb, CanvasText 12%, transparent);
    border-radius: 9px; padding: .8rem 1rem; margin-bottom: .6rem;
    display: grid; grid-template-columns: 4rem 1fr; gap: 0 1rem; align-items: start;
  }
  .row.below { opacity: .5; }
  .score {
    font-size: 1.15rem; font-weight: 700; font-variant-numeric: tabular-nums;
    text-align: right;
  }
  .row.above .score { color: #15803d; }
  .row.below .score { color: inherit; }
  @media (prefers-color-scheme: dark) { .row.above .score { color: #4ade80; } }
  .subject { font-weight: 600; }
  .from { opacity: .6; font-size: .82rem; margin-top: .1rem; }
  .sig { margin-top: .45rem; display: flex; flex-wrap: wrap; gap: .3rem; }
  .chip {
    font-size: .72rem; padding: .1rem .45rem; border-radius: 5px; white-space: nowrap;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .plus  { background: color-mix(in srgb, #16a34a 16%, transparent); color: #15803d; }
  .minus { background: color-mix(in srgb, #dc2626 16%, transparent); color: #b91c1c; }
  @media (prefers-color-scheme: dark) {
    .plus { color: #4ade80; } .minus { color: #f87171; }
  }
  .divider {
    display: flex; align-items: center; gap: .8rem; margin: 1.5rem 0 .9rem;
    font-size: .72rem; text-transform: uppercase; letter-spacing: .07em; opacity: .5;
    font-weight: 700;
  }
  .divider::after {
    content: ""; flex: 1; height: 1px;
    background: color-mix(in srgb, CanvasText 15%, transparent);
  }
  .weights {
    margin-top: 2.5rem; padding-top: 1.5rem;
    border-top: 1px solid color-mix(in srgb, CanvasText 12%, transparent);
    font-size: .8rem; opacity: .7;
  }
  .weights code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .weights td { padding: .15rem .9rem .15rem 0; }
  .empty { padding: 3rem 0; opacity: .6; }
`;

function chips(t: ScoredThread): string {
  return t.signals
    .map(
      (s) =>
        `<span class="chip ${s.points >= 0 ? "plus" : "minus"}">${
          s.points >= 0 ? "+" : ""
        }${Math.round(s.points)} ${escapeHtml(s.name)}${
          s.detail ? ` · ${escapeHtml(s.detail)}` : ""
        }</span>`,
    )
    .join("");
}

function renderRow(t: ScoredThread, above: boolean): string {
  const c = t.candidate;
  return `
    <div class="row ${above ? "above" : "below"}">
      <div class="score">${Math.round(t.score)}</div>
      <div>
        <div class="subject">${escapeHtml(c.subject ?? "(no subject)")}</div>
        <div class="from">${escapeHtml(c.fromName ?? "")} &lt;${escapeHtml(
          c.fromEmail ?? "unknown",
        )}&gt; &nbsp;→&nbsp; ${escapeHtml(c.accountEmail)}</div>
        <div class="sig">${chips(t)}</div>
      </div>
    </div>`;
}

export function renderScoringPage(scored: ScoredThread[]): string {
  const above = scored.filter((t) => t.score >= W.MIN_SCORE_FOR_BRIEF);
  const below = scored.filter((t) => t.score < W.MIN_SCORE_FOR_BRIEF);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Scoring — ops-agent</title>
  <style>${STYLE}</style>
</head>
<body>
  <main>
    <header>
      <h1>Scoring</h1>
      <a href="/">← Accounts</a>
    </header>
    <div class="sub">
      ${scored.length} candidate${scored.length === 1 ? "" : "s"} scored right now.
      ${above.length} clear the floor of ${W.MIN_SCORE_FOR_BRIEF} and would reach the model;
      at most ${W.MAX_CANDIDATES} are sent.
    </div>

    ${
      scored.length === 0
        ? `<div class="empty">No candidates. Sync first, or every thread is older than ${W.CANDIDATE_MAX_AGE_DAYS} days.</div>`
        : `<div class="divider">Would reach the brief</div>
           ${above.map((t) => renderRow(t, true)).join("") || `<div class="empty">Nothing clears the floor.</div>`}
           <div class="divider">Below the floor</div>
           ${below.map((t) => renderRow(t, false)).join("")}`
    }

    <div class="weights">
      <strong>Current weights</strong> — <code>src/signals/weights.ts</code>
      <table>
        <tr><td><code>AWAITING_REPLY</code></td><td>+${W.AWAITING_REPLY}</td><td>last message inbound, no reply since</td></tr>
        <tr><td><code>aging</code></td><td>+${W.agingScore(0.5)} … +${W.agingScore(4)} … +${W.agingScore(40)}</td><td>peaks at 2-7 days, falls off after 14</td></tr>
        <tr><td><code>ADDRESSED_TO</code></td><td>+${W.ADDRESSED_TO} / +${W.ADDRESSED_CC}</td><td>To: versus Cc:</td></tr>
        <tr><td><code>known-correspondent</code></td><td>+${W.correspondentScore(1)} / +${W.correspondentScore(3)} / +${W.correspondentScore(10)}</td><td>by how often he writes to them</td></tr>
        <tr><td><code>NEVER_CORRESPONDED</code></td><td>${W.NEVER_CORRESPONDED}</td><td>he has never written to this address</td></tr>
        <tr><td><code>MEETING_SOON</code></td><td>+${W.MEETING_SOON}</td><td>meeting with the sender inside ${W.MEETING_SOON_HOURS}h</td></tr>
        <tr><td><code>MET_RECENTLY</code></td><td>+${W.MET_RECENTLY}</td><td>met within ${W.MET_RECENTLY_DAYS} days, nothing sent since</td></tr>
        <tr><td><code>EXPLICIT_ASK</code></td><td>+${W.EXPLICIT_ASK}</td><td>question, deadline, or chase detected</td></tr>
        <tr><td><code>AUTOMATED</code></td><td>${W.AUTOMATED}</td><td>machine sender or bulk headers</td></tr>
        <tr><td><code>LIST_UNSUBSCRIBE</code></td><td>${W.LIST_UNSUBSCRIBE}</td><td>mailing list on top of automated</td></tr>
      </table>
    </div>
  </main>
</body>
</html>`;
}
