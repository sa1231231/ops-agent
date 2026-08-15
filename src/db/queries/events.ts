import { pool } from "../pool.js";
import type { NormalizedEvent } from "../../sources/calendar.js";

const CHUNK = 100;
const COLUMNS = 13;

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
        // $10 is `attendees` and must be cast — the parameter positions shifted
        // by one when ical_uid was added, and an off-by-one here silently casts
        // the wrong column.
        `($${p + 1},$${p + 2},$${p + 3},$${p + 4},$${p + 5},$${p + 6},` +
          `$${p + 7},$${p + 8},$${p + 9},$${p + 10}::jsonb,$${p + 11},$${p + 12},$${p + 13})`,
      );
      values.push(
        accountId,
        e.gcalEventId,
        e.icalUid,
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
         account_id, gcal_event_id, ical_uid, calendar_id, title, description,
         starts_at, ends_at, all_day, attendees, organizer_email,
         self_response_status, status
       )
       values ${tuples.join(",")}
       on conflict (account_id, gcal_event_id) do update set
         ical_uid             = excluded.ical_uid,
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
 * Reconciles the stored window against what Google just returned.
 *
 * Upserting alone can only ever add and update. An event he deletes stops coming
 * back in the response, so nothing touches its row again and it briefs him
 * forever as a meeting that is not happening — which is exactly what a deleted
 * 5pm block did: every other row carried today's `updated_at` and that one still
 * carried yesterday's.
 *
 * An earlier version deleted only rows whose `starts_at` had fallen outside the
 * window, which catches a meeting moved to next month and nothing else. The
 * common case is a meeting deleted *in place*, still sitting inside the window.
 *
 * So the rule is: after a successful pass over every calendar, the stored window
 * is exactly what Google returned. That covers deletion, cancellation, a decline
 * after the fact, and a meeting moved out — without needing to know which
 * happened.
 */
export async function reconcileEvents(
  accountId: number,
  timeMin: Date,
  timeMax: Date,
  seenEventIds: string[],
): Promise<number> {
  const { rowCount } = await pool.query(
    `delete from events
      where account_id = $1
        and (
          starts_at is null or starts_at < $2 or starts_at >= $3
          or not (gcal_event_id = any($4::text[]))
        )`,
    [accountId, timeMin, timeMax, seenEventIds],
  );
  return rowCount ?? 0;
}
