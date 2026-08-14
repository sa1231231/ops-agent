# ops-agent

> **Standing rule:** any change to architecture, schema, ranking weights, constraints, or the decisions log updates this file **in the same commit**. A spec that drifts from the code is worse than no spec. This file is the canonical reference across Claude Code sessions.

---

## What this is

A personal operations agent for a single user. It reads across ~15 Gmail accounts and calendars spanning several Google Workspace domains plus personal Gmail, works out what matters, and sends one text message each morning.

The message contains:

- Today's meetings, conflicts flagged
- The emails that actually need attention, ranked and numbered
- Three priorities

**The morning brief is the first capability, not the whole product.** Replies, meeting transcripts, and on-demand search come later. Do not hard-code assumptions that only make sense for a daily digest — `sources/` and `signals/` must stay usable by a future capability that has nothing to do with mornings.

Named vaguely on purpose. Single user, no public signup, no marketing site. Speed to a working MVP is the priority.

---

## Non-negotiable constraints

| Constraint | Consequence in the build |
|---|---|
| **Read-only.** Gmail + Calendar read scopes only. The system never sends, moves, deletes, or modifies anything. | No `gmail.send`, `gmail.modify`, or Calendar write scopes anywhere. Enforced by a single scope constant. |
| **OAuth for every account.** No domain-wide delegation. Workspace and personal go through the identical flow and are stored identically. | One code path in `src/auth/`. No per-domain branching, ever. |
| **Partial failure never suppresses the brief.** One dead account, the other fourteen still report, with a note about what was skipped. | Per-account isolation via `Promise.allSettled`; the brief renders from whatever is in Postgres; skipped accounts are named in the message. |
| **Failures alert the operator, not the client.** | Email to operator + admin console status. Never touches the client's phone. |
| **Not a fixed 24-hour window.** Recency is not importance — a six-day-old unanswered email outranks this morning's noise. | Scoring is thread-state-based. The age curve peaks at 2–7 days rather than decaying from now. |
| **Cold start looks back 7 days maximum. Never backfill the inbox.** | Hard constant `COLD_START_DAYS = 7` plus a per-account message cap. There are thousands of unread messages in there and none of them are today's problem. |
| **Minimal UI.** Server-rendered, no framework, no build step. Everything else is the text message. | Template literals + `node:http`/express. (TypeScript still compiles — that's a toolchain step, not a frontend build.) |

---

## Decisions log

Append here when a decision is made or reversed. Include the reasoning — the *why* is the part that stops a future session from undoing it.

**1. Brief format — SMS, superseding the WhatsApp template.**
WhatsApp was the original choice and the eleven-slot template exists in `outputs/whatsapp.ts`, but SMS is what ships. Both need a one-time registration; the difference is that a WhatsApp template needs **re-approval for every layout change**, and template parameters cannot contain newlines. Since the format keeps changing as ranking improves, that recurring gate costs more than it saves. Original reasoning kept below for context:

WhatsApp business-initiated messages outside a 24-hour session window require a Meta-approved template, and **template variables cannot contain newlines**. The morning brief is definitionally business-initiated (the client will not have messaged in the prior 24h), so free-form text is not an option. The layout lives in the approved skeleton; each variable carries one line. A signed link to the full brief page carries the depth. Cost: changing the layout requires Meta re-approval.

**2. Sender graph — Sent metadata only, 90 days, at cold start.**
Ranking quality depends on knowing who actually matters to him. At cold start we read Sent headers only (`format=metadata` — From/To/Cc/Date, no bodies) back 90 days to build a correspondent graph. This is what separates "a real person waiting on you" from noise, and it works from day one instead of taking weeks to warm up. **This does not violate the never-backfill rule** — that rule is about not dredging his unread inbox; Sent metadata is a different thing and is cheap.

**3. Operator alerting — email + admin console, deliberately not WhatsApp.**
Error content is inherently variable (account names, error strings) and cannot be held inside a fixed Meta-approved template. Email + console status instead.

**4. No ORM — `pg` + numbered `.sql` migrations.**
The schema is small and this keeps the toolchain trivial, in the spirit of the no-build-step constraint.

**5. Sync is decoupled from delivery.**
The hourly cycle syncs into Postgres; the brief job only reads Postgres and sends. A Gmail outage minutes before the brief cannot kill it, and thread state accumulates over days so "unanswered for six days" is a fact in the database rather than something inferred at send time.

Hourly is not about completeness — the Gmail history cursor picks up everything since the last successful run, so one sync a day would capture the same messages. It is about not letting a single failed sync ship a brief built on yesterday's data, which would look entirely normal and be wrong.

**6. Direct commits to `main`. No pull requests.**
Single developer.

**7. The schedule runs inside the web service, not a separate cron worker.**
Reversal of the original two-service split, forced rather than chosen: Railway rejects every deployment of the cron worker before a build is created, with identical config to the web service that deploys fine from the same commit. See *Where the schedule actually runs*. `jobs/worker.ts` is unchanged and still runs standalone, so this is reversible with one env var.

**8. The model does not write the schedule.**
Meeting times, titles, and conflicts are rendered from calendar rows. They are facts already in Postgres with exactly one correct answer; a model restating them spends tokens and adds a way to be wrong about the only part of the brief that is not a judgement call. The model gets the schedule as context for the priorities, and is told not to restate it.

---

## Stack

- **Node + TypeScript** — `tsx` in dev, `tsc` for prod
- **Postgres on Railway** — dev and prod instances both there, connection string from env. Nothing runs on the dev box except the code and Claude Code.
- **Railway hosting** — one repo. The web service serves the console and, with `ENABLE_SCHEDULER=1`, owns the hourly cycle. A separate cron-worker service exists but has never deployed successfully (see *Where the schedule actually runs*).
- **Anthropic API** — `claude-opus-5` for ranking and composition
- **Twilio SMS** — delivery (WhatsApp kept behind `DELIVERY_CHANNEL`, unused)

---

## Architecture

```
src/
  db/         pool.ts, migrate.ts, migrations/*.sql, queries/
  auth/       google.ts (one OAuth path), crypto.ts (AES-256-GCM token storage)
  sources/    gmail.ts, calendar.ts        → normalize into Postgres
  signals/    weights.ts, score.ts         → pure functions over DB rows
  ranking/    candidates.ts, compose.ts    → prefilter, then one LLM call
  outputs/    render.ts (layout), sms.ts, whatsapp.ts, operatorEmail.ts
  web/        server.ts, admin.ts, oauth.ts, briefPage.ts, briefsPage.ts, scoringPage.ts, jobs.ts
  jobs/       sync.ts, brief.ts, worker.ts (runCycle), scheduler.ts (hourly tick)
```

The `sources → signals → ranking → outputs` split is what keeps this from becoming a digest-only codebase. `signals/` scores threads with **no knowledge of "today"**; a future search capability calls the same scorer with a different candidate set.

---

## Schema

- **`accounts`** — id, email, domain, status, `access_token_enc`, `refresh_token_enc`, scopes, `gmail_history_id`, `last_sync_at`, `last_error`, connected_at
- **`messages`** — account_id, gmail_message_id, gmail_thread_id, from_email/name, to_emails[], cc_emails[], subject, snippet, sent_at, `direction` (inbound|outbound), `has_list_unsubscribe`, `is_automated`, labels[] · UNIQUE(account_id, gmail_message_id)
- **`threads`** — account_id, gmail_thread_id, subject, `last_inbound_at`, `last_outbound_at`, `awaiting_reply`, participants[] · UNIQUE(account_id, gmail_thread_id)
- **`correspondents`** — PK(account_id, email), outbound_count, inbound_count, last_outbound_at, last_inbound_at — *the sender graph*
- **`events`** — account_id, gcal_event_id, calendar_id, title, description, starts_at, ends_at, all_day, attendees jsonb, organizer_email, self_response_status, status · UNIQUE(account_id, gcal_event_id)
- **`briefs`** — local_date (indexed, **not** unique — several per day allowed), payload jsonb (`trigger`, composed brief, rendered meeting and conflict lines, rendered text, scoring snapshot), status, message_sid, sent_at, share_token, share_expires_at
- **`brief_items`** — brief_id, kind, ref_key, rank, reason, `first_seen_brief_date` — *carry-over state*
- **`sync_runs`** — account_id, source, started_at, finished_at, status, error, counts jsonb

**Token storage:** AES-256-GCM via `node:crypto`, key from `TOKEN_ENC_KEY` (32 bytes, base64). Tokens are never logged and never rendered in the admin console.

---

## OAuth

**Scopes — one constant, one code path:** `gmail.readonly` · `calendar.readonly` · `userinfo.email` · `openid`. Nothing else, ever.

Flow uses `access_type=offline` and `prompt=consent` (forces a refresh token on re-auth). The Google Cloud project is **External + In production**, so refresh tokens do not hit the 7-day testing expiry. Under 100 connected accounts this is the fastest and simplest way to connect accounts.

**Two things to expect when onboarding:**

1. `gmail.readonly` is a *restricted* scope. An unverified app shows the "Google hasn't verified this app" interstitial — click through Advanced → Continue. The 100-user cap applies, which is far above what we need.
2. **A Workspace domain can block unverified third-party apps by policy.** If a connect attempt fails for a domain, that domain's admin must allowlist the OAuth client ID under Admin console → Security → API controls. **This is the most likely thing to stall onboarding** — connect one Workspace account early rather than saving them all for last.

---

## Sync

Runs hourly, all day, from the scheduler in the web process.

**Cold start, per account:**
- Inbox: `newer_than:7d -in:chats -category:promotions -category:social`, capped ~500 messages/account. `COLD_START_DAYS = 7` is a hard constant. Never a full-inbox scan.
- Sent graph: `in:sent newer_than:90d` with `format=metadata`, capped ~2000, to populate `correspondents`.

**Excluded tabs.** Promotions and Social are dropped at fetch time, not demoted at ranking time — it removes the API calls, the stored rows, and the noise in one move. Spam and Trash likewise. **Updates and Forums are deliberately kept**: Updates carries flight changes, invoices, and legal notices, which are exactly what a morning brief should surface.

Enforced in two places, and both are required. The query fragment covers the list-based paths; a label filter covers `history.list`, which accepts no query and would otherwise leak promotions back in on every incremental sync after cold start. Category exclusion is **inbound-only** — dropping a sent message because Gmail tagged its thread Promotions would quietly weaken the correspondent graph.

Known tradeoff: Gmail's categorizer is occasionally wrong, and a real message miscategorized as Promotions is never seen at all — scoring cannot rescue a message that was never fetched.

**Incremental:** `users.history.list` against the stored `gmail_history_id`. On 404 (history expired, gap >~1 week), fall back to a bounded `newer_than:2d` resync and reset the cursor. **Never widen to a full scan on error.**

**Calendar:** events from the **prior two days through a week ahead**, across all accounts.

The lookback is deliberate — a meeting yesterday with no follow-up since is an action item. The lookahead is wider than the brief needs on purpose: the morning message reports today, but storing a week makes "you have a demo Thursday and no agenda yet" answerable without a schema change, per the rule against hard-coding daily-digest assumptions.

**Window boundaries are local midnights in `BRIEF_TZ`, never UTC midnights** (`src/time.ts`). At 8pm in New York the UTC date has already rolled over, so a UTC-floored window silently points at the wrong day for a third of every day. Offsets come from `Intl`, so DST needs no special handling.

Google-generated subscription calendars (`#holiday@`, `#contacts@`, `#weeknum@`, `#sports@`) are excluded — they contain all-day markers, not meetings, and would put "Labor Day" in a list of today's meetings.

**Isolation:** `Promise.allSettled` per account; every attempt writes a `sync_runs` row. One dead account is a row, not an exception.

---

## Ranking

Deterministic rules narrow the field first; only survivors go to the model. Keeps cost low and, more importantly, keeps output stable day to day. **A brief that ranks differently every morning is one he stops trusting.**

### Deterministic prefilter (`signals/weights.ts` — fixed weights, one reviewable file)

**Boosts**
- Thread awaiting his reply (last message inbound, no outbound after) — the dominant signal
- Days awaiting, on a curve **peaking at 2–7 days**, not linear recency
- Addressed directly: `To:` > `Cc:` > neither
- Correspondent strength from the sender graph (how often and how recently he emails them)
- Sender is an attendee of a meeting within `MEETING_SOON_HOURS` (48)
- Sender attended a meeting within `MET_RECENTLY_DAYS` (2) with nothing sent since
- Explicit ask detected (question marks, "can you", deadline language, near-future dates)

**Demotions**
- `NOTIFICATION_RELAY` (−60) — Slack, Discord, Google Voice, LinkedIn, Zoom and similar. The real conversation lives in that app; the email is a doorbell. Generalized from a Google Voice special case, because the same reasoning covers every platform that emails "you have a message".
- `AUTOMATED` (−40) — machine sender by address pattern, or `Precedence`/`Auto-Submitted` headers
- `NEVER_CORRESPONDED` (−22) — he has never written to this address. Evidence from his own behaviour, and the main thing separating a person waiting on him from infrastructure that merely emails him.
- `LIST_UNSUBSCRIBE` (−12) — mailing list, stacked on top of automated

Relay and automated are **mutually exclusive**: most relays also match a machine-sender pattern, and stacking both reads as an arbitrary −100 in the scoring view. A relay also skips the correspondent graph entirely in both directions — the address changes every conversation, so it can neither earn known-correspondent nor be penalised as never-corresponded.

Survivors need `MIN_SCORE_FOR_BRIEF` (25); at most `MAX_CANDIDATES` (50) reach the model, and nothing older than `CANDIDATE_MAX_AGE_DAYS` (45) is considered. **Ties break deterministically** on `(score DESC, last_inbound_at DESC, gmail_thread_id ASC)` — never on iteration order.

### The model call

One call to `claude-opus-5`. Adaptive thinking (on by default on Opus 5), `effort: "high"`, structured output via `output_config.format` with a JSON schema returning `{ emails[{thread_key, line, reason}], priorities[3] }`. A deterministic renderer maps that JSON into the message and the HTML brief page — **the model never formats the message**.

> `temperature` is **removed** on Opus 5 (sending it returns a 400). Stability comes from the deterministic prefilter, deterministic tie-breaks, the fixed output schema, and carry-over — not from a sampling knob.

**The model does not write the schedule.** Meeting times, titles, and conflicts are rendered from calendar rows by `meetingLines()` / `conflictLines()` in `outputs/render.ts`. The schedule is a fact already in Postgres with one correct answer; asking a model to restate it spends tokens and adds a way to be wrong about the only part of the brief that cannot be a judgement call. The schedule is still passed into the prompt as context, because the priorities depend on it, with an explicit instruction not to restate it.

### Seeing why — `/briefs`

One page carries both the live scoring view and the brief history, because the question scoring answers is always asked about a specific brief. `/scoring` redirects there.

Default view is one plain-English line per candidate — the two or three signals that decided it, plus what held it back. Point values are one `<details>` click away. The full ranked list, the below-the-floor set, and the current weights table are all collapsed by default: the numbers are what you change, but reading fourteen chips per row is the wrong way to answer "is this ranking sensible".

It recomputes from current data, so a weight change is visible on reload. Each sent brief also stores a `scoring` snapshot in its payload, because the live page cannot answer "why did Tuesday's brief pick that" — the mail and the correspondent graph have moved on since.

### Carry-over is what earns trust

Items from yesterday's `brief_items` that are still unanswered are passed into the prompt as already-reported, hold their position band, and are labelled *"still open — day 3"*. Without this, the same email reappears each morning as if new and the brief reads as noise.

### Conflicts

Interval overlap computed across the **merged** set of all ~15 calendars, normalized to one timezone — precisely the pain that fifteen calendars create. `findConflicts` also detects zero-gap back-to-backs, and agenda-less meetings are flagged into the prompt; neither reaches the message (see *Message layout*).

**Deduplicate on `(ical_uid, starts_at)` before computing overlap. Both halves of that key are load-bearing.**

`iCalUID` is stable for a meeting across every calendar it lands on, so the same meeting invited to several of his accounts appears once per account. Without dedup, interval overlap reports it as conflicting with itself — the loudest possible false positive in a feature whose entire job is flagging real conflicts.

But `iCalUID` is **also shared across every occurrence of a recurring event**. Deduping on `ical_uid` alone therefore collapses a week of daily standups into one meeting and silently drops real conflicts involving later occurrences. Verified against live data: 62 rows dedupe to 61 true meetings on `(ical_uid, starts_at)`, versus 34 on `ical_uid` alone.

All-day events are excluded from overlap entirely — an all-day marker overlaps everything.

---

## Delivery

### WhatsApp template

Submit to Meta early — approval is the long pole (roughly 1–24h).

```
Good morning ☀️  {{1}}

📅 {{2}}
⚠️ {{3}}

📧 Needs you:
1. {{4}}
2. {{5}}
3. {{6}}

🎯 Priorities:
1. {{7}}
2. {{8}}
3. {{9}}

{{10}}
Full brief → {{11}}
```

Every variable is a single line — **no newlines are permitted in template params**. `{{10}}` carries the skipped-accounts note (*"Skipped: acme.com (auth expired)"*) or an empty-safe placeholder. `{{11}}` is the signed brief-page URL.

### SMS and GSM-7

SMS is the live channel; WhatsApp is kept behind `DELIVERY_CHANNEL` but unused.

**The message contains no emoji, and `toGsm7()` strips everything outside printable ASCII.** This is a cost decision, not an aesthetic one: a single character outside GSM-7 switches the whole message to UCS-2, dropping the segment size from 153 characters to 67 and roughly doubling the bill. Emoji are the obvious culprit but an em dash or curly apostrophe does it just as thoroughly, and the model emits those constantly. Measured: the same brief is 11 segments with one emoji, 5 without.

### Message layout

```
Good morning, Payeman

MEETINGS (5)
7:00 AM  PAY IN FULL - Freedom Chase
8:30 AM  cisa standup
...

Double-booked - 9:00 AM cdp standup / 9:15 AM Client call

PRIORITIES
1. ...

2. ...

NEEDS A REPLY
1. <who and what they want>
2. ...

<brief url>
```

Schedule first because it is fixed and time-bound; priorities next because they are what he decides to do about the day; replies last because they are the backlog he works around them.

**No date line.** He reads this the morning it is sent, on a phone already showing him the date.

**The greeting name is a setting** (`brief_greeting_name`, default `Payeman`), editable in the console. A name hard-coded in source is a name only a developer can correct. Blank gives a bare "Good morning".

**Only real double-bookings reach the message.** `findConflicts` still detects back-to-backs and the model still sees them, but they are filtered out of `conflictLines()` — his standups butt against each other every morning, so a "no gap" line fired daily and taught him to skip the section. Overlaps are grouped into clusters rather than listed pairwise, because a triple booking produces three pairs and three lines describing one problem reads as three problems.

**Priorities get a blank line between them**; replies do not. Priorities wrap; without separation three wrapped items read as one paragraph. Reply lines are short enough not to need it.

**Reply reasons are composed and stored but not sent.** Carry-over, the brief page, and the history all use `reason`; in the message it restated what the line above already said ("unanswered 4 days, deadline today" under a line that mentions the deadline). Measured: 6 segments.

### The operator's copy

`OPERATOR_SMS_NUMBER` gets the same text the client just received. Env var, deliberately not a console setting: **the console belongs to the client**, and this is the operator watching his own product go out. He needs the real message — segment count, wrapping, ranking — not a preview of it.

Sent after the client's and never fatal. A bad operator number must not turn a delivered brief into a failed run. Skipped when it equals the client number, which it often does during tuning.

### Repeat sends

There is deliberately **no one-per-day lock**. `briefs.local_date` was UNIQUE and doubled as an idempotency gate, which meant a manual test send consumed the day's slot and blocked the scheduled one — unworkable while ranking and format are being tuned.

What prevents accidental repeats now: the brief only fires when the local hour matches the configured hour, the cycle runs once per hour, and a scheduled run skips if a scheduled send already exists for the local date. The remaining exposure is a manual run colliding with a scheduled one in the same hour, which sends twice. That is accepted, and is the point — manual sends are for tuning.

### The console's Run now

**One button — "Sync and send brief".** It syncs every account, then composes and sends, exactly as the scheduled cycle does. There is no separate sync button and no preview mode: the whole system is read-only, so nothing about firing a brief needs care, and the only thing a preview saved was an SMS segment. Splitting them mostly created a way to send a brief against stale mail.

Sync failure inside the run is caught, not fatal — same rule as the worker. Postgres already holds days of thread state, so a Google outage degrades the brief rather than cancelling it.

Job state is a single in-memory record (`web/jobs.ts`), correct for a single instance. A restart loses the last result, not the work. `DRY_RUN=1` on the CLI still exists for checking format without sending.

### Where the schedule actually runs

**Inside the web service.** `jobs/scheduler.ts` re-arms a `setTimeout` from the wall clock each hour (not `setInterval`, which drifts) and calls the same `runCycle()` in `jobs/worker.ts` that the standalone CLI worker calls. Enabled by `ENABLE_SCHEDULER=1`, off otherwise, so exactly one thing per deployment drives it.

This is not the original design. The separate Railway cron service **fails every deployment before a build is even created** — no build logs beyond "scheduling build on Metal builder", no runtime logs, `buildLogs` returns "deployment does not have an associated build". Its config is identical to the web service (same repo, same RAILPACK builder, same commit) and the web service deploys fine from the same push. Nothing in this repo can reach that failure. A brief that fires is worth more than a tidy split of processes, and the console already ran this exact job in-process via the Run-now button.

`jobs/worker.ts` still stands alone and still works — if the cron service is ever fixed, set `ENABLE_SCHEDULER=0` on the web service and it takes over unchanged.

**Two schedulers cannot double-send.** Every run carries a `trigger` (`"scheduled"` or `"manual"`), stored in the brief payload. A scheduled run skips if a scheduled send already exists for the local date (`scheduledSendExists`). This is deliberately narrower than the UNIQUE constraint it replaces: manual runs stay unlimited, which is the whole reason that constraint was dropped.

### Timezone / DST

Cron and container clocks are UTC. The cycle runs **hourly** and gates on *"is it the configured hour in `BRIEF_TZ`"*. This survives DST without a twice-yearly hour shift. The tick fires at :00:05 rather than :00:00 — a clock a hair behind would otherwise read the previous hour and skip the day.

### Operator alerts

`outputs/operatorEmail.ts` — email on account auth failure, sync failure, brief-send failure, or a brief sent with any account skipped. Behind a `notifyOperator()` seam so the transport can be swapped. Recipient from `OPERATOR_EMAIL`. The same information is always visible on the admin console.

Format is a short note and nothing else:

```
Hi Sam,

There was an error.

<the detail>

-ops-agent
```

No bracketed subject tags, no urgency words, no timestamp or console footer — filters read the first two as promotional markers, and the last two said nothing the mail client and his bookmarks did not already.

**Deliverability.** These land in spam when sent from `onboarding@resend.dev`, Resend's shared sandbox domain, whose reputation belongs to every new Resend account at once. Wording helps at the margin; **verifying a real domain in Resend and pointing `OPERATOR_EMAIL_FROM` at an address on it is the actual fix.** Still outstanding.

Alerting must never break the thing it reports on, so every failure inside `notifyOperator()` is logged and swallowed.

---

## Admin console

Server-rendered template literals, no framework, no client JS, no build step. Basic auth against `ADMIN_SECRET` (constant-time compare over sha256 digests), same-origin checks on every POST, POST-redirect-GET so a refresh never resubmits.

| Route | What it is |
|---|---|
| `GET /` | Accounts table, brief settings, and the one run button |
| `GET /briefs` | Live scoring and brief history, one page |
| `GET /scoring` | 303 to `/briefs` — kept because it was bookmarked |
| `GET /connect` → `GET /oauth/callback` | The single OAuth path |
| `POST /settings` | Recipient, greeting name, send hour — one endpoint, three independent forms |
| `POST /run` | Sync then brief, started in the background |
| `POST /accounts/disconnect` | Revoke at Google, erase stored data, keep the row |
| `GET /brief/:token` | The full brief page. **Unauthenticated by design** — he opens it on a phone at 6:30am and a password prompt defeats the purpose. The token is unguessable and expiring, and grants nothing beyond one composed brief. |
| `GET /healthz` | Liveness |

Each settings form posts only its own field, so saving the hour cannot wipe the recipient. Values are validated on save — a bad phone number becomes a form error now rather than a failed brief at 6am.

**Disconnect** revokes the refresh token at Google *before* wiping locally: telling Google is what makes the access actually gone rather than merely unused. A revoke failure is logged, not fatal. The account row survives marked `disabled`, so reconnecting the same address later is an ordinary upsert, and `meetingsForLocalDay` filters disabled accounts so a disconnect stops influencing the brief immediately rather than at the next sync.

---

## Environment

```
DATABASE_URL           TOKEN_ENC_KEY          GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET   OAUTH_REDIRECT_URI     ADMIN_SECRET
ANTHROPIC_API_KEY      TWILIO_ACCOUNT_SID     TWILIO_AUTH_TOKEN
TWILIO_SMS_FROM        CLIENT_SMS_NUMBER      DELIVERY_CHANNEL
TWILIO_WHATSAPP_FROM   WHATSAPP_TEMPLATE_SID  CLIENT_WHATSAPP_NUMBER
OPERATOR_EMAIL         OPERATOR_EMAIL_FROM    RESEND_API_KEY
OPERATOR_SMS_NUMBER    BRIEF_TZ               BRIEF_HOUR
PUBLIC_BASE_URL        ENABLE_SCHEDULER
```

`ENABLE_SCHEDULER=1` is set on the web service and nowhere else. `BRIEF_HOUR` and `CLIENT_SMS_NUMBER` are fallbacks only — the console settings win once saved.

**Which settings live where, and why.** Secrets stay in env so a database dump leaks nothing. Things the *client* changes (recipient number, greeting name, send hour) live in the `settings` table and are editable in the console. Things the *operator* controls (`OPERATOR_SMS_NUMBER`, `OPERATOR_EMAIL`, `ENABLE_SCHEDULER`) stay in env and are deliberately invisible to the console — the console is the client's.

`.env` is gitignored. It holds the token encryption key, OAuth secrets, and the Twilio and Anthropic keys — never commit it.

---

## Runbook

- **Connect an account** — admin console `/` → Connect account → Google consent. Workspace domains may need an admin allowlist first (see OAuth above).
- **Where alerts go** — `OPERATOR_EMAIL`, plus status and `last_error` on the admin console accounts table. Never the client's phone.
- **Send a brief now** — console `/` → **Sync and send brief**. It syncs first and sends for real; there is no lock on manual sends, so it works any number of times a day.
- **Render without sending** — `DRY_RUN=1 npx tsx src/jobs/brief.ts --force`. Records nothing, sends nothing, prints the exact message and its segment count.
- **Check the schedule is alive** — web service logs show `[scheduler] next run in Nm` at boot and a `[worker] done in Ns (HH:00 …, brief hour is HH:00)` line each hour.
- **Tune ranking** — `/briefs` shows every candidate scored live with the reasons that decided it. Change `signals/weights.ts`, push, reload.
- **An account went red** — check its `last_error` and latest `sync_runs` row. Usually a revoked refresh token; reconnect via `/connect`. The brief keeps working meanwhile and will name the account as skipped.
