import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import "dotenv/config";

/**
 * AES-256-GCM for OAuth tokens at rest.
 *
 * A refresh token is a durable, read-only grant over someone's entire mailbox.
 * A dump of the `accounts` table must not be enough to use one.
 *
 * Ciphertext format: "v1." + base64(iv[12] | authTag[16] | ciphertext).
 * The version prefix exists so a future key rotation can decrypt old values
 * while writing new ones.
 */

const VERSION = "v1";
const IV_BYTES = 12; // 96-bit nonce, the GCM standard
const TAG_BYTES = 16;

let cachedKey: Buffer | null = null;

function key(): Buffer {
  if (cachedKey) return cachedKey;

  const raw = process.env.TOKEN_ENC_KEY;
  if (!raw) {
    throw new Error(
      "TOKEN_ENC_KEY is not set. Generate one with:\n" +
        `  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    );
  }

  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new Error(
      `TOKEN_ENC_KEY must decode to exactly 32 bytes, got ${buf.length}. ` +
        "It should be 32 random bytes, base64-encoded.",
    );
  }

  cachedKey = buf;
  return buf;
}

export function encrypt(plaintext: string): string {
  // A fresh random IV per encryption. Reusing an IV under the same key is the
  // one mistake that breaks GCM outright.
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}.${Buffer.concat([iv, tag, ct]).toString("base64")}`;
}

export function decrypt(payload: string): string {
  const [version, body] = payload.split(".", 2);
  if (version !== VERSION || !body) {
    throw new Error(`Unrecognized ciphertext format (prefix: ${version})`);
  }

  const buf = Buffer.from(body, "base64");
  if (buf.length <= IV_BYTES + TAG_BYTES) {
    throw new Error("Ciphertext is truncated");
  }

  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ct = buf.subarray(IV_BYTES + TAG_BYTES);

  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  // Throws if the tag does not verify — tampered or wrong-key data never
  // reaches the caller as plaintext.
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** Fails fast at boot rather than at first account connect. */
export function assertEncryptionReady(): void {
  const probe = "ops-agent-selftest";
  if (decrypt(encrypt(probe)) !== probe) {
    throw new Error("Token encryption self-test failed");
  }
}
