import { addDays, startOfLocalDay } from "../time.js";
import { googleFetch } from "./googleApi.js";

const BASE = "https://www.googleapis.com/calendar/v3";

/**
 * Calendar window: the prior two days through a week ahead, in *his* timezone.
 *
 * The lookback is deliberate. A meeting yesterday with nothing sent since is an
 * action item, and "lots of meetings the days prior" is half the problem this
 * system exists to solve.
 *
 * The lookahead is wider than the brief needs on purpose. The morning message
 * only reports today, but storing a week means "you have a demo Thursday and no
 * agenda yet" is answerable, and a future capability that has nothing to do with
 * mornings does not need a schema change to see next week.
 */
export const LOOKBACK_DAYS = 2;
export const LOOKAHEAD_DAYS = 7;

export interface NormalizedEvent {
  gcalEventId: string;
  /** Stable across every calendar the same meeting lands on. */
  icalUid: string | null;
  calendarId: string;
  title: string | null;
  description: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  allDay: boolean;
  attendees: Array<{ email: string; responseStatus?: string; optional?: boolean }>;
  organizerEmail: string | null;
  selfResponseStatus: string | null;
  status: string | null;
}

interface RawEvent {
  id: string;
  iCalUID?: string;
  summary?: string;
  description?: string;
  status?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  organizer?: { email?: string };
  attendees?: Array<{
    email?: string;
    responseStatus?: string;
    optional?: boolean;
    self?: boolean;
    resource?: boolean;
  }>;
}

interface CalendarListEntry {
  id: string;
  selected?: boolean;
  primary?: boolean;
  deleted?: boolean;
}

function toDate(slot: { dateTime?: string; date?: string } | undefined): Date | null {
  const raw = slot?.dateTime ?? slot?.date;
  return raw ? new Date(raw) : null;
}

function normalizeEvent(raw: RawEvent, calendarId: string): NormalizedEvent {
  const self = raw.attendees?.find((a) => a.self);
  return {
    gcalEventId: raw.id,
    icalUid: raw.iCalUID ?? null,
    calendarId,
    title: raw.summary ?? null,
    description: raw.description ?? null,
    startsAt: toDate(raw.start),
    endsAt: toDate(raw.end),
    // An all-day event uses `date` rather than `dateTime`. These must not
    // produce conflicts — an all-day marker overlaps everything.
    allDay: Boolean(raw.start?.date && !raw.start.dateTime),
    attendees: (raw.attendees ?? [])
      // Rooms and equipment are attendees to Google but not to a human.
      .filter((a) => a.email && !a.resource)
      .map((a) => ({
        email: a.email!.toLowerCase(),
        responseStatus: a.responseStatus,
        optional: a.optional,
      })),
    organizerEmail: raw.organizer?.email?.toLowerCase() ?? null,
    selfResponseStatus: self?.responseStatus ?? null,
    status: raw.status ?? null,
  };
}

/**
 * Google-generated subscription calendars. These carry no meetings — only
 * all-day markers — and would put "Labor Day" in a list of today's meetings.
 */
const SUBSCRIPTION_CALENDAR = /#(holiday|contacts|weeknum|sports)@/;

export async function listCalendarIds(accessToken: string): Promise<string[]> {
  const res = await googleFetch<{ items?: CalendarListEntry[] }>(
    `${BASE}/users/me/calendarList?minAccessRole=reader&showDeleted=false`,
    accessToken,
  );
  return (res.items ?? [])
    .filter(
      (c) =>
        !c.deleted &&
        !SUBSCRIPTION_CALENDAR.test(c.id) &&
        // `selected` reflects what he actually has visible in Gmail.
        (c.primary || c.selected !== false),
    )
    .map((c) => c.id);
}

/**
 * Boundaries are local midnights, not UTC midnights. At 8pm in New York the UTC
 * date has already rolled over, so a UTC-floored window points at the wrong day
 * for a third of every day.
 */
export function calendarWindow(now = new Date()): { timeMin: Date; timeMax: Date } {
  const today = startOfLocalDay(now);
  return {
    timeMin: addDays(today, -LOOKBACK_DAYS),
    // Exclusive upper bound at the local midnight *after* the last day we want.
    timeMax: addDays(today, LOOKAHEAD_DAYS + 1),
  };
}

export async function fetchEvents(
  accessToken: string,
  calendarId: string,
  now = new Date(),
): Promise<NormalizedEvent[]> {
  const { timeMin, timeMax } = calendarWindow(now);
  const events: NormalizedEvent[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      // Expands recurring events into individual instances, so a weekly standup
      // appears as today's occurrence rather than an abstract rule.
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "250",
      showDeleted: "false",
    });
    if (pageToken) params.set("pageToken", pageToken);

    const page = await googleFetch<{ items?: RawEvent[]; nextPageToken?: string }>(
      `${BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
      accessToken,
    );

    for (const raw of page.items ?? []) {
      // Declined and cancelled events are not on his day.
      if (raw.status === "cancelled") continue;
      const event = normalizeEvent(raw, calendarId);
      if (event.selfResponseStatus === "declined") continue;
      events.push(event);
    }

    pageToken = page.nextPageToken;
  } while (pageToken);

  return events;
}
