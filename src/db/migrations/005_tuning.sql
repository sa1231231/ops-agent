-- Feedback and the rules derived from it.
--
-- The design rule that governs this whole file: **a rule adjusts a score, it
-- never makes a decision.** Nothing here may exclude a thread outright. A hard
-- exclusion cannot be overridden by evidence, so the day a muted sender says
-- something that genuinely matters, the brief stays silent and the client stops
-- trusting it. Every adjustment is a number, and enough other signal beats it.

-- The raw verdicts. Append-only, and the source of truth everything else
-- derives from: rules can be regenerated from this, but this cannot be
-- regenerated from rules. Also the regression corpus — replaying these against
-- changed weights is how we find out whether a tuning change breaks a past
-- judgement.
create table if not exists feedback (
  id            bigserial primary key,
  brief_id      bigint references briefs (id) on delete set null,
  -- The thread it concerns. Null for verdicts about a whole brief.
  thread_key    text,
  -- good | not-important | wrong-rank | badly-written | missed | brief-good | brief-bad
  verdict       text        not null,
  -- Which multiple-choice reason was picked, if any.
  choice        text,
  -- Free text, only when he chooses to add it.
  note          text,
  -- Score at the time, so a replay can tell "this changed" from "this was
  -- always like that". Meaningless to recompute later — the mail has moved on.
  score_at_time integer,
  created_at    timestamptz not null default now()
);

create index if not exists feedback_thread_idx on feedback (thread_key);
create index if not exists feedback_brief_idx  on feedback (brief_id);

-- Layer 1. "This person, or this domain, matters more/less than the graph thinks."
create table if not exists sender_rules (
  id            bigserial primary key,
  -- Lowercase. An address, or a domain with a leading '@'.
  pattern       text        not null,
  -- address | domain
  scope         text        not null,
  -- Null means every account. Set to confine a rule to one mailbox.
  account_id    bigint      references accounts (id) on delete cascade,
  -- Signed points, applied at scoring time. Positive promotes, negative demotes.
  adjustment    integer     not null,
  -- How many verdicts back this rule. The applied adjustment is scaled by it,
  -- so one irritated morning cannot blacklist a real correspondent and a young
  -- rule stays weak enough to be overridden by other evidence.
  confidence    integer     not null default 1,
  reason        text,
  source_brief  bigint      references briefs (id) on delete set null,
  -- The audit. A rule that never fires is dead weight; one that fires on
  -- everything is either load-bearing or catastrophically broad.
  times_fired   integer     not null default 0,
  last_fired_at timestamptz,
  created_at    timestamptz not null default now(),
  unique (pattern, scope, account_id)
);

-- Layer 2. "This particular conversation."
create table if not exists thread_rules (
  id          bigserial primary key,
  -- '<account_id>:<gmail_thread_id>' — the same key brief_items uses.
  thread_key  text        not null unique,
  -- pin | mute
  verdict     text        not null,
  -- Mutes expire. A thread handled on a phone call looks unanswered forever,
  -- but one that comes back to life months later is genuinely new information.
  expires_at  timestamptz,
  reason      text,
  created_at  timestamptz not null default now()
);

-- Layer 4. Things arithmetic cannot express, injected into the system prompt.
-- Deliberately the smallest layer: the model usually obeys, which is weaker
-- than the guarantee every other layer gives.
create table if not exists brief_rules (
  id         bigserial primary key,
  rule       text        not null,
  active     boolean     not null default true,
  created_at timestamptz not null default now()
);
