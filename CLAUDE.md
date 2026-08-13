# ops-agent

> **Standing rule:** any change to architecture, schema, ranking weights, constraints, or the decisions log updates this file **in the same commit**. A spec that drifts from the code is worse than no spec. This file is the canonical reference across Claude Code sessions.

---

## What this is

A personal operations agent for a single user. It reads across ~15 Gmail accounts and calendars spanning several Google Workspace domains plus personal Gmail, works out what matters, and sends one WhatsApp message each morning.

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
| **Failures alert the operator, not the client.** | Email to operator + admin console status. Never touches the client's WhatsApp. |
| **Not a fixed 24-hour window.** Recency is not importance — a six-day-old unanswered email outranks this morning's noise. | Scoring is thread-state-based. The age curve peaks at 2–7 days rather than decaying from now. |
| **Cold start looks back 7 days maximum. Never backfill the inbox.** | Hard constant `COLD_START_DAYS = 7` plus a per-account message cap. There are thousands of unread messages in there and none of them are today's problem. |
| **Minimal UI.** One admin page, server-rendered, no framework, no build step. Everything else is the WhatsApp message. | Template literals + `node:http`/express. (TypeScript still compiles — that's a toolchain step, not a frontend build.) |

---

## Decisions log

Append here when a decision is made or reversed. Include the reasoning — the *why* is the part that stops a future session from undoing it.

**1. Brief format — approved WhatsApp template with single-line slots + link.**
WhatsApp business-initiated messages outside a 24-hour session window require a Meta-approved template, and **template variables cannot contain newlines**. The morning brief is definitionally business-initiated (the client will not have messaged in the prior 24h), so free-form text is not an option. The layout lives in the approved skeleton; each variable carries one line. A signed link to the full brief page carries the depth. Cost: changing the layout requires Meta re-approval.

**2. Sender graph — Sent metadata only, 90 days, at cold start.**
Ranking quality depends on knowing who actually matters to him. At cold start we read Sent headers only (`format=metadata` — From/To/Cc/Date, no bodies) back 90 days to build a correspondent graph. This is what separates "a real person waiting on you" from noise, and it works from day one instead of taking weeks to warm up. **This does not violate the never-backfill rule** — that rule is about not dredging his unread inbox; Sent metadata is a different thing and is cheap.

**3. Operator alerting — email + admin console, deliberately not WhatsApp.**
Error content is inherently variable (account names, error strings) and cannot be held inside a fixed Meta-approved template. Email + console status instead.

**4. No ORM — `pg` + numbered `.sql` migrations.**
The schema is small and this keeps the toolchain trivial, in the spirit of the no-build-step constraint.

**5. Sync is decoupled from delivery.**
A sync worker runs every ~20 minutes all day writing to Postgres; the morning job only reads Postgres and sends. A Gmail outage at 6:29am cannot kill the brief, and thread state accumulates over days so "unanswered for six days" is a fact in the database rather than something inferred at send time.

**6. Direct commits to `main`. No pull requests.**
Single developer.

---

## Stack

- **Node + TypeScript** — `tsx` in dev, `tsc` for prod
- **Postgres on Railway** — dev and prod instances both there, connection string from env. Nothing runs on the dev box except the code and Claude Code.
- **Railway hosting** — one repo, two services: a web service and a cron worker
- **Anthropic API** — `claude-opus-5` for ranking and composition
- **Twilio WhatsApp** — delivery

---

## Architecture

```
src/
  db/         pool.ts, migrate.ts, migrations/*.sql, queries/
  auth/       google.ts (one OAuth path), crypto.ts (AES-256-GCM token storage)
  sources/    gmail.ts, calendar.ts        → normalize into Postgres
  signals/    weights.ts, score.ts         → pure functions over DB rows
  ranking/    candidates.ts, compose.ts    → prefilter, then one LLM call
  outputs/    whatsapp.ts, operatorEmail.ts
  web/        server.ts, admin.ts, oauth.ts, briefPage.ts
  jobs/       sync.ts, brief.ts
  ops/        log.ts, alert.ts
```

The `sources → signals → ranking → outputs` split is what keeps this from becoming a digest-only codebase. `signals/` scores threads with **no knowledge of "today"**; a future search capability calls the same scorer with a different candidate set.

---

## Schema

- **`accounts`** — id, email, domain, status, `access_token_enc`, `refresh_token_enc`, scopes, `gmail_history_id`, `last_sync_at`, `last_error`, connected_at
- **`messages`** — account_id, gmail_message_id, gmail_thread_id, from_email/name, to_emails[], cc_emails[], subject, snippet, sent_at, `direction` (inbound|outbound), `has_list_unsubscribe`, `is_automated`, labels[] · UNIQUE(account_id, gmail_message_id)
- **`threads`** — account_id, gmail_thread_id, subject, `last_inbound_at`, `last_outbound_at`, `awaiting_reply`, participants[] · UNIQUE(account_id, gmail_thread_id)
- **`correspondents`** — PK(account_id, email), outbound_count, inbound_count, last_outbound_at, last_inbound_at — *the sender graph*
- **`events`** — account_id, gcal_event_id, calendar_id, title, description, starts_at, ends_at, all_day, attendees jsonb, organizer_email, self_response_status, status · UNIQUE(account_id, gcal_event_id)
- **`briefs`** — `local_date UNIQUE`, payload jsonb, status, message_sid, sent_at, share_token, share_expires_at
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

Runs on the cron worker every ~20 minutes, all day.

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
- Sender is an attendee of a meeting today or tomorrow
- Sender attended a meeting in the last two days with nothing sent since
- Explicit ask detected (question marks, "can you", deadline language, near-future dates)

**Demotions**
- `List-Unsubscribe` header present · `Precedence: bulk`
- `no-reply@` / `donotreply@` / `notifications@`
- Known notification senders (GitHub, Jira, Slack digests), receipts, marketing

Take the top ~40–60 across all accounts. **Ties break deterministically** on `(score DESC, sent_at DESC, gmail_message_id ASC)` — never on iteration order.

### The model call

One call to `claude-opus-5`. Adaptive thinking (on by default on Opus 5), `effort: "high"`, structured output via `output_config.format` with a JSON schema returning `{ meetings, conflicts[], emails[{rank, account, from, subject, reason, days_open}], priorities[3] }`. A deterministic renderer maps that JSON into the template slots and the HTML brief page — **the model never formats the message**.

> `temperature` is **removed** on Opus 5 (sending it returns a 400). Stability comes from the deterministic prefilter, deterministic tie-breaks, the fixed output schema, and carry-over — not from a sampling knob.

### Carry-over is what earns trust

Items from yesterday's `brief_items` that are still unanswered are passed into the prompt as already-reported, hold their position band, and are labelled *"still open — day 3"*. Without this, the same email reappears each morning as if new and the brief reads as noise.

### Conflicts

Interval overlap computed across the **merged** set of all ~15 calendars, normalized to one timezone — precisely the pain that fifteen calendars create. Also flag zero-gap back-to-backs and agenda-less meetings.

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

### Idempotency

`briefs.local_date` is UNIQUE. The job inserts `ON CONFLICT DO NOTHING`, then sends only if status is still pending. A cron retry cannot double-send.

### Timezone / DST

Railway cron is UTC. Run the job **hourly** and gate on *"is it `BRIEF_HOUR` in `BRIEF_TZ` and is there no brief row for today"*. This survives DST without a twice-yearly hour shift.

### Operator alerts

`outputs/operatorEmail.ts` — digest email on account auth failure, sync failure, brief-send failure, or a brief sent with any account skipped. Behind a `notifyOperator()` seam so the transport can be swapped. Recipient from `OPERATOR_EMAIL`. The same information is always visible on the admin console.

---

## Environment

```
DATABASE_URL           TOKEN_ENC_KEY          GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET   OAUTH_REDIRECT_URI     ADMIN_SECRET
ANTHROPIC_API_KEY      TWILIO_ACCOUNT_SID     TWILIO_AUTH_TOKEN
TWILIO_WHATSAPP_FROM   WHATSAPP_TEMPLATE_SID  CLIENT_WHATSAPP_NUMBER
OPERATOR_EMAIL         RESEND_API_KEY         BRIEF_TZ
BRIEF_HOUR             PUBLIC_BASE_URL
```

`.env` is gitignored. It holds the token encryption key, OAuth secrets, and the Twilio and Anthropic keys — never commit it.

---

## Runbook

- **Connect an account** — admin console `/` → Connect account → Google consent. Workspace domains may need an admin allowlist first (see OAuth above).
- **Where alerts go** — `OPERATOR_EMAIL`, plus status and `last_error` on the admin console accounts table. Never the client's WhatsApp.
- **Force a brief** — run `jobs/brief.ts`. Use `DRY_RUN=1` to render without sending. Note the `local_date` uniqueness gate: delete the day's `briefs` row to genuinely re-send.
- **An account went red** — check its `last_error` and latest `sync_runs` row. Usually a revoked refresh token; reconnect via `/connect`. The brief keeps working meanwhile and will name the account as skipped.
