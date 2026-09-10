import { createCipheriv, createDecipheriv, randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { AppError } from "./errors.js";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;
const VERSION = "v1";

export class EncryptionNotConfiguredError extends AppError {
  constructor() {
    super("TOKEN_ENCRYPTION_KEY is not configured — cannot store or read social access tokens", {
      statusCode: 500,
      code: "ENCRYPTION_NOT_CONFIGURED",
    });
  }
}

export class DecryptionFailedError extends AppError {
  constructor() {
    // Deliberately vague: never leak ciphertext, key material, or which part failed.
    super("Failed to decrypt stored credential", { statusCode: 500, code: "DECRYPTION_FAILED" });
  }
}

function parseKey(rawKey: string): Buffer {
  const hex = /^[0-9a-fA-F]{64}$/;
  const key = hex.test(rawKey) ? Buffer.from(rawKey, "hex") : Buffer.from(rawKey, "base64");
  if (key.length !== KEY_BYTES) {
    throw new AppError(
      `TOKEN_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${key.length}) — use 64 hex chars or 32 base64-encoded bytes`,
      { statusCode: 500, code: "ENCRYPTION_KEY_INVALID" },
    );
  }
  return key;
}

/**
 * AES-256-GCM encryption for OAuth tokens at rest. Ciphertext is stored as
 * `v1:<iv>:<authTag>:<ciphertext>` (all base64) so the format is
 * self-describing and can be rotated later without ambiguity.
 *
 * Nothing here ever logs or returns plaintext on error — a decryption
 * failure surfaces as a generic DecryptionFailedError.
 */
export class TokenEncryptionService {
  private readonly key: Buffer;

  constructor(rawKey: string) {
    if (!rawKey) throw new EncryptionNotConfiguredError();
    this.key = parseKey(rawKey);
  }

  static isConfigured(rawKey: string | undefined): boolean {
    return Boolean(rawKey);
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [VERSION, iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(":");
  }

  decrypt(encoded: string): string {
    const parts = encoded.split(":");
    if (parts.length !== 4 || parts[0] !== VERSION) throw new DecryptionFailedError();
    try {
      const [, ivB64, tagB64, dataB64] = parts;
      const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(ivB64, "base64"));
      decipher.setAuthTag(Buffer.from(tagB64, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
    } catch {
      throw new DecryptionFailedError();
    }
  }
}

/** Generates a key suitable for TOKEN_ENCRYPTION_KEY (used by docs/tooling, not at runtime). */
export function generateEncryptionKey(): string {
  return randomBytes(KEY_BYTES).toString("hex");
}

/**
 * Constant-time comparison for OAuth `state` so validation can't be probed
 * by timing. Returns false rather than throwing on length mismatch.
 */
export function safeCompare(a: string, b: string): boolean {
  const aHash = createHash("sha256").update(a).digest();
  const bHash = createHash("sha256").update(b).digest();
  return timingSafeEqual(aHash, bHash);
}
