import type { ComposedBrief } from "../ranking/compose.js";

/**
 * Turns the composed brief into message text.
 *
 * Deliberately transport-agnostic and deterministic: the model returns
 * structured fields, and this decides how they read. Keeping formatting out of
 * the model means the layout can change without re-prompting, and two runs over
 * the same data produce byte-identical output.
 */

export interface RenderOptions {
  localDate: string;
  briefUrl: string;
  skippedAccounts: string[];
}

/** Full multi-line brief. Used for SMS, the web page, and operator previews. */
export function renderPlainText(
  brief: ComposedBrief,
  opts: RenderOptions,
): string {
  const lines: string[] = [`Good morning — ${opts.localDate}`, ""];

  lines.push(`📅 ${brief.meetings_line || "No meetings today"}`);
  if (brief.conflicts_line) lines.push(`⚠️ ${brief.conflicts_line}`);
  lines.push("");

  if (brief.emails.length > 0) {
    lines.push("📧 Needs you:");
    brief.emails.forEach((e, i) => {
      lines.push(`${i + 1}. ${e.line}`);
      if (e.reason) lines.push(`   — ${e.reason}`);
    });
    lines.push("");
  }

  if (brief.priorities.length > 0) {
    lines.push("🎯 Priorities:");
    brief.priorities.forEach((p, i) => lines.push(`${i + 1}. ${p}`));
    lines.push("");
  }

  if (opts.skippedAccounts.length > 0) {
    lines.push(`⚠️ Could not read: ${opts.skippedAccounts.join(", ")}`);
    lines.push("");
  }

  lines.push(`Full brief: ${opts.briefUrl}`);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * SMS bills per 160-character segment (70 if any non-GSM character appears, and
 * emoji force that mode). A brief this size is a handful of segments either way,
 * but a runaway one should be truncated rather than silently cost a fortune.
 */
export function estimateSegments(text: string): number {
  const unicode = /[^\x20-\x7E\n]/.test(text);
  const perSegment = unicode ? 67 : 153; // concatenated-message headers cost a few chars
  return Math.max(1, Math.ceil(text.length / perSegment));
}
