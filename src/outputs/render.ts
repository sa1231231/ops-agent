import type { ComposedBrief } from "../ranking/compose.js";
import type { Conflict, Meeting } from "../ranking/meetings.js";
import { BRIEF_TZ } from "../time.js";

/**
 * Turns the composed brief into message text.
 *
 * Deliberately transport-agnostic and deterministic: the model returns
 * structured fields, and this decides how they read. Keeping formatting out of
 * the model means the layout can change without re-prompting, and two runs over
 * the same data produce byte-identical output.
 *
 * The schedule is rendered here from calendar rows rather than described by the
 * model. Times and titles are facts already in the database — asking a model to
 * restate them spends tokens and adds a way to be wrong about the one part of
 * the brief that has a single correct answer.
 */

export interface RenderOptions {
  localDate: string;
  briefUrl: string;
  skippedAccounts: string[];
  /** Pre-rendered by `meetingLines()`; one meeting per entry. */
  meetings: string[];
  /** Pre-rendered by `conflictLines()`. */
  conflicts: string[];
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
    .replace(/[   ]/g, " ")
    .replace(/[•·]/g, "-")
    .replace(/→/g, "->")
    .replace(/[≤]/g, "<=")
    .replace(/[≥]/g, ">=")
    .replace(/½/g, "1/2")
    // Anything still outside the printable ASCII range would flip the encoding,
    // so it goes rather than silently doubling the bill.
    .replace(/[^\x0A\x20-\x7E]/g, "");
}

/** Truncates at a word boundary, so a clipped title never ends mid-word. */
function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 3);
  const space = cut.lastIndexOf(" ");
  const kept = space > max * 0.6 ? cut.slice(0, space) : cut;
  return `${kept.replace(/[\s,;:.\-]+$/, "")}...`;
}

function meetingTime(m: Meeting): string {
  if (m.allDay) return "All day";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: BRIEF_TZ,
    hour: "numeric",
    minute: "2-digit",
  }).format(m.startsAt);
}

const MEETING_TITLE_MAX = 46;
const CONFLICT_TITLE_MAX = 26;

/** One line per meeting: the time first, because that is what he scans for. */
export function meetingLines(meetings: Meeting[]): string[] {
  return meetings.map(
    (m) => `${meetingTime(m)}  ${clip(m.title ?? "(untitled)", MEETING_TITLE_MAX)}`,
  );
}

/**
 * Conflicts read as part of the schedule rather than as a separate warning
 * section — they are a property of the day, and splitting them off meant
 * reading the same two meetings twice.
 */
export function conflictLines(conflicts: Conflict[]): string[] {
  return conflicts.map((c) => {
    const a = `${meetingTime(c.a)} ${clip(c.a.title ?? "(untitled)", CONFLICT_TITLE_MAX)}`;
    const b = `${meetingTime(c.b)} ${clip(c.b.title ?? "(untitled)", CONFLICT_TITLE_MAX)}`;
    return c.kind === "overlap"
      ? `Overlap - ${a} and ${b}`
      : `No gap - ${a} runs into ${b}`;
  });
}

/** "Thursday, Aug 14". Noon UTC so the weekday is right in every timezone. */
function dayLabel(localDate: string): string {
  const at = new Date(`${localDate}T12:00:00Z`);
  if (Number.isNaN(at.getTime())) return localDate;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "short",
    day: "numeric",
  }).format(at);
}

/**
 * Full multi-line brief. Used for SMS, the web page, and operator previews.
 *
 * Ordered schedule → priorities → replies. The schedule is fixed and time-bound
 * so it goes first; priorities are what he decides to do about the day; replies
 * are the backlog he works through around them.
 */
export function renderPlainText(
  brief: ComposedBrief,
  opts: RenderOptions,
): string {
  const lines: string[] = [dayLabel(opts.localDate), ""];

  lines.push(opts.meetings.length ? `MEETINGS (${opts.meetings.length})` : "MEETINGS");
  if (opts.meetings.length === 0) {
    lines.push("Nothing on the calendar today.");
  } else {
    lines.push(...opts.meetings);
  }

  if (opts.conflicts.length > 0) {
    lines.push("");
    for (const conflict of opts.conflicts) lines.push(conflict);
  }
  lines.push("");

  if (brief.priorities.length > 0) {
    lines.push("PRIORITIES");
    brief.priorities.forEach((p, i) => {
      lines.push(`${i + 1}. ${p}`);
    });
    lines.push("");
  }

  if (brief.emails.length > 0) {
    lines.push("NEEDS A REPLY");
    brief.emails.forEach((e, i) => {
      lines.push(`${i + 1}. ${e.line}`);
      // The reason gets its own indented line rather than a parenthetical: it is
      // the part he reads to decide whether to act now, and it was disappearing
      // into the wrap when it trailed the subject.
      if (e.reason) lines.push(`   ${e.reason}`);
    });
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
