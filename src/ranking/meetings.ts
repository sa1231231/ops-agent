import { pool } from "../db/pool.js";
import { addDays, startOfLocalDay } from "../time.js";

/**
 * Today's schedule, merged across every connected calendar.
 *
 * Deduplication happens before overlap detection and is keyed on
 * (ical_uid, starts_at). Both halves matter: iCalUID identifies the same meeting
 * invited to several of his accounts, and starts_at keeps the occurrences of a
 * recurring event distinct. Keying on iCalUID alone collapses a week of standups
 * into one and silently drops real conflicts.
 */

export interface Meeting {
  title: string | null;
  startsAt: Date;
  endsAt: Date | null;
  allDay: boolean;
  attendeeEmails: string[];
  organizerEmail: string | null;
  hasAgenda: boolean;
  accounts: string[];
}

export interface Conflict {
  a: Meeting;
  b: Meeting;
  /** Overlapping, versus merely butted up against each other. */
  kind: "overlap" | "back-to-back";
}

interface MeetingRow {
  title: string | null;
  starts_at: Date;
  ends_at: Date | null;
  all_day: boolean;
  attendee_emails: string[] | null;
  organizer_email: string | null;
  has_agenda: boolean;
  accounts: string[];
}

const TODAY_SQL = `
select
  min(e.title)             as title,
  e.starts_at,
  max(e.ends_at)           as ends_at,
  bool_or(e.all_day)       as all_day,
  min(e.organizer_email)   as organizer_email,
  bool_or(coalesce(length(trim(e.description)), 0) > 0) as has_agenda,
  array_agg(distinct a.email) as accounts,
  (
    select array_agg(distinct lower(att->>'email'))
      from events e2, jsonb_array_elements(e2.attendees) att
     where coalesce(e2.ical_uid, e2.gcal_event_id) = coalesce(e.ical_uid, e.gcal_event_id)
       and e2.starts_at = e.starts_at
       and att->>'email' is not null
  ) as attendee_emails
from events e
join accounts a on a.id = e.account_id
where e.starts_at >= $1::timestamptz
  and e.starts_at <  $2::timestamptz
group by coalesce(e.ical_uid, e.gcal_event_id), e.starts_at, e.ical_uid, e.gcal_event_id
order by e.starts_at
`;

export async function meetingsForLocalDay(now = new Date()): Promise<Meeting[]> {
  const dayStart = startOfLocalDay(now);
  const dayEnd = addDays(dayStart, 1);

  const { rows } = await pool.query<MeetingRow>(TODAY_SQL, [
    dayStart.toISOString(),
    dayEnd.toISOString(),
  ]);

  return rows.map((r) => ({
    title: r.title,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    allDay: r.all_day,
    attendeeEmails: (r.attendee_emails ?? []).filter(Boolean),
    organizerEmail: r.organizer_email,
    hasAgenda: r.has_agenda,
    accounts: r.accounts,
  }));
}

/** Gap smaller than this between meetings counts as no gap at all. */
const BACK_TO_BACK_MINUTES = 5;

export function findConflicts(meetings: Meeting[]): Conflict[] {
  // All-day markers overlap everything and are never conflicts.
  const timed = meetings
    .filter((m) => !m.allDay && m.endsAt)
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());

  const conflicts: Conflict[] = [];

  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length; j++) {
      const a = timed[i]!;
      const b = timed[j]!;
      const aEnd = a.endsAt!.getTime();
      const bStart = b.startsAt.getTime();

      // Sorted by start, so once b starts after a ends (plus the gap window)
      // no later meeting can conflict with a either.
      const gapMinutes = (bStart - aEnd) / 60_000;
      if (gapMinutes > BACK_TO_BACK_MINUTES) break;

      if (bStart < aEnd) conflicts.push({ a, b, kind: "overlap" });
      else conflicts.push({ a, b, kind: "back-to-back" });
    }
  }

  return conflicts;
}
