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

/**
 * The schedule is deliberately absent. Meeting times, titles, and conflicts are
 * facts already in Postgres and are rendered directly from calendar rows — the
 * model only handles the two things that need judgement.
 */
export interface ComposedBrief {
  emails: Array<{
    thread_key: string;
    line: string;
    reason: string;
    /**
     * A priority already says this. Kept in the list rather than deleted,
     * because carry-over is built from `brief_items` and a thread reported as a
     * priority was still reported — dropping the row here would make it read as
     * new tomorrow. Every renderer skips it, including the console: showing it
     * there meant the brief page displayed the same item twice when the message
     * he actually received showed it once.
     */
    coveredByPriority?: boolean;
  }>;
  priorities: string[];
}

/** What the model returns, before coverage is resolved into a flag. */
interface RawComposed {
  emails: Array<{ thread_key: string; line: string; reason: string }>;
  priorities: Array<{ priority: string; covers: string[] }>;
}

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    emails: {
      type: "array",
      description:
        "Things that need his attention today, most important first. At most 8. " +
        "Usually an unanswered email, but also: a deadline he was given that has " +
        "arrived, a commitment he made coming due, or a meeting today that needs " +
        "preparation. Not everything here is a reply.",
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
              "One line: what needs him and from whom. Under 90 characters. " +
              "If a named deadline has arrived or passed, lead with that.",
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
      description:
        "Up to three priorities for today, each one line. Fewer is correct when " +
        "fewer are real, and none is a valid answer on a quiet day.",
      items: {
        type: "object",
        properties: {
          priority: { type: "string", description: "One line. Under 110 characters." },
          covers: {
            type: "array",
            description:
              "thread_keys from the attention list that this priority already deals " +
              "with by name, so they are not repeated below it. Empty for a priority " +
              "that is not about a specific thread. Only list a thread_key if reading " +
              "the attention line afterwards would tell him nothing new.",
            items: { type: "string" },
          },
        },
        required: ["priority", "covers"],
        additionalProperties: false,
      },
    },
  },
  required: ["emails", "priorities"],
  additionalProperties: false,
} as const;

const SYSTEM = `You write a single morning brief for one busy operator who runs his work across about fifteen email accounts and calendars.

He reads this as a text message, once, before his day starts. It should tell him what actually needs him today and nothing else.

You are given his schedule for context, but you do NOT write it. Times, titles, and conflicts are rendered separately from his calendar. Use the schedule to inform the priorities, and never restate it.

How to write it:

- Every field is a SINGLE LINE. Never use newlines, bullet characters, or markdown.
- Never use a dash as punctuation. No em dashes, no en dashes, no " - " standing in for one. Use a comma, a colon, or two sentences. Dashes read as machine-written, and this is meant to sound like a person who knows him.
- Keep every line short: each email line and each priority under 110 characters. This is read on a phone, and anything longer is cut off. Write to the limit rather than being truncated at it.
- Be specific and concrete. "Eric needs the contract redline" beats "follow up on outstanding items".
- Name people, not addresses. "Eric Kalman" not "eric@kalman.com".
- Do not pad. If only two emails genuinely need him, return two. An honest short brief is worth more than a padded long one.
- Never invent anything. Every thread_key must be one you were given. If you are unsure what a thread is about, describe it plainly from the subject rather than guessing at intent.

Stability matters more than freshness. This runs every day, and he will notice if it reshuffles for no reason:

- Items marked ALREADY REPORTED were in an earlier brief and are still unanswered. Keep them near the position they had, and make the ageing explicit in the reason, for example "still open, day 3".
- Do not re-explain a carried item as though it is new.

This section is not only about replying. A deadline he was given that lands today, a commitment coming due, or a meeting he is unprepared for all belong in it. Describe what needs doing, not what kind of object it is.

An unanswered message is not the same as someone waiting on him, and you are given enough to tell them apart. "awaiting-reply" fires on structure alone: last message inbound, nothing sent since. It cannot see whether anything was actually asked. "explicit-ask" is the signal that fires when a question, a request, or a deadline was detected.

When "awaiting-reply" fired and "explicit-ask" did not, do not write that the sender is waiting on a word back, chasing him, or expecting a reply. Nobody said that. Someone forwarding an article, sharing a link, or sending something for him to look at when he has a moment is not owed a response, and turning that into an obligation is how a brief starts inventing pressure that does not exist. Say what the message actually is, for example "Dubravka sent a singers article to look at", and let him decide whether it needs anything.

Repetition from one sender is not evidence of impatience either. Three shares in a week from someone who shares things is that person being themselves, not an escalation.

Equally, something that needs nothing from him does not belong in it at all. If the last message closed the thread out, whether a confirmation, an acknowledgement, a ticket marked resolved or a "no action needed", leave it out entirely rather than reporting it as news. The filter that ranked it cannot read that; all it sees is a message he has not replied to, and a closed ticket looks identical to an ignored one. This is the main case where the content genuinely contradicts the ordering, and you are expected to act on it. Returning fewer items is the correct outcome, not a failure to fill the section.

Priorities are what would make today a success. They follow from the meetings and emails you were given, and they are not a summary of the section above; they are what he should actually do.

Write AT MOST three. Fewer is correct when fewer are real, and on a quiet day none is the honest answer. Two priorities that matter beat three where the third exists to fill a slot, and he can tell the difference immediately.

Never write a priority whose only content is preparing for a meeting, writing an agenda for one, or setting an objective for a block already on his calendar. He can see his own calendar, that advice is identical every morning, and it is exactly what padding looks like.

Never invent detail to make a priority sound concrete. If nothing in the input says he has two asks to bring or three decisions to make, do not write that he does. A plain priority that is true is worth more than a specific one that is not.

Nothing is said twice. He reads one short message, and seeing the same thing in two sections makes the brief look padded:

- A priority may well be about a thread in the attention list. That is normal and often correct, since the most important thing waiting on him is usually the most important thing to do today.
- When it is, put that thread_key in that priority's "covers". The thread is then dropped from the attention list automatically, so write the priority as the complete instruction rather than a pointer to a line below it.
- Only claim a thread you have actually named, and never claim one you did not.
- If a priority and an attention line are about the same thread, they must not both appear. Claim the thread in "covers" and write the priority so it carries everything the attention line would have told him. Broadening the priority so that both can stand is not a way around this rule, it is the padding the rule exists to prevent.`;

function formatMeeting(m: Meeting, timeZone: string): string {
  const time = m.allDay
    ? "all day"
    : new Intl.DateTimeFormat("en-US", {
        timeZone,
        hour: "numeric",
        minute: "2-digit",
      }).format(m.startsAt);

  const people = m.attendeeEmails.slice(0, 4).join(", ");
  // "no agenda" used to be flagged here and is deliberately gone. 42 of the last
  // 51 meetings had no description, so it fired on four meetings in five: not a
  // signal, a constant. Its only real effect was to hand the model something to
  // reach for when it needed a third priority, which is where every "write an
  // agenda for the 2pm" came from.
  const flags = [
    m.accounts.length > 1 ? `on ${m.accounts.length} of his calendars` : null,
  ].filter(Boolean);

  return `- ${time}: ${m.title ?? "(untitled)"}${people ? ` [with: ${people}]` : ""}${
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
    ? ` [ALREADY REPORTED, first seen ${carried.firstSeen}, reported ${carried.daysReported}x]`
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
  /** Layer 4: house rules he wrote, injected verbatim. */
  houseRules?: string[];
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

  const houseRules = input.houseRules?.length
    ? `\n## Standing instructions from him\nThese override the general guidance above where they conflict.\n${input.houseRules
        .map((r) => `- ${r}`)
        .join("\n")}\n`
    : "";

  return `Today is ${localDate} (${BRIEF_TZ}).
${houseRules}

## Today's meetings (context only: this is rendered for him separately, do not restate it)
${meetingBlock}

## Scheduling conflicts detected (also rendered separately)
${conflictBlock}

## Things that may need his attention
These already passed a deterministic filter and are ordered by score. Trust the ordering unless something in the content clearly contradicts it.

Most are threads waiting on a reply, but not all. Where a signal says a deadline resolves to today or is overdue, that is a date the sender actually named and it has arrived, so say so plainly rather than describing the thread as merely unanswered.

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
    // Dashes used as punctuation become commas. The instruction above usually
    // holds, but "usually" is not a guarantee and this text goes straight into
    // a text message. Doing it here rather than in toGsm7 keeps the two jobs
    // separate: this is the house style, that is the character set, and toGsm7
    // still has to turn a dash inside a calendar title into something GSM-7 can
    // carry without rewriting his own words.
    .replace(/\s*[\u2013\u2014\u2015]\s*/g, ", ")
    .replace(/ - /g, ", ")
    .replace(/\s{2,}/g, " ")
    // A dash swapped for a comma next to punctuation that already separates.
    .replace(/,\s*([,;:.])/g, "$1")
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

  const parsed = JSON.parse(text.text) as RawComposed;

  // The schema cannot express item counts, and template slots are fixed, so the
  // shape is enforced here rather than trusted.
  const knownKeys = new Set(
    input.candidates.map((t) => `${t.candidate.accountId}:${t.candidate.gmailThreadId}`),
  );

  const priorities = (parsed.priorities ?? []).slice(0, 3);

  // Deduplication is resolved here, deterministically, rather than left to the
  // instruction alone. The model declares which threads a priority already
  // covers; this decides what that means. A claim on a thread that was never a
  // candidate is ignored, exactly like a hallucinated thread_key below.
  const covered = new Set(
    priorities.flatMap((p) => p.covers ?? []).filter((key) => knownKeys.has(key)),
  );

  return {
    emails: (parsed.emails ?? [])
      // A hallucinated thread_key would render a line pointing at nothing.
      .filter((e) => knownKeys.has(e.thread_key))
      .slice(0, 8)
      .map((e) => ({
        thread_key: e.thread_key,
        line: sanitizeLine(e.line, 110),
        reason: sanitizeLine(e.reason, 60),
        coveredByPriority: covered.has(e.thread_key),
      })),
    priorities: priorities.map((p) => sanitizeLine(p.priority ?? "", 130)).filter(Boolean),
  };
}
