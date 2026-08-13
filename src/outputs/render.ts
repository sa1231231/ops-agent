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

/**
 * Forces the message into the GSM-7 character set.
 *
 * SMS bills per segment, and a single character outside GSM-7 switches the
 * whole message to UCS-2 — which drops the segment size from 153 characters to
 * 67 and roughly doubles the cost. Emoji are the obvious culprit, but an em dash
 * or a curly apostrophe does it just as thoroughly, and the model produces those
 * constantly. Normalising here is what makes dropping the emoji actually pay.
 */
export function toGsm7(text: string): string {
  return text
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[–—―]/g, "-")
    .replace(/…/g, "...")
    .replace(/[   ]/g, " ")
    .replace(/[•·]/g, "-")
    .replace(/→/g, "->")
    .replace(/[≤]/g, "<=")
    .replace(/[≥]/g, ">=")
    .replace(/½/g, "1/2")
    // Anything still outside the printable ASCII range would flip the encoding,
    // so it goes rather than silently doubling the bill.
    .replace(/[^\x0A\x20-\x7E]/g, "");
}

/** Full multi-line brief. Used for SMS, the web page, and operator previews. */
export function renderPlainText(
  brief: ComposedBrief,
  opts: RenderOptions,
): string {
  const lines: string[] = [`Good morning - ${opts.localDate}`, ""];

  lines.push("TODAY");
  lines.push(brief.meetings_line || "No meetings today");
  if (brief.conflicts_line) lines.push(`Conflicts: ${brief.conflicts_line}`);
  lines.push("");

  if (brief.emails.length > 0) {
    lines.push("NEEDS YOU");
    brief.emails.forEach((e, i) => {
      // Reason on the same line rather than its own indented row: it halves the
      // section's length, and on a phone the wrap looks the same either way.
      lines.push(`${i + 1}. ${e.line}${e.reason ? ` (${e.reason})` : ""}`);
    });
    lines.push("");
  }

  if (brief.priorities.length > 0) {
    lines.push("PRIORITIES");
    brief.priorities.forEach((p, i) => lines.push(`${i + 1}. ${p}`));
    lines.push("");
  }

  if (opts.skippedAccounts.length > 0) {
    lines.push(`Could not read: ${opts.skippedAccounts.join(", ")}`);
    lines.push("");
  }

  lines.push(opts.briefUrl);

  return toGsm7(lines.join("\n").replace(/\n{3,}/g, "\n\n").trim());
}

/**
 * SMS bills per 160-character segment, or 70 if anything falls outside GSM-7.
 * Concatenated messages spend a few characters per segment on headers, hence
 * 153 and 67 rather than 160 and 70.
 */
export function estimateSegments(text: string): number {
  const unicode = /[^\x0A\x20-\x7E]/.test(text);
  const perSegment = unicode ? 67 : 153;
  return Math.max(1, Math.ceil(text.length / perSegment));
}
