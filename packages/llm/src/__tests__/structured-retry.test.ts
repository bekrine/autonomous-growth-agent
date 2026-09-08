import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { generateStructuredWithRetry } from "../structured-retry.js";
import { LLMRequestError, LLMValidationError } from "../errors.js";

const schema = z.object({ value: z.number() });

describe("generateStructuredWithRetry", () => {
  it("returns parsed data on the first valid attempt", async () => {
    const generate = vi.fn(async () => JSON.stringify({ value: 1 }));
    const result = await generateStructuredWithRetry({ schema, schemaName: "test", maxRetries: 3, generate });
    expect(result).toEqual({ value: 1 });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("retries after invalid JSON and succeeds", async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce("not json")
      .mockResolvedValueOnce(JSON.stringify({ value: 2 }));
    const result = await generateStructuredWithRetry({ schema, schemaName: "test", maxRetries: 3, generate });
    expect(result).toEqual({ value: 2 });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1][0]).toContain("not valid JSON");
  });

  it("retries after a schema violation and succeeds", async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify({ value: "not-a-number" }))
      .mockResolvedValueOnce(JSON.stringify({ value: 3 }));
    const result = await generateStructuredWithRetry({ schema, schemaName: "test", maxRetries: 3, generate });
    expect(result).toEqual({ value: 3 });
    expect(generate.mock.calls[1][0]).toContain("did not match the required schema");
  });

  it("throws LLMValidationError after exhausting retries on invalid output", async () => {
    const generate = vi.fn(async () => JSON.stringify({ value: "nope" }));
    await expect(
      generateStructuredWithRetry({ schema, schemaName: "test", maxRetries: 2, generate }),
    ).rejects.toBeInstanceOf(LLMValidationError);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("throws LLMRequestError after exhausting retries on request failure", async () => {
    const generate = vi.fn(async () => {
      throw new Error("network down");
    });
    await expect(
      generateStructuredWithRetry({ schema, schemaName: "test", maxRetries: 2, generate }),
    ).rejects.toBeInstanceOf(LLMRequestError);
    expect(generate).toHaveBeenCalledTimes(2);
  });
});
