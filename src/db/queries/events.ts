import { pool } from "../pool.js";
import type { NormalizedEvent } from "../../sources/calendar.js";

const CHUNK = 100;
const COLUMNS = 12;

export async function upsertEvents(
  accountId: number,
  events: NormalizedEvent[],
): Promise<number> {
  if (events.length === 0) return 0;

  let written = 0;

  for (let start = 0; start < events.length; start += CHUNK) {
    const chunk = events.slice(start, start + CHUNK);
    const values: unknown[] = [];
    const tuples: string[] = [];

    chunk.forEach((e, i) => {
      const p = i * COLUMNS;
      tuples.push(
        `($${p + 1},$${p + 2},$${p + 3},$${p + 4},$${p + 5},$${p + 6},` +
          `$${p + 7},$${p + 8},$${p + 9}::jsonb,$${p + 10},$${p + 11},$${p + 12})`,
      );
      values.push(
        accountId,
        e.gcalEventId,
        e.calendarId,
        e.title,
        e.description,
        e.startsAt,
        e.endsAt,
        e.allDay,
        JSON.stringify(e.attendees),
        e.organizerEmail,
        e.selfResponseStatus,
        e.status,
      );
    });

    const { rowCount } = await pool.query(
      `insert into events (
         account_id, gcal_event_id, calendar_id, title, description,
         starts_at, ends_at, all_day, attendees, organizer_email,
         self_response_status, status
       )
       values ${tuples.join(",")}
       on conflict (account_id, gcal_event_id) do update set
         calendar_id          = excluded.calendar_id,
         title                = excluded.title,
         description          = excluded.description,
         starts_at            = excluded.starts_at,
         ends_at              = excluded.ends_at,
         all_day              = excluded.all_day,
         attendees            = excluded.attendees,
         organizer_email      = excluded.organizer_email,
         self_response_status = excluded.self_response_status,
         status               = excluded.status,
         updated_at           = now()`,
      values,
    );
    written += rowCount ?? 0;
  }

  return written;
}

/**
 * Drops events that fell out of the sync window.
 *
 * Without this, an event cancelled or moved after we stored it would linger and
 * show up in a brief as a meeting that is not happening.
 */
export async function pruneEventsOutsideWindow(
  accountId: number,
  timeMin: Date,
  timeMax: Date,
): Promise<number> {
  const { rowCount } = await pool.query(
    `delete from events
      where account_id = $1
        and (starts_at is null or starts_at < $2 or starts_at >= $3)`,
    [accountId, timeMin, timeMax],
  );
  return rowCount ?? 0;
}
