-- Operational settings that a human changes at runtime, as opposed to
-- deployment configuration that belongs in env vars.
--
-- The brief recipient is the motivating case: changing who gets the morning
-- message should not require a redeploy, and it is exactly the kind of thing
-- that gets changed while onboarding or testing.
--
-- Secrets stay in env. This table is for non-secret operational values, so a
-- database dump does not leak credentials.
create table if not exists settings (
  key        text primary key,
  value      text        not null,
  updated_at timestamptz not null default now()
);
