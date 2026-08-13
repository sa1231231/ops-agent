-- ops-agent initial schema.
-- See CLAUDE.md § Schema. Any change here updates that file in the same commit.

-- Connected Google accounts. Workspace and personal are stored identically —
-- there is no per-domain branching anywhere in this system.
create table if not exists accounts (
  id                 bigserial primary key,
  email              text        not null unique,
  domain             text        not null,
  -- active | auth_error | disabled
  status             text        not null default 'active',
  access_token_enc   text,
  refresh_token_enc  text,
  token_expires_at   timestamptz,
  scopes             text[]      not null default '{}',
  gmail_history_id   text,
  last_sync_at       timestamptz,
  last_error         text,
  connected_at       timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists accounts_status_idx on accounts (status);

-- Individual messages. Bodies are never stored — subject and snippet only.
create table if not exists messages (
  id                    bigserial primary key,
  account_id            bigint      not null references accounts (id) on delete cascade,
  gmail_message_id      text        not null,
  gmail_thread_id       text        not null,
  from_email            text,
  from_name             text,
  to_emails             text[]      not null default '{}',
  cc_emails             text[]      not null default '{}',
  subject               text,
  snippet               text,
  sent_at               timestamptz,
  -- inbound | outbound
  direction             text        not null,
  has_list_unsubscribe  boolean     not null default false,
  is_automated          boolean     not null default false,
  labels                text[]      not null default '{}',
  created_at            timestamptz not null default now(),
  unique (account_id, gmail_message_id)
);

create index if not exists messages_thread_idx  on messages (account_id, gmail_thread_id);
create index if not exists messages_sent_at_idx on messages (account_id, sent_at desc);
create index if not exists messages_from_idx    on messages (from_email);

-- Thread-level state. This is what makes "unanswered for six days" a fact in the
-- database rather than something inferred at send time.
create table if not exists threads (
  id               bigserial primary key,
  account_id       bigint      not null references accounts (id) on delete cascade,
  gmail_thread_id  text        not null,
  subject          text,
  last_inbound_at  timestamptz,
  last_outbound_at timestamptz,
  -- true when the last message is inbound with no outbound after it
  awaiting_reply   boolean     not null default false,
  participants     text[]      not null default '{}',
  message_count    integer     not null default 0,
  updated_at       timestamptz not null default now(),
  unique (account_id, gmail_thread_id)
);

create index if not exists threads_awaiting_idx
  on threads (account_id, awaiting_reply, last_inbound_at desc);

-- The sender graph, built from Sent metadata at cold start. This is what
-- separates "a real person waiting on you" from noise on day one.
create table if not exists correspondents (
  account_id       bigint      not null references accounts (id) on delete cascade,
  email            text        not null,
  outbound_count   integer     not null default 0,
  inbound_count    integer     not null default 0,
  last_outbound_at timestamptz,
  last_inbound_at  timestamptz,
  updated_at       timestamptz not null default now(),
  primary key (account_id, email)
);

create index if not exists correspondents_email_idx on correspondents (email);

-- Calendar events across all connected accounts, normalized to UTC. Conflict
-- detection runs over the merged set of every calendar.
create table if not exists events (
  id                   bigserial primary key,
  account_id           bigint      not null references accounts (id) on delete cascade,
  gcal_event_id        text        not null,
  calendar_id          text        not null,
  title                text,
  description          text,
  starts_at            timestamptz,
  ends_at              timestamptz,
  all_day              boolean     not null default false,
  attendees            jsonb       not null default '[]'::jsonb,
  organizer_email      text,
  self_response_status text,
  status               text,
  updated_at           timestamptz not null default now(),
  unique (account_id, gcal_event_id)
);

create index if not exists events_starts_at_idx on events (starts_at);
create index if not exists events_account_idx   on events (account_id, starts_at);

-- One row per morning. local_date is UNIQUE, which is the idempotency gate that
-- makes a cron retry unable to double-send.
create table if not exists briefs (
  id                bigserial primary key,
  local_date        date        not null unique,
  payload           jsonb,
  -- pending | sent | failed
  status            text        not null default 'pending',
  message_sid       text,
  sent_at           timestamptz,
  share_token       text unique,
  share_expires_at  timestamptz,
  skipped_accounts  text[]      not null default '{}',
  created_at        timestamptz not null default now()
);

-- Carry-over state. first_seen_brief_date is what lets an item say
-- "still open — day 3" instead of reappearing every morning as if new.
create table if not exists brief_items (
  id                    bigserial primary key,
  brief_id              bigint  not null references briefs (id) on delete cascade,
  -- email | meeting | priority
  kind                  text    not null,
  ref_key               text    not null,
  rank                  integer,
  reason                text,
  first_seen_brief_date date,
  unique (brief_id, kind, ref_key)
);

create index if not exists brief_items_ref_idx on brief_items (kind, ref_key);

-- Every sync attempt writes a row, success or failure. One dead account is a
-- row here, not an exception that suppresses the brief.
create table if not exists sync_runs (
  id          bigserial primary key,
  account_id  bigint references accounts (id) on delete cascade,
  -- gmail_inbox | gmail_sent | calendar
  source      text        not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  -- running | ok | error
  status      text        not null,
  error       text,
  counts      jsonb       not null default '{}'::jsonb
);

create index if not exists sync_runs_account_idx on sync_runs (account_id, started_at desc);
create index if not exists sync_runs_status_idx  on sync_runs (status, started_at desc);
