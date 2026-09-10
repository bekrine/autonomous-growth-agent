import { describe, expect, it } from "vitest";
import {
  DecryptionFailedError,
  EncryptionNotConfiguredError,
  TokenEncryptionService,
  generateEncryptionKey,
  safeCompare,
} from "../crypto.js";

const KEY = generateEncryptionKey();

describe("TokenEncryptionService", () => {
  it("round-trips a token", () => {
    const svc = new TokenEncryptionService(KEY);
    const token = "IGQVJXexample-access-token-value";
    const encrypted = svc.encrypt(token);

    expect(encrypted).not.toContain(token);
    expect(svc.decrypt(encrypted)).toBe(token);
  });

  it("produces different ciphertext each time (random IV)", () => {
    const svc = new TokenEncryptionService(KEY);
    expect(svc.encrypt("same")).not.toBe(svc.encrypt("same"));
  });

  it("rejects tampered ciphertext rather than returning garbage", () => {
    const svc = new TokenEncryptionService(KEY);
    const encrypted = svc.encrypt("secret");
    const [v, iv, tag, data] = encrypted.split(":");
    const tampered = [v, iv, tag, Buffer.from("evil").toString("base64")].join(":");

    expect(() => svc.decrypt(tampered)).toThrow(DecryptionFailedError);
  });

  it("rejects a token encrypted under a different key", () => {
    const encrypted = new TokenEncryptionService(KEY).encrypt("secret");
    const other = new TokenEncryptionService(generateEncryptionKey());
    expect(() => other.decrypt(encrypted)).toThrow(DecryptionFailedError);
  });

  it("accepts base64 keys as well as hex", () => {
    const b64 = Buffer.from(KEY, "hex").toString("base64");
    const svc = new TokenEncryptionService(b64);
    expect(svc.decrypt(svc.encrypt("x"))).toBe("x");
  });

  it("throws when no key is configured", () => {
    expect(() => new TokenEncryptionService("")).toThrow(EncryptionNotConfiguredError);
  });

  it("rejects a key of the wrong length", () => {
    expect(() => new TokenEncryptionService("abcd")).toThrow(/32 bytes/);
  });
});

describe("safeCompare", () => {
  it("matches identical values and rejects different ones", () => {
    expect(safeCompare("state-abc", "state-abc")).toBe(true);
    expect(safeCompare("state-abc", "state-xyz")).toBe(false);
    expect(safeCompare("short", "a-much-longer-value")).toBe(false);
  });
});
