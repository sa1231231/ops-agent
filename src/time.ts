import { optionalEnv } from "./config.js";

/**
 * Timezone-correct day boundaries.
 *
 * Everything user-facing happens in his local day, but the server runs in UTC
 * and Railway's cron is UTC. Flooring a UTC timestamp to midnight is wrong for
 * most of the day: at 8pm in New York the UTC date has already rolled over, so
 * a UTC-derived "today" silently points at tomorrow.
 *
 * Deriving offsets from Intl rather than a fixed number also means DST is
 * handled for free — no twice-yearly hour shift to remember.
 */

export const BRIEF_TZ = optionalEnv("BRIEF_TZ", "America/New_York");
export const BRIEF_HOUR = Number(optionalEnv("BRIEF_HOUR", "6"));

/** How far `date` in `tz` is from UTC, at that instant (DST-aware). */
function offsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);

  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");

  // Intl renders 24:00 for midnight under hour12:false in some engines.
  const hour = get("hour") % 24;

  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    hour,
    get("minute"),
    get("second"),
  );

  return asUtc - date.getTime();
}

/** `YYYY-MM-DD` for the local day containing `date`. */
export function localDateString(date: Date, timeZone = BRIEF_TZ): string {
  // en-CA renders ISO-shaped dates.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** The UTC instant of local midnight starting the day that contains `date`. */
export function startOfLocalDay(date: Date, timeZone = BRIEF_TZ): Date {
  const [y, m, d] = localDateString(date, timeZone).split("-").map(Number);
  const guess = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  // The offset at the guess is what we need to subtract. Computing it at the
  // guess rather than at `date` is what keeps DST-transition days correct.
  return new Date(guess - offsetMs(new Date(guess), timeZone));
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

/** Local hour (0–23) at `date`. Used to gate the morning brief. */
export function localHour(date: Date, timeZone = BRIEF_TZ): number {
  return (
    Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        hour12: false,
        hour: "2-digit",
      }).format(date),
    ) % 24
  );
}
