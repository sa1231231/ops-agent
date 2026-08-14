/**
 * When a message says a date, work out which day it meant.
 *
 * The existing `deadline` ask-pattern matches the *words* — "by Friday", "due",
 * "EOD" — and scores them the same whether Friday is tomorrow or was three weeks
 * ago. That is the difference between "this mentions a deadline" and "the
 * deadline he was given is today", and only the second belongs at the top of a
 * morning brief.
 *
 * Deliberately conservative. A missed deadline is recoverable; a confidently
 * wrong one ("this is due today" when it is not) is the kind of error that makes
 * someone stop reading. Anything ambiguous returns null and the thread falls
 * back to ordinary scoring.
 */

export type DeadlineState = "overdue" | "today" | "tomorrow" | "later";

export interface Deadline {
  /** Local calendar date, as YYYY-MM-DD. */
  date: string;
  /** The words that produced it, for the scoring breakdown. */
  phrase: string;
  state: DeadlineState;
}

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

const MONTHS = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
] as const;

/** Local Y/M/D for an instant, without going through string parsing twice. */
function localParts(at: Date, timeZone: string): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

function toKey(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Day-of-week for a local calendar date, via a UTC proxy so no zone shifts it. */
function dayOfWeek(y: number, m: number, d: number): number {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function addDaysTo(y: number, m: number, d: number, days: number): string {
  const at = new Date(Date.UTC(y, m - 1, d + days));
  return toKey(at.getUTCFullYear(), at.getUTCMonth() + 1, at.getUTCDate());
}

/**
 * Resolves a deadline mentioned in `text`, relative to when it was sent.
 *
 * Relative to the *message*, not to now: "by Friday" in a message from two weeks
 * ago meant that Friday, and treating it as the upcoming one would invent a
 * deadline nobody set.
 */
export function extractDeadline(
  text: string,
  sentAt: Date,
  timeZone: string,
): { date: string; phrase: string } | null {
  const haystack = text.toLowerCase();
  const { y, m, d } = localParts(sentAt, timeZone);

  // Same-day language.
  const sameDay = /\b(by\s+)?(eod|end of (the )?day|today|by close of business|by cob)\b/.exec(
    haystack,
  );
  if (sameDay) return { date: toKey(y, m, d), phrase: sameDay[0].trim() };

  const tomorrow = /\bby tomorrow\b|\btomorrow\b/.exec(haystack);
  if (tomorrow) return { date: addDaysTo(y, m, d, 1), phrase: tomorrow[0].trim() };

  // "by Friday", "on Monday", "this Thursday" — the next such weekday on or
  // after the send date.
  const weekday =
    /\b(?:by|on|before|this|next|due)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/.exec(
      haystack,
    );
  if (weekday?.[1]) {
    const target = WEEKDAYS.indexOf(weekday[1] as (typeof WEEKDAYS)[number]);
    const current = dayOfWeek(y, m, d);
    let delta = (target - current + 7) % 7;
    // "next Friday" said on a Friday means the one after, not today.
    if (delta === 0 && /\bnext\b/.test(weekday[0])) delta = 7;
    return { date: addDaysTo(y, m, d, delta), phrase: weekday[0].trim() };
  }

  const endOfWeek = /\b(eow|end of (the )?week)\b/.exec(haystack);
  if (endOfWeek) {
    const current = dayOfWeek(y, m, d);
    return { date: addDaysTo(y, m, d, (5 - current + 7) % 7), phrase: endOfWeek[0].trim() };
  }

  // "by August 20", "due Aug 20th"
  const monthName =
    /\b(?:by|before|due|on)\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/.exec(
      haystack,
    );
  if (monthName?.[1] && monthName[2]) {
    const month = MONTHS.indexOf(monthName[1] as (typeof MONTHS)[number]) + 1;
    const day = Number(monthName[2]);
    if (day >= 1 && day <= 31) {
      // A month earlier than the send month means next year, not the past.
      const year = month < m ? y + 1 : y;
      return { date: toKey(year, month, day), phrase: monthName[0].trim() };
    }
  }

  // "by 8/20". Deliberately requires a leading preposition: bare numbers like
  // "9/10 stars" or a version string would otherwise read as dates.
  const numeric = /\b(?:by|before|due|on)\s+(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(haystack);
  if (numeric?.[1] && numeric[2]) {
    const month = Number(numeric[1]);
    const day = Number(numeric[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const rawYear = numeric[3] ? Number(numeric[3]) : null;
      const year = rawYear === null ? (month < m ? y + 1 : y) : rawYear < 100 ? 2000 + rawYear : rawYear;
      return { date: toKey(year, month, day), phrase: numeric[0].trim() };
    }
  }

  return null;
}

/** How far past this deadline we still consider it live rather than history. */
const OVERDUE_GRACE_DAYS = 10;

/**
 * The deadline for a thread, as of `now`.
 *
 * Returns null when there is no date, or when it is far enough in the past that
 * mentioning it would be archaeology rather than a reminder.
 */
export function deadlineFor(
  text: string,
  sentAt: Date | null,
  now: Date,
  timeZone: string,
): Deadline | null {
  if (!sentAt) return null;
  const found = extractDeadline(text, sentAt, timeZone);
  if (!found) return null;

  const today = localParts(now, timeZone);
  const todayKey = toKey(today.y, today.m, today.d);
  const tomorrowKey = addDaysTo(today.y, today.m, today.d, 1);

  let state: DeadlineState;
  if (found.date === todayKey) state = "today";
  else if (found.date === tomorrowKey) state = "tomorrow";
  else if (found.date < todayKey) {
    const cutoff = addDaysTo(today.y, today.m, today.d, -OVERDUE_GRACE_DAYS);
    if (found.date < cutoff) return null;
    state = "overdue";
  } else state = "later";

  return { date: found.date, phrase: found.phrase, state };
}
