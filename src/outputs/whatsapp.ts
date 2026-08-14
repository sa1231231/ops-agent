import twilio from "twilio";
import { requireEnv } from "../config.js";
import type { ComposedBrief } from "../ranking/compose.js";

/**
 * WhatsApp delivery via an approved Meta template.
 *
 * A morning brief is business-initiated and lands outside any 24-hour session
 * window, so free-form text is not deliverable — it must be a template. Template
 * parameters cannot contain newlines, which is why the layout lives in the
 * approved skeleton and every variable is a single line.
 *
 * Approved template body (11 variables):
 *
 *   Good morning ☀️  {{1}}
 *
 *   📅 {{2}}
 *   ⚠️ {{3}}
 *
 *   📧 Needs you:
 *   1. {{4}}
 *   2. {{5}}
 *   3. {{6}}
 *
 *   🎯 Priorities:
 *   1. {{7}}
 *   2. {{8}}
 *   3. {{9}}
 *
 *   {{10}}
 *   Full brief → {{11}}
 */

/** Meta rejects empty parameters, so unused slots carry an em dash. */
const EMPTY_SLOT = "—";

export function buildTemplateVariables(
  brief: ComposedBrief,
  opts: {
    localDate: string;
    briefUrl: string;
    skippedAccounts: string[];
    /** Rendered from calendar rows; template slots are single-line, so joined. */
    meetings: string[];
    conflicts: string[];
  },
): Record<string, string> {
  const slot = (value: string | undefined) => (value && value.trim() ? value : EMPTY_SLOT);

  const emails = brief.emails.slice(0, 3);
  const skipped = opts.skippedAccounts.length
    ? `⚠️ Skipped: ${opts.skippedAccounts.join(", ")}`
    : EMPTY_SLOT;

  return {
    "1": slot(opts.localDate),
    "2": slot(
      opts.meetings.length
        ? `${opts.meetings.length} meeting${opts.meetings.length === 1 ? "" : "s"}: ${opts.meetings.join("; ")}`
        : "No meetings today",
    ),
    "3": slot(opts.conflicts.join("; ") || "No conflicts"),
    "4": slot(emails[0] ? `${emails[0].line} (${emails[0].reason})` : "Nothing needs you"),
    "5": slot(emails[1] ? `${emails[1].line} (${emails[1].reason})` : undefined),
    "6": slot(emails[2] ? `${emails[2].line} (${emails[2].reason})` : undefined),
    "7": slot(brief.priorities[0]),
    "8": slot(brief.priorities[1]),
    "9": slot(brief.priorities[2]),
    "10": skipped,
    "11": slot(opts.briefUrl),
  };
}

/** Last line of defence: a newline here is a delivery failure, not a typo. */
export function assertTemplateSafe(variables: Record<string, string>): void {
  for (const [key, value] of Object.entries(variables)) {
    if (/[\r\n\t]/.test(value)) {
      throw new Error(`Template variable {{${key}}} contains a newline or tab`);
    }
    if (value.length > 900) {
      throw new Error(`Template variable {{${key}}} is too long (${value.length})`);
    }
  }
}

export async function sendBrief(
  variables: Record<string, string>,
): Promise<string> {
  assertTemplateSafe(variables);

  const client = twilio(
    requireEnv("TWILIO_ACCOUNT_SID"),
    requireEnv("TWILIO_AUTH_TOKEN"),
  );

  const message = await client.messages.create({
    from: `whatsapp:${requireEnv("TWILIO_WHATSAPP_FROM")}`,
    to: `whatsapp:${requireEnv("CLIENT_WHATSAPP_NUMBER")}`,
    contentSid: requireEnv("WHATSAPP_TEMPLATE_SID"),
    contentVariables: JSON.stringify(variables),
  });

  return message.sid;
}
