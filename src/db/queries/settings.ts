import { pool } from "../pool.js";

/**
 * Runtime-editable operational settings.
 *
 * Secrets stay in env vars; this holds non-secret values a human changes while
 * the system is running — so a database dump never leaks a credential.
 */

export const SETTING_KEYS = {
  /** Where the morning brief is delivered. */
  briefRecipient: "brief_recipient_sms",
} as const;

export async function getSetting(key: string): Promise<string | null> {
  const { rows } = await pool.query<{ value: string }>(
    "select value from settings where key = $1",
    [key],
  );
  return rows[0]?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await pool.query(
    `insert into settings (key, value, updated_at) values ($1, $2, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, value],
  );
}

export async function deleteSetting(key: string): Promise<void> {
  await pool.query("delete from settings where key = $1", [key]);
}

/**
 * E.164 is what Twilio requires, and a number rejected at send time surfaces as
 * a failed brief at 6:30am. Validating on save turns that into a form error.
 */
export function normalizePhoneNumber(raw: string): string {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/[^\d+]/g, "");

  // A bare 10-digit number is almost always US; assume +1 rather than reject.
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  if (!/^\+[1-9]\d{7,14}$/.test(digits)) {
    throw new Error(
      `"${raw}" is not a valid phone number. Use E.164 format, e.g. +15715551234.`,
    );
  }
  return digits;
}

/**
 * The brief recipient, preferring the console-configured value.
 *
 * The env var remains as a fallback so a fresh deployment can still deliver
 * before anyone opens the console.
 */
export async function briefRecipient(envFallback: string): Promise<string> {
  const configured = await getSetting(SETTING_KEYS.briefRecipient);
  return configured ?? envFallback;
}
