import * as W from "../signals/weights.js";
import { escapeHtml } from "./admin.js";

/**
 * Why a thread was chosen, in words.
 *
 * This used to be a live "ranking right now" list — every candidate currently in
 * the database, rescored on page load. It was busy and it answered a question
 * nobody asks: the question is always about a *particular brief* ("why was that
 * in there"), and a list recomputed from today's mail cannot answer it, because
 * the mail and the correspondent graph have moved on since.
 *
 * So the explanation moved to where the question is asked — onto the item inside
 * the brief card, read from the `scoring` snapshot stored with that brief. Same
 * information, at the moment it means something.
 */

/** Shape shared by the live scorer and the stored per-brief snapshot. */
export interface SignalLike {
  name: string;
  points: number;
  detail?: string | null;
}

export const SCORING_STYLE = `
  .why-line { font-size: .82rem; opacity: .75; margin: .35rem 0 0; }
  .why-line .neg { color: #b91c1c; opacity: .85; }
  @media (prefers-color-scheme: dark) { .why-line .neg { color: #f87171; } }
  .why-score {
    font-variant-numeric: tabular-nums; font-weight: 700; font-size: .74rem;
    padding: .02rem .35rem; border-radius: 4px; margin-right: .4rem;
    background: color-mix(in srgb, CanvasText 9%, transparent);
  }
  details.sig { margin-top: .25rem; }
  details.sig > summary {
    cursor: pointer; font-size: .72rem; opacity: .45; list-style: none;
  }
  details.sig > summary::before { content: "+ "; }
  details.sig[open] > summary::before { content: "- "; }
  details.sig > summary:hover { opacity: .8; }
  .chips { display: flex; flex-wrap: wrap; gap: .25rem; margin: .3rem 0 .2rem; }
  .chip {
    font-size: .7rem; padding: .08rem .4rem; border-radius: 5px; white-space: nowrap;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .plus  { background: color-mix(in srgb, #16a34a 16%, transparent); color: #15803d; }
  .minus { background: color-mix(in srgb, #dc2626 16%, transparent); color: #b91c1c; }
  @media (prefers-color-scheme: dark) { .plus { color: #4ade80; } .minus { color: #f87171; } }
  details.fold > summary {
    cursor: pointer; font-size: .8rem; opacity: .6; margin: .4rem 0;
  }
  .wtable { font-size: .8rem; opacity: .75; margin-top: .5rem; }
  .wtable td { padding: .15rem .9rem .15rem 0; }
  .wtable code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
`;

/**
 * Signal names are internal; these are what they mean.
 *
 * A `detail` from the scorer is usually already a sentence fragment and reads
 * better than anything written here, so it wins where it exists.
 */
const PHRASES: Record<string, string> = {
  "awaiting-reply": "waiting on your reply",
  aging: "unanswered a while",
  "addressed-to": "addressed directly to you",
  "addressed-cc": "you were only Cc'd",
  "known-correspondent": "someone you write to",
  "never-corresponded": "you have never written to this address",
  "relationship-live": "recent back-and-forth",
  "meeting-soon": "you are meeting them soon",
  "met-recently": "you met recently, nothing sent since",
  "explicit-ask": "contains a direct ask",
  conversation: "an active thread",
  automated: "machine sender",
  "notification-relay": "app notification, not real email",
  "bulk-mail": "mailing list",
  "sender-promoted": "a rule you set promotes this sender",
  "sender-demoted": "a rule you set demotes this sender",
  "thread-pinned": "you pinned this thread",
  "thread-muted": "you muted this thread",
};

function phrase(s: SignalLike): string {
  return s.detail ?? PHRASES[s.name] ?? s.name;
}

/** The two or three signals that decided it, plus the one thing holding it back. */
function why(signals: SignalLike[]): string {
  const positive = [...signals]
    .filter((s) => s.points > 0)
    .sort((a, b) => b.points - a.points)
    .slice(0, 3)
    .map((s) => escapeHtml(phrase(s)));

  const negative = [...signals]
    .filter((s) => s.points < 0)
    .sort((a, b) => a.points - b.points)
    .slice(0, 1)
    .map((s) => `<span class="neg">${escapeHtml(phrase(s))}</span>`);

  const parts = [...positive, ...negative];
  return parts.length ? parts.join(" &middot; ") : "no signals fired";
}

function chips(signals: SignalLike[]): string {
  return signals
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
 * Why it was picked, behind one click.
 *
 * This was a visible line under every item, and it was the wrong call: on a page
 * whose job is "read the brief and judge it", a running commentary under each
 * line is noise between him and the thing he came to read. The reasoning still
 * has to be reachable, since a verdict on a ranking you cannot inspect is a
 * guess, so it is collapsed rather than removed. Plain English first, the
 * arithmetic below it, because the numbers are what you change.
 */
export function renderWhy(score: number | null, signals: SignalLike[]): string {
  if (signals.length === 0) return "";
  return `
    <details class="sig">
      <summary>Why this was picked</summary>
      <div class="why-line">
        ${score === null ? "" : `<span class="why-score">${Math.round(score)}</span>`}${why(signals)}
      </div>
      <div class="chips">${chips(signals)}</div>
    </details>`;
}

/** The weights themselves, for reference. Changing one means changing code. */
export function weightsTable(): string {
  return `
  <table class="wtable">
    <tr><td><code>AWAITING_REPLY</code></td><td>+${W.AWAITING_REPLY}</td><td>last message inbound, no reply since</td></tr>
    <tr><td><code>aging</code></td><td>+${W.agingScore(0.5)} &hellip; +${W.agingScore(4)} &hellip; +${W.agingScore(40)}</td><td>peaks at 2-7 days, falls off after 14</td></tr>
    <tr><td><code>ADDRESSED_TO</code></td><td>+${W.ADDRESSED_TO} / +${W.ADDRESSED_CC}</td><td>To: versus Cc:</td></tr>
    <tr><td><code>known-correspondent</code></td><td>+${W.correspondentScore(1)} / +${W.correspondentScore(3)} / +${W.correspondentScore(10)}</td><td>by how often you write to them</td></tr>
    <tr><td><code>NEVER_CORRESPONDED</code></td><td>${W.NEVER_CORRESPONDED}</td><td>you have never written to this address</td></tr>
    <tr><td><code>MEETING_SOON</code></td><td>+${W.MEETING_SOON}</td><td>meeting with the sender inside ${W.MEETING_SOON_HOURS}h</td></tr>
    <tr><td><code>MET_RECENTLY</code></td><td>+${W.MET_RECENTLY}</td><td>met within ${W.MET_RECENTLY_DAYS} days, nothing sent since</td></tr>
    <tr><td><code>EXPLICIT_ASK</code></td><td>+${W.EXPLICIT_ASK}</td><td>question, deadline, or chase detected</td></tr>
    <tr><td><code>DEADLINE_*</code></td><td>+${W.DEADLINE_TODAY} / +${W.DEADLINE_OVERDUE} / +${W.DEADLINE_TOMORROW}</td><td>a date the sender named, arriving today / passed / tomorrow</td></tr>
    <tr><td><code>NOTIFICATION_RELAY</code></td><td>${W.NOTIFICATION_RELAY}</td><td>Slack, Discord, Google Voice and similar</td></tr>
    <tr><td><code>AUTOMATED</code></td><td>${W.AUTOMATED}</td><td>machine sender or bulk headers</td></tr>
    <tr><td><code>LIST_UNSUBSCRIBE</code></td><td>${W.LIST_UNSUBSCRIBE}</td><td>mailing list, on top of automated</td></tr>
    <tr><td><code>SENDER_RULE_MAX</code></td><td>&plusmn;${W.SENDER_RULE_MAX}</td><td>the most any rule you set can move a score</td></tr>
    <tr><td><code>MIN_SCORE_FOR_BRIEF</code></td><td>${W.MIN_SCORE_FOR_BRIEF}</td><td>the floor: below this, nothing reaches the model</td></tr>
  </table>`;
}
