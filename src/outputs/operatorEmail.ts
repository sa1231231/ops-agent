import { Resend } from "resend";
import { optionalEnv, PUBLIC_BASE_URL } from "../config.js";
import { formatLocalDateTime } from "../time.js";

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

/**
 * Plain, specific, and free of urgency bait.
 *
 * Filters treat bracketed tags and words like "URGENT" as promotional markers,
 * and a two-line body with no context looks like a blast. A real signature and a
 * working link to a real destination both read as legitimate mail.
 */
function composeEmail(alert: OperatorAlert): { subject: string; text: string } {
  return {
    subject: `ops-agent: ${alert.subject}`,
    text: [
      alert.body,
      "",
      `Time: ${formatLocalDateTime(new Date())}`,
      `Console: ${PUBLIC_BASE_URL}`,
      "",
      "--",
      "ops-agent, your personal operations agent.",
      "This is an automated notice from software you run yourself.",
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
