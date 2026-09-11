import { describe, expect, it } from "vitest";
import { sanitizeJobId } from "../outbox-publisher.js";

/**
 * Regression: the outbox built BullMQ job ids as `${aggregateType}:${aggregateId}`.
 * BullMQ reserves ":" as its Redis key separator and rejects it outright
 * ("Custom Id cannot contain :"), so every outbox tick failed and no job ever
 * reached a worker. Unit tests never caught it because they call the services
 * directly rather than crossing the outbox -> queue hop.
 */
describe("sanitizeJobId", () => {
  it("strips the colons BullMQ rejects in custom job ids", () => {
    expect(sanitizeJobId("publishing:abc-123")).not.toContain(":");
    expect(sanitizeJobId("publish:post-1:gen-2")).toBe("publish-post-1-gen-2");
  });

  it("leaves an already-safe id untouched, so ids stay deterministic", () => {
    const id = "publishing-0dde6214-ee18-4b5d-bc32-75e98e0b792b";
    expect(sanitizeJobId(id)).toBe(id);
  });
});
