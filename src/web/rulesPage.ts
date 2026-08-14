import type {
  BriefRule,
  SenderRuleRow,
  ThreadRuleRow,
  WeightSuggestion,
} from "../db/queries/rules.js";
import { confidenceScale, effectivePoints } from "../signals/rules.js";
import { formatLocalDateTime } from "../time.js";
import { escapeHtml } from "./admin.js";

/**
 * Everything the system has learned, in one list.
 *
 * This page is the answer to "how do you know it isn't drifting". Every rule is
 * visible, attributed, counted, and deletable. A rule that has never fired is
 * dead weight; one that fires on everything is either load-bearing or far too
 * broad. Nothing accumulates in the dark, which is the actual mechanism behind
 * a system quietly getting worse.
 */

const STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    margin: 0; padding: 2.5rem 1.5rem 4rem; background: Canvas; color: CanvasText;
  }
  main { max-width: 940px; margin: 0 auto; }
  header { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; }
  h1 { font-size: 1.35rem; margin: 0; letter-spacing: -.01em; }
  a { color: inherit; }
  .sub { opacity: .6; font-size: .85rem; margin: .3rem 0 2rem; }
  h2 {
    font-size: .72rem; text-transform: uppercase; letter-spacing: .07em;
    opacity: .55; font-weight: 700; margin: 0 0 .3rem;
  }
  .section-sub { opacity: .55; font-size: .82rem; margin: 0 0 1rem; max-width: 68ch; }
  .block { margin-bottom: 2.75rem; }
  table { width: 100%; border-collapse: collapse; }
  th {
    text-align: left; font-size: .68rem; text-transform: uppercase;
    letter-spacing: .06em; opacity: .5; padding: 0 .6rem .4rem; font-weight: 600;
  }
  td {
    padding: .55rem .6rem;
    border-top: 1px solid color-mix(in srgb, CanvasText 11%, transparent);
    vertical-align: top;
  }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .88em; }
  .pts { font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .pos { color: #15803d; } .neg { color: #b91c1c; }
  @media (prefers-color-scheme: dark) { .pos { color: #4ade80; } .neg { color: #f87171; } }
  .muted { opacity: .55; font-size: .82rem; }
  .cold { opacity: .5; }
  .warnrow { background: color-mix(in srgb, #d97706 10%, transparent); }
  .linkbtn {
    background: none; border: 0; padding: 0; color: #b91c1c;
    font: inherit; font-size: .8rem; cursor: pointer; text-decoration: underline;
  }
  @media (prefers-color-scheme: dark) { .linkbtn { color: #f87171; } }
  form.inline { margin: 0; }
  .empty { padding: 1.5rem 0; opacity: .55; font-size: .9rem; }
  .addrow { display: flex; gap: .5rem; margin-top: .8rem; max-width: 680px; }
  input[type=text] {
    flex: 1; padding: .5rem .65rem; font: inherit; font-size: .9rem;
    border: 1px solid color-mix(in srgb, CanvasText 25%, transparent);
    border-radius: 6px; background: Canvas; color: CanvasText;
  }
  button.primary {
    padding: .5rem .95rem; font: inherit; font-size: .875rem; font-weight: 600;
    border: 0; border-radius: 6px; background: CanvasText; color: Canvas; cursor: pointer;
  }
  .sugg {
    border: 1px solid color-mix(in srgb, CanvasText 13%, transparent);
    border-left: 3px solid #d97706;
    border-radius: 0 8px 8px 0; padding: .7rem .9rem; margin-bottom: .6rem; font-size: .9rem;
  }
`;

function points(rule: SenderRuleRow): string {
  const effective = effectivePoints(rule);
  const pct = Math.round(confidenceScale(rule.confidence) * 100);
  return `<span class="pts ${effective >= 0 ? "pos" : "neg"}">${
    effective >= 0 ? "+" : ""
  }${effective}</span> <span class="muted">of ${
    rule.adjustment >= 0 ? "+" : ""
  }${rule.adjustment} (${pct}%)</span>`;
}

function senderTable(rules: SenderRuleRow[]): string {
  if (rules.length === 0) {
    return `<div class="empty">No sender rules yet. They appear here when you mark a brief item as unimportant.</div>`;
  }

  const rows = rules
    .map((r) => {
      // A rule that has never fired is either too specific or obsolete; either
      // way it is worth seeing at a glance.
      const cold = r.timesFired === 0;
      return `
      <tr class="${cold ? "cold" : ""}">
        <td><code>${escapeHtml(r.pattern)}</code>${
          r.accountEmail
            ? `<div class="muted">only on ${escapeHtml(r.accountEmail)}</div>`
            : ""
        }</td>
        <td>${points(r)}</td>
        <td>${r.confidence}</td>
        <td>${escapeHtml(r.reason ?? "—")}</td>
        <td>${r.timesFired}${
          r.lastFiredAt
            ? `<div class="muted">${escapeHtml(formatLocalDateTime(r.lastFiredAt))}</div>`
            : `<div class="muted">never</div>`
        }</td>
        <td>
          <form class="inline" method="post" action="/rules/delete">
            <input type="hidden" name="kind" value="sender">
            <input type="hidden" name="id" value="${r.id}">
            <button type="submit" class="linkbtn">Remove</button>
          </form>
        </td>
      </tr>`;
    })
    .join("");

  return `<table>
    <thead><tr>
      <th>Pattern</th><th>Applied</th><th>Votes</th><th>Why</th><th>Fired</th><th></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function threadTable(rules: ThreadRuleRow[]): string {
  if (rules.length === 0) {
    return `<div class="empty">No thread rules. Marking an item "already handled" mutes it here.</div>`;
  }

  const rows = rules
    .map(
      (r) => `
      <tr>
        <td>${escapeHtml(r.subject ?? r.threadKey)}</td>
        <td><span class="pts ${r.verdict === "pin" ? "pos" : "neg"}">${
          r.verdict === "pin" ? "pinned" : "muted"
        }</span></td>
        <td>${
          r.expiresAt
            ? escapeHtml(formatLocalDateTime(r.expiresAt))
            : '<span class="muted">no expiry</span>'
        }</td>
        <td>${escapeHtml(r.reason ?? "—")}</td>
        <td>
          <form class="inline" method="post" action="/rules/delete">
            <input type="hidden" name="kind" value="thread">
            <input type="hidden" name="id" value="${r.id}">
            <button type="submit" class="linkbtn">Remove</button>
          </form>
        </td>
      </tr>`,
    )
    .join("");

  return `<table>
    <thead><tr><th>Thread</th><th>Verdict</th><th>Expires</th><th>Why</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function houseTable(rules: BriefRule[]): string {
  const rows = rules
    .map(
      (r) => `
      <tr>
        <td>${escapeHtml(r.rule)}</td>
        <td>
          <form class="inline" method="post" action="/rules/delete">
            <input type="hidden" name="kind" value="house">
            <input type="hidden" name="id" value="${r.id}">
            <button type="submit" class="linkbtn">Remove</button>
          </form>
        </td>
      </tr>`,
    )
    .join("");

  return `
    ${
      rules.length
        ? `<table><tbody>${rows}</tbody></table>`
        : `<div class="empty">No standing instructions.</div>`
    }
    <form method="post" action="/rules/house">
      <div class="addrow">
        <input type="text" name="rule" maxlength="240"
               placeholder="e.g. Never use an email address as someone's name">
        <button type="submit" class="primary">Add</button>
      </div>
    </form>`;
}

export function renderRulesPage(
  senders: SenderRuleRow[],
  threads: ThreadRuleRow[],
  house: BriefRule[],
  suggestions: WeightSuggestion[],
  feedbackCount: number,
): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Rules — ops-agent</title>
  <style>${STYLE}</style>
</head>
<body>
  <main>
    <header>
      <h1>Rules</h1>
      <a href="/briefs">Briefs →</a>
    </header>
    <div class="sub">
      Everything the system has learned, from ${feedbackCount} verdict${feedbackCount === 1 ? "" : "s"}.
      Every rule adjusts a score — none of them can silence a thread outright.
    </div>

    <div class="block">
      <h2>Senders</h2>
      <p class="section-sub">
        Repeat verdicts raise the vote count, and the applied points scale with it —
        so one bad morning cannot blacklist a real correspondent, and a young rule
        stays weak enough for other signals to overrule it.
      </p>
      ${senderTable(senders)}
    </div>

    <div class="block">
      <h2>Threads</h2>
      <p class="section-sub">
        Mutes expire, deliberately. A conversation handled on a call looks unanswered
        forever; one that comes back to life months later is genuinely new.
      </p>
      ${threadTable(threads)}
    </div>

    <div class="block">
      <h2>Standing instructions</h2>
      <p class="section-sub">
        Injected into the prompt for things arithmetic cannot express. The least
        reliable layer — the model usually obeys — so keep it small and push
        anything that can be a number down into a sender rule instead.
      </p>
      ${houseTable(house)}
    </div>

    <div class="block">
      <h2>Suggestions</h2>
      <p class="section-sub">
        Patterns across the verdicts so far. These change nothing on their own;
        they are a prompt to look, and any weight change is a code change.
      </p>
      ${
        suggestions.length
          ? suggestions
              .map(
                (s) =>
                  `<div class="sugg"><code>${escapeHtml(s.signal)}</code> — ${escapeHtml(s.verdict)}</div>`,
              )
              .join("")
          : `<div class="empty">Not enough verdicts yet. Suggestions need at least five judgements on a signal before they mean anything.</div>`
      }
    </div>
  </main>
</body>
</html>`;
}
