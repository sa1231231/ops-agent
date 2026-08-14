import type { ScoredThread, Signal } from "../signals/score.js";
import * as W from "../signals/weights.js";
import { escapeHtml } from "./admin.js";

/**
 * Why the brief chose what it chose.
 *
 * This is the tuning instrument, and it lives on the same page as the history
 * because the question it answers is always asked about a specific brief — "why
 * was that in there" and "why wasn't this". Two tabs meant holding one in your
 * head while looking at the other.
 *
 * It recomputes live rather than reading a snapshot, so it always reflects the
 * weights currently deployed and the mail currently synced — change a weight,
 * redeploy, reload, and the difference is visible immediately.
 *
 * The default view is one plain-English line per thread. Every number is still
 * there, one click away, because the numbers are what you change; but reading
 * fourteen chips per row to answer "is this ranking sensible" was the wrong
 * default.
 */

export const SCORING_STYLE = `
  .srow {
    border: 1px solid color-mix(in srgb, CanvasText 12%, transparent);
    border-radius: 9px; padding: .7rem .9rem; margin-bottom: .5rem;
    display: grid; grid-template-columns: 3.2rem 1fr; gap: 0 .9rem; align-items: start;
  }
  .srow.below { opacity: .55; }
  .sscore {
    font-size: 1.1rem; font-weight: 700; font-variant-numeric: tabular-nums;
    text-align: right; padding-top: .05rem;
  }
  .srow.above .sscore { color: #15803d; }
  @media (prefers-color-scheme: dark) { .srow.above .sscore { color: #4ade80; } }
  .ssubject { font-weight: 600; }
  .sfrom { opacity: .55; font-size: .8rem; margin-top: .05rem; }
  .swhy { font-size: .85rem; margin-top: .3rem; }
  .swhy .neg { color: #b91c1c; }
  @media (prefers-color-scheme: dark) { .swhy .neg { color: #f87171; } }
  details.sig { margin-top: .4rem; }
  details.sig > summary {
    cursor: pointer; font-size: .75rem; opacity: .5; list-style: none;
  }
  details.sig > summary::before { content: "+ "; }
  details.sig[open] > summary::before { content: "- "; }
  .chips { display: flex; flex-wrap: wrap; gap: .25rem; margin-top: .4rem; }
  .chip {
    font-size: .7rem; padding: .08rem .4rem; border-radius: 5px; white-space: nowrap;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .plus  { background: color-mix(in srgb, #16a34a 16%, transparent); color: #15803d; }
  .minus { background: color-mix(in srgb, #dc2626 16%, transparent); color: #b91c1c; }
  @media (prefers-color-scheme: dark) { .plus { color: #4ade80; } .minus { color: #f87171; } }
  details.fold > summary {
    cursor: pointer; font-size: .8rem; opacity: .6; margin: 1.2rem 0 .6rem;
  }
  .wtable { font-size: .8rem; opacity: .75; margin-top: .5rem; }
  .wtable td { padding: .15rem .9rem .15rem 0; }
  .wtable code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  form.missed { margin: .4rem 0 0; }
  form.missed button {
    font: inherit; font-size: .74rem; cursor: pointer; padding: .12rem .5rem;
    border-radius: 5px; background: none; color: inherit; opacity: .65;
    border: 1px solid color-mix(in srgb, CanvasText 20%, transparent);
  }
  form.missed button:hover { opacity: 1; }
`;

/**
 * Signal names are internal; these are what they mean.
 *
 * A `detail` from the scorer is usually already a sentence fragment and reads
 * better than anything written here, so it wins where it exists.
 */
const PHRASES: Record<string, string> = {
  "awaiting-reply": "waiting on his reply",
  aging: "unanswered a while",
  "addressed-to": "addressed directly to him",
  "addressed-cc": "he is only Cc'd",
  "known-correspondent": "someone he writes to",
  "never-corresponded": "he has never written to this address",
  "relationship-live": "recent back-and-forth",
  "meeting-soon": "he is meeting them soon",
  "met-recently": "met recently, nothing sent since",
  "explicit-ask": "contains a direct ask",
  conversation: "an active thread",
  automated: "machine sender",
  "notification-relay": "app notification, not real email",
  "bulk-mail": "mailing list",
};

function phrase(s: Signal): string {
  return s.detail ?? PHRASES[s.name] ?? s.name;
}

/** The two or three signals that actually decided it, plus what held it back. */
function why(t: ScoredThread): string {
  const positive = [...t.signals]
    .filter((s) => s.points > 0)
    .sort((a, b) => b.points - a.points)
    .slice(0, 3)
    .map((s) => escapeHtml(phrase(s)));

  const negative = [...t.signals]
    .filter((s) => s.points < 0)
    .sort((a, b) => a.points - b.points)
    .slice(0, 1)
    .map((s) => `<span class="neg">${escapeHtml(phrase(s))}</span>`);

  const parts = [...positive, ...negative];
  return parts.length ? parts.join(" &middot; ") : "no signals fired";
}

function chips(t: ScoredThread): string {
  return t.signals
    .map(
      (s) =>
        `<span class="chip ${s.points >= 0 ? "plus" : "minus"}">${
          s.points >= 0 ? "+" : ""
        }${Math.round(s.points)} ${escapeHtml(s.name)}${
          s.detail ? ` ${escapeHtml(s.detail)}` : ""
        }</span>`,
    )
    .join("");
}

/**
 * The false-negative path.
 *
 * He will never think to report the email we did not show him — he does not
 * know it exists. This is the only place it can be caught by hand, which is why
 * the below-floor list is worth keeping visible at all.
 */
function missedButton(t: ScoredThread): string {
  const key = `${t.candidate.accountId}:${t.candidate.gmailThreadId}`;
  return `
    <form class="missed" method="post" action="/feedback">
      <input type="hidden" name="thread_key" value="${escapeHtml(key)}">
      <input type="hidden" name="score" value="${Math.round(t.score)}">
      <button type="submit" name="choice" value="missed">This should have surfaced</button>
    </form>`;
}

function renderRow(t: ScoredThread, above: boolean): string {
  const c = t.candidate;
  return `
    <div class="srow ${above ? "above" : "below"}">
      <div class="sscore">${Math.round(t.score)}</div>
      <div>
        <div class="ssubject">${escapeHtml(c.subject ?? "(no subject)")}</div>
        <div class="sfrom">${escapeHtml(c.fromName || c.fromEmail || "unknown")} &rarr; ${escapeHtml(
          c.accountEmail,
        )}</div>
        <div class="swhy">${why(t)}</div>
        <details class="sig">
          <summary>points</summary>
          <div class="chips">${chips(t)}</div>
        </details>
        ${above ? "" : missedButton(t)}
      </div>
    </div>`;
}

const WEIGHTS_TABLE = (): string => `
  <table class="wtable">
    <tr><td><code>AWAITING_REPLY</code></td><td>+${W.AWAITING_REPLY}</td><td>last message inbound, no reply since</td></tr>
    <tr><td><code>aging</code></td><td>+${W.agingScore(0.5)} &hellip; +${W.agingScore(4)} &hellip; +${W.agingScore(40)}</td><td>peaks at 2-7 days, falls off after 14</td></tr>
    <tr><td><code>ADDRESSED_TO</code></td><td>+${W.ADDRESSED_TO} / +${W.ADDRESSED_CC}</td><td>To: versus Cc:</td></tr>
    <tr><td><code>known-correspondent</code></td><td>+${W.correspondentScore(1)} / +${W.correspondentScore(3)} / +${W.correspondentScore(10)}</td><td>by how often he writes to them</td></tr>
    <tr><td><code>NEVER_CORRESPONDED</code></td><td>${W.NEVER_CORRESPONDED}</td><td>he has never written to this address</td></tr>
    <tr><td><code>MEETING_SOON</code></td><td>+${W.MEETING_SOON}</td><td>meeting with the sender inside ${W.MEETING_SOON_HOURS}h</td></tr>
    <tr><td><code>MET_RECENTLY</code></td><td>+${W.MET_RECENTLY}</td><td>met within ${W.MET_RECENTLY_DAYS} days, nothing sent since</td></tr>
    <tr><td><code>EXPLICIT_ASK</code></td><td>+${W.EXPLICIT_ASK}</td><td>question, deadline, or chase detected</td></tr>
    <tr><td><code>NOTIFICATION_RELAY</code></td><td>${W.NOTIFICATION_RELAY}</td><td>Slack, Discord, Google Voice and similar</td></tr>
    <tr><td><code>AUTOMATED</code></td><td>${W.AUTOMATED}</td><td>machine sender or bulk headers</td></tr>
    <tr><td><code>LIST_UNSUBSCRIBE</code></td><td>${W.LIST_UNSUBSCRIBE}</td><td>mailing list, on top of automated</td></tr>
  </table>`;

export function renderScoringSection(scored: ScoredThread[]): string {
  const above = scored.filter((t) => t.score >= W.MIN_SCORE_FOR_BRIEF);
  const below = scored.filter((t) => t.score < W.MIN_SCORE_FOR_BRIEF);

  if (scored.length === 0) {
    return `<div class="empty">No candidates right now. Sync first, or every thread is older than ${W.CANDIDATE_MAX_AGE_DAYS} days.</div>`;
  }

  return `
    ${
      above.length
        ? above.map((t) => renderRow(t, true)).join("")
        : `<div class="empty">Nothing clears the floor of ${W.MIN_SCORE_FOR_BRIEF} right now.</div>`
    }
    ${
      below.length
        ? `<details class="fold">
             <summary>${below.length} below the floor of ${W.MIN_SCORE_FOR_BRIEF}</summary>
             ${below.map((t) => renderRow(t, false)).join("")}
           </details>`
        : ""
    }
    <details class="fold">
      <summary>Current weights</summary>
      ${WEIGHTS_TABLE()}
    </details>`;
}
