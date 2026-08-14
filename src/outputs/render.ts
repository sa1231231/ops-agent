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
  skippedAccounts: string[];
  /** Pre-rendered by `meetingLines()`; one meeting per entry. */
  meetings: string[];
  /** Pre-rendered by `conflictLines()`. */
  conflicts: string[];
  /** Addressed in the greeting. Empty for a bare "Good morning". */
  greetingName: string;
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
 * Only genuine double-bookings reach the message.
 *
 * `findConflicts` also reports back-to-backs, which are worth knowing about but
 * are not problems — his standups butt against each other every single morning,
 * so a "no gap" line fired daily and taught him to skip the section. A meeting
 * he cannot attend because he is in another one is the thing that needs him.
 *
 * Overlapping meetings are grouped into clusters rather than listed pairwise: a
 * triple booking produces three pairs, and three lines describing one problem
 * reads as three problems.
 */
export function conflictLines(conflicts: Conflict[]): string[] {
  const overlaps = conflicts.filter((c) => c.kind === "overlap");
  if (overlaps.length === 0) return [];

  // Union-find over meetings, keyed by identity: anything transitively
  // overlapping belongs in one line.
  const clusters: Meeting[][] = [];
  for (const { a, b } of overlaps) {
    const found = clusters.filter((c) => c.includes(a) || c.includes(b));
    const merged = [...new Set([...found.flat(), a, b])];
    for (const c of found) clusters.splice(clusters.indexOf(c), 1);
    clusters.push(merged);
  }

  return clusters.map((cluster) => {
    const sorted = [...cluster].sort(
      (x, y) => x.startsAt.getTime() - y.startsAt.getTime(),
    );
    const label =
      sorted.length === 2
        ? "Double-booked"
        : sorted.length === 3
          ? "Triple-booked"
          : `${sorted.length} meetings overlap`;
    const parts = sorted.map(
      (m) => `${meetingTime(m)} ${clip(m.title ?? "(untitled)", CONFLICT_TITLE_MAX)}`,
    );
    return `${label} - ${parts.join(" / ")}`;
  });
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
  // No date line. He reads this the morning it is sent, on a phone that already
  // shows him the date twice.
  const greeting = opts.greetingName
    ? `Good morning, ${opts.greetingName}`
    : "Good morning";
  const lines: string[] = [greeting, ""];

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

  // Both numbered sections get a blank line after every item. They wrap on a
  // phone, and without the separation a run of wrapped items reads as one
  // paragraph — which is the whole thing this layout exists to avoid.
  if (brief.priorities.length > 0) {
    lines.push("PRIORITIES");
    brief.priorities.forEach((p, i) => {
      lines.push(`${i + 1}. ${p}`);
      lines.push("");
    });
  }

  if (brief.emails.length > 0) {
    lines.push("NEEDS ATTENTION");
    // Deliberately not "needs a reply". Plenty of what belongs here is not a
    // reply at all: a deadline he was given that lands today, a commitment he
    // made, a meeting with no agenda. Naming the section after one of its cases
    // was quietly narrowing what could go in it.
    //
    // `reason` is still composed and still stored — carry-over, the brief page,
    // and the history all use it. It just does not go in the message: "unanswered
    // 4 days, deadline today" restated what the line above already said.
    brief.emails.forEach((e, i) => {
      lines.push(`${i + 1}. ${e.line}`);
      lines.push("");
    });
  }

  if (opts.skippedAccounts.length > 0) {
    lines.push(`Could not read: ${opts.skippedAccounts.join(", ")}`);
  }

  // No link. The brief page is still built and still stored — the console's
  // history links to it — but the message is meant to be complete on its own,
  // and a URL he never taps is a segment he pays for every morning.
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
