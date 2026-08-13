import twilio from "twilio";
import { optionalEnv, requireEnv } from "../config.js";
import { estimateSegments } from "./render.js";

/**
 * SMS delivery.
 *
 * No templates and no per-layout approval: the message is arbitrary text, so the
 * brief's format can change whenever the ranking improves. That is the whole
 * reason to prefer this over a WhatsApp template while the system is being tuned.
 *
 * The one gate is US A2P 10DLC registration, which carriers require for
 * application-to-person traffic. It is a one-time setup rather than a recurring
 * review, and unregistered traffic gets filtered rather than rejected — so a
 * message can "send" successfully and never arrive.
 */

/** Guard against a runaway brief costing a hundred segments. */
const MAX_SEGMENTS = 12;

export async function sendSms(body: string): Promise<string> {
  const segments = estimateSegments(body);
  if (segments > MAX_SEGMENTS) {
    throw new Error(
      `Brief would send as ${segments} SMS segments (limit ${MAX_SEGMENTS}). ` +
        "Shorten the brief rather than raising this.",
    );
  }

  const client = twilio(
    requireEnv("TWILIO_ACCOUNT_SID"),
    requireEnv("TWILIO_AUTH_TOKEN"),
  );

  const message = await client.messages.create({
    from: requireEnv("TWILIO_SMS_FROM"),
    to: requireEnv("CLIENT_SMS_NUMBER"),
    body,
  });

  return message.sid;
}

export type DeliveryChannel = "sms" | "whatsapp" | "none";

/**
 * `none` renders and stores the brief without sending — the same path the real
 * job takes, minus delivery. That is what makes it useful for verifying the
 * whole pipeline before a number is registered.
 */
export function deliveryChannel(): DeliveryChannel {
  const raw = optionalEnv("DELIVERY_CHANNEL", "sms").toLowerCase();
  if (raw === "sms" || raw === "whatsapp" || raw === "none") return raw;
  throw new Error(`DELIVERY_CHANNEL must be sms, whatsapp, or none (got "${raw}")`);
}
