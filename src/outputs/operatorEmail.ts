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
 */

export interface OperatorAlert {
  subject: string;
  body: string;
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

  try {
    const resend = new Resend(apiKey);
    await resend.emails.send({
      from: optionalEnv("OPERATOR_EMAIL_FROM", "ops-agent <onboarding@resend.dev>"),
      to,
      subject: `[ops-agent] ${alert.subject}`,
      text: alert.body,
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
  return {
    subject: `${skipped.length} account${skipped.length === 1 ? "" : "s"} skipped`,
    body: [
      "These accounts could not be read. The brief was still sent, naming them as skipped.",
      "",
      ...skipped.map((s) => `- ${s.email}\n  ${s.reason}`),
      "",
      "A revoked grant is repaired by reconnecting the account in the admin console.",
    ].join("\n"),
  };
}
