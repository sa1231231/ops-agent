-- The same meeting invited to several of his accounts appears once per
-- calendar. Interval overlap alone therefore reports it as conflicting with
-- itself, which is the loudest possible false positive in a brief whose whole
-- job is flagging real conflicts across ~15 calendars.
--
-- iCalUID is stable for a given meeting across every calendar it lands on, so
-- it is what identifies "this is one meeting, seen twice".
alter table events add column if not exists ical_uid text;

create index if not exists events_ical_uid_idx on events (ical_uid, starts_at);
