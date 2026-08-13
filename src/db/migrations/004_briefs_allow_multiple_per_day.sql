-- Briefs were one-per-local-date, enforced by a unique constraint that doubled
-- as the idempotency lock: whoever inserted the row won, everyone else skipped.
--
-- That made manual sends and scheduled sends contend for the same slot, so a
-- test send blocked the day's real brief. While ranking and format are being
-- tuned, being able to send repeatedly matters more than the guarantee.
--
-- What still prevents accidental repeats: the brief only fires when the local
-- hour matches the configured hour, and the worker runs once per hour — so the
-- scheduler reaches the send path at most once a day regardless.
alter table briefs drop constraint if exists briefs_local_date_key;

-- Still indexed: history and carry-over both query by date, and carry-over
-- counts distinct dates so several rows for one day cannot inflate a day count.
create index if not exists briefs_local_date_idx on briefs (local_date desc);
