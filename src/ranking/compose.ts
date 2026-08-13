import Anthropic from "@anthropic-ai/sdk";
import { requireEnv } from "../config.js";
import type { CarriedItem } from "../db/queries/briefs.js";
import type { ScoredThread } from "../signals/score.js";
import { BRIEF_TZ } from "../time.js";
import type { Conflict, Meeting } from "./meetings.js";

/**
 * One model call per morning. The deterministic pre-filter has already decided
 * *what* is important; the model decides how to say it.
 *
 * It never formats the message. It returns structured fields and a separate
 * renderer decides how they read, so the layout can change without re-prompting
 * and two runs over the same data produce identical text.
 */

const MODEL = "claude-opus-5";

export interface ComposedBrief {
  meetings_line: string;
  conflicts_line: string;
  emails: Array<{ thread_key: string; line: string; reason: string }>;
  priorities: string[];
}

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    meetings_line: {
      type: "string",
      description:
        "One line summarising today's schedule. Include the count and the first meeting's time and who it is with. Empty string if there are no meetings.",
    },
    conflicts_line: {
      type: "string",
      description:
        "One line naming any double-bookings or zero-gap back-to-backs. Empty string if the day is clean.",
    },
    emails: {
      type: "array",
      description: "Emails that need him, most important first. At most 8.",
      items: {
        type: "object",
        properties: {
          thread_key: {
            type: "string",
            description: "The exact thread_key given in the input. Never invent one.",
          },
          line: {
            type: "string",
            description:
              "One line: who it is from and what they want. Under 90 characters.",
          },
          reason: {
            type: "string",
            description: "Short phrase for why it matters, e.g. 'unanswered 6 days'.",
          },
        },
        required: ["thread_key", "line", "reason"],
        additionalProperties: false,
      },
    },
    priorities: {
      type: "array",
      description: "Exactly three priorities for today, each one line.",
      items: { type: "string" },
    },
  },
  required: ["meetings_line", "conflicts_line", "emails", "priorities"],
  additionalProperties: false,
} as const;

const SYSTEM = `You write a single morning brief for one busy operator who runs his work across about fifteen email accounts and calendars.

He reads this as a text message, once, before his day starts. It should tell him what actually needs him today and nothing else.

How to write it:

- Every field is a SINGLE LINE. Never use newlines, bullet characters, or markdown.
- Keep every line short. Meetings and conflicts under 150 characters; each email line and each priority under 110. This is read on a phone, and anything longer is cut off. Write to the limit rather than being truncated at it.
- Be specific and concrete. "Eric needs the contract redline" beats "follow up on outstanding items".
- Name people, not addresses. "Eric Kalman" not "eric@kalman.com".
- Do not pad. If only two emails genuinely need him, return two. An honest short brief is worth more than a padded long one.
- Never invent anything. Every thread_key must be one you were given. If you are unsure what a thread is about, describe it plainly from the subject rather than guessing at intent.

Stability matters more than freshness. This runs every day, and he will notice if it reshuffles for no reason:

- Items marked ALREADY REPORTED were in an earlier brief and are still unanswered. Keep them near the position they had, and make the ageing explicit in the reason — "still open, day 3".
- Do not re-explain a carried item as though it is new.

The three priorities should follow from the meetings and emails you were given — the things that would make today a success. They are not a summary of the above; they are what he should actually do.`;

function formatMeeting(m: Meeting, timeZone: string): string {
  const time = m.allDay
    ? "all day"
    : new Intl.DateTimeFormat("en-US", {
        timeZone,
        hour: "numeric",
        minute: "2-digit",
      }).format(m.startsAt);

  const people = m.attendeeEmails.slice(0, 4).join(", ");
  const flags = [
    m.hasAgenda ? null : "no agenda",
    m.accounts.length > 1 ? `on ${m.accounts.length} of his calendars` : null,
  ].filter(Boolean);

  return `- ${time} — ${m.title ?? "(untitled)"}${people ? ` [with: ${people}]` : ""}${
    flags.length ? ` (${flags.join("; ")})` : ""
  }`;
}

function formatCandidate(t: ScoredThread, carried: CarriedItem | undefined): string {
  const c = t.candidate;
  const signals = t.signals
    .filter((s) => s.points > 0)
    .map((s) => s.detail ?? s.name)
    .join("; ");

  const age = c.lastInboundAt
    ? `${t.daysWaiting.toFixed(1)}d ago`
    : "unknown age";

  const flag = carried
    ? ` [ALREADY REPORTED — first seen ${carried.firstSeen}, reported ${carried.daysReported}x]`
    : "";

  return [
    `- thread_key: ${c.accountId}:${c.gmailThreadId}${flag}`,
    `  from: ${c.fromName ?? ""} <${c.fromEmail ?? "unknown"}>  to account: ${c.accountEmail}`,
    `  subject: ${c.subject ?? "(no subject)"}`,
    `  received: ${age}   score: ${Math.round(t.score)}`,
    `  why it ranked: ${signals || "none"}`,
    `  snippet: ${(c.snippet ?? "").slice(0, 220)}`,
  ].join("\n");
}

export interface ComposeInput {
  localDate: string;
  meetings: Meeting[];
  conflicts: Conflict[];
  candidates: ScoredThread[];
  carried: Map<string, CarriedItem>;
  skippedAccounts: string[];
}

export function buildPrompt(input: ComposeInput): string {
  const { localDate, meetings, conflicts, candidates, carried, skippedAccounts } = input;

  const meetingBlock = meetings.length
    ? meetings.map((m) => formatMeeting(m, BRIEF_TZ)).join("\n")
    : "(no meetings today)";

  const conflictBlock = conflicts.length
    ? conflicts
        .map(
          (c) =>
            `- ${c.kind}: "${c.a.title ?? "(untitled)"}" and "${c.b.title ?? "(untitled)"}"`,
        )
        .join("\n")
    : "(no conflicts)";

  const emailBlock = candidates.length
    ? candidates
        .map((t) =>
          formatCandidate(t, carried.get(`${t.candidate.accountId}:${t.candidate.gmailThreadId}`)),
        )
        .join("\n\n")
    : "(nothing needs his attention)";

  return `Today is ${localDate} (${BRIEF_TZ}).

## Today's meetings
${meetingBlock}

## Scheduling conflicts detected
${conflictBlock}

## Emails that may need him
These already passed a deterministic filter and are ordered by score. Trust the ordering unless something in the content clearly contradicts it.

${emailBlock}
${
  skippedAccounts.length
    ? `\n## Accounts that could not be read today\n${skippedAccounts.join(", ")}\nMention nothing about these; they are reported separately.`
    : ""
}`;
}

/**
 * Collapses to a single line and trims to length.
 *
 * Truncation happens at a word boundary. A hard slice produced "the 10:30
 * standup leaves no p" in the first real brief, which reads as a bug to the
 * person receiving it even though the content was right.
 */
export function sanitizeLine(value: string, maxLength = 240): string {
  const flat = value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (flat.length <= maxLength) return flat;

  const cut = flat.slice(0, maxLength - 1);
  const lastSpace = cut.lastIndexOf(" ");
  // Only back off to a word boundary if one is reasonably close, so a single
  // very long token does not collapse the whole line to an ellipsis.
  const trimmed = lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${trimmed.replace(/[,;:.\s]+$/, "")}…`;
}

export async function composeBrief(input: ComposeInput): Promise<ComposedBrief> {
  const client = new Anthropic({ apiKey: requireEnv("ANTHROPIC_API_KEY") });

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    output_config: {
      effort: "high",
      format: { type: "json_schema", schema: OUTPUT_SCHEMA },
    },
    messages: [{ role: "user", content: buildPrompt(input) }],
  } as Anthropic.MessageCreateParamsNonStreaming);

  if (response.stop_reason === "refusal") {
    throw new Error("Model refused to compose the brief");
  }

  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") {
    throw new Error("Model returned no text block");
  }

  const parsed = JSON.parse(text.text) as ComposedBrief;

  // The schema cannot express item counts, and template slots are fixed, so the
  // shape is enforced here rather than trusted.
  const knownKeys = new Set(
    input.candidates.map((t) => `${t.candidate.accountId}:${t.candidate.gmailThreadId}`),
  );

  return {
    meetings_line: sanitizeLine(parsed.meetings_line ?? "", 180),
    conflicts_line: sanitizeLine(parsed.conflicts_line ?? "", 180),
    emails: (parsed.emails ?? [])
      // A hallucinated thread_key would render a line pointing at nothing.
      .filter((e) => knownKeys.has(e.thread_key))
      .slice(0, 8)
      .map((e) => ({
        thread_key: e.thread_key,
        line: sanitizeLine(e.line, 110),
        reason: sanitizeLine(e.reason, 60),
      })),
    priorities: (parsed.priorities ?? []).slice(0, 3).map((p) => sanitizeLine(p, 130)),
  };
}
