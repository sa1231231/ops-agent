import { Resend } from "resend";
import { optionalEnv } from "../config.js";

/**
 * Operator alerting.
 *
 * Failures reach the operator, never the client. Deliberately email rather than
 * the client's messaging channel: error content is variable (account names,
 * stack traces) and could not be held inside a fixed template anyway.
 *
 * Alerting must never be able to break the thing it is reporting on, so every
 * failure here is logged and swallowed.
 *
 * **Deliverability.** These land in spam when sent from Resend's shared
 * `onboarding@resend.dev` sandbox domain, which every new Resend account starts
 * on and whose reputation is shared with everyone else using it. Wording helps
 * at the margin; verifying a real domain in Resend and setting
 * OPERATOR_EMAIL_FROM to an address on it is the actual fix.
 */

export interface OperatorAlert {
  subject: string;
  body: string;
}

/** The operator. Single-user system; this is not worth a settings row. */
const OPERATOR_NAME = "Sam";

/**
 * A short note from a person, near enough.
 *
 * Plain and free of urgency bait: filters treat bracketed tags and words like
 * "URGENT" as promotional markers. Greeting, the problem, the detail, a
 * signature — nothing else. The timestamp and console link that used to sit at
 * the bottom said nothing the mail client and the link in his bookmarks did not
 * already tell him.
 */
function composeEmail(alert: OperatorAlert): { subject: string; text: string } {
  return {
    subject: `ops-agent: ${alert.subject}`,
    text: [
      `Hi ${OPERATOR_NAME},`,
      "",
      "There was an error.",
      "",
      alert.body,
      "",
      "-ops-agent",
    ].join("\n"),
  };
}

export async function notifyOperator(alert: OperatorAlert): Promise<boolean> {
  const to = optionalEnv("OPERATOR_EMAIL", "");
  const apiKey = optionalEnv("RESEND_API_KEY", "");

  if (!to || !apiKey) {
    // Not an error: the admin console still shows status, so an unconfigured
    // alert channel degrades visibility rather than breaking the run.
    console.warn(`[alert] ${alert.subject}\n${alert.body}`);
    return false;
  }

  const { subject, text } = composeEmail(alert);

  try {
    const resend = new Resend(apiKey);
    await resend.emails.send({
      from: optionalEnv("OPERATOR_EMAIL_FROM", "ops-agent <onboarding@resend.dev>"),
      to,
      subject,
      text,
    });
    return true;
  } catch (err) {
    console.error(
      "[alert] failed to send operator email:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

export function formatSkippedAccounts(
  skipped: Array<{ email: string; reason: string }>,
): OperatorAlert {
  const count = skipped.length;
  return {
    subject: `${count} account${count === 1 ? "" : "s"} could not be read`,
    body: [
      `The brief was sent as normal and named ${
        count === 1 ? "this account" : "these accounts"
      } as skipped, so nothing was lost from the rest.`,
      "",
      ...skipped.map((s) => `  ${s.email}\n    ${s.reason}`),
      "",
      "Reconnecting the account in the console repairs a revoked grant.",
    ].join("\n"),
  };
}
