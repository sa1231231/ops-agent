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
  /** Local hour (0-23) the brief goes out. */
  briefHour: "brief_hour",
  /** Who the greeting addresses. A setting, not a constant, so a misspelling is his to fix. */
  briefGreetingName: "brief_greeting_name",
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

/**
 * The hour the brief is sent, preferring the console-configured value.
 *
 * Hour granularity, because the worker runs hourly — a half-past setting would
 * silently fire up to an hour late, which is worse than not offering it.
 */
export async function briefHour(envFallback: number): Promise<number> {
  const raw = await getSetting(SETTING_KEYS.briefHour);
  if (raw === null) return envFallback;
  const hour = Number.parseInt(raw, 10);
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : envFallback;
}

/** Greeting name, or "" for a bare "Good morning". */
export async function briefGreetingName(): Promise<string> {
  return (await getSetting(SETTING_KEYS.briefGreetingName)) ?? DEFAULT_GREETING_NAME;
}

export const DEFAULT_GREETING_NAME = "Payeman";

/** Stripped to what fits in a greeting; the message is GSM-7 and single-line. */
export function normalizeGreetingName(raw: string): string {
  const name = raw.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  if (name.length > 40) throw new Error("That name is too long for a greeting.");
  return name;
}

export function normalizeHour(raw: string): string {
  const hour = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error(`"${raw}" is not a valid hour. Choose 0-23.`);
  }
  return String(hour);
}
