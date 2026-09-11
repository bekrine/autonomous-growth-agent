import { describe, expect, it, vi } from "vitest";
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { CloudflareR2Storage, classifyStorageError } from "../providers/cloudflare-r2-storage.js";
import { StorageError } from "../errors.js";

/**
 * The S3 client is mocked throughout — these tests must never reach
 * Cloudflare. The real bucket is exercised only by the opt-in integration
 * test (R2_INTEGRATION_TEST=true).
 */

const CONFIG = {
  accountId: "test-account",
  accessKeyId: "test-key-id",
  secretAccessKey: "test-secret",
  bucket: "autonomous-growth-media",
  publicBaseUrl: "https://pub-test.r2.dev",
};

function mockSend(impl: (command: unknown) => unknown) {
  return vi.spyOn(S3Client.prototype, "send").mockImplementation(impl as never);
}

function awsError(name: string, httpStatusCode?: number) {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode } });
}

describe("CloudflareR2Storage configuration", () => {
  it("refuses to construct when settings are missing, naming fields but never values", () => {
    try {
      new CloudflareR2Storage({ ...CONFIG, secretAccessKey: "", bucket: "" });
      throw new Error("expected construction to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(StorageError);
      const storageError = error as StorageError;
      expect(storageError.storageCode).toBe("STORAGE_NOT_CONFIGURED");
      expect(storageError.message).toContain("secretAccessKey");
      expect(storageError.message).toContain("bucket");
      // The message must not leak the credentials that *were* supplied.
      expect(storageError.message).not.toContain(CONFIG.accessKeyId);
      expect(storageError.message).not.toContain("test-secret");
    }
  });
});

describe("CloudflareR2Storage.upload", () => {
  it("puts the object with content type, length, cache-control and metadata", async () => {
    const commands: PutObjectCommand[] = [];
    const send = mockSend((command) => {
      commands.push(command as PutObjectCommand);
      return {};
    });

    const storage = new CloudflareR2Storage(CONFIG);
    const result = await storage.put({
      key: "accounts/a1/content/c1/images/as1.jpg",
      data: Buffer.from("jpeg-bytes"),
      contentType: "image/jpeg",
      metadata: { "asset-id": "as1" },
    });

    expect(send).toHaveBeenCalledOnce();
    const input = commands[0]!.input;
    expect(input.Bucket).toBe("autonomous-growth-media");
    expect(input.Key).toBe("accounts/a1/content/c1/images/as1.jpg");
    expect(input.ContentType).toBe("image/jpeg");
    expect(input.ContentLength).toBe(10);
    expect(input.CacheControl).toContain("max-age");
    expect(input.Metadata).toEqual({ "asset-id": "as1" });

    expect(result.url).toBe("https://pub-test.r2.dev/accounts/a1/content/c1/images/as1.jpg");
    expect(result.size).toBe(10);
    expect(result.contentType).toBe("image/jpeg");

    send.mockRestore();
  });

  it("rejects an empty buffer before touching the network", async () => {
    const send = mockSend(() => ({}));
    const storage = new CloudflareR2Storage(CONFIG);

    await expect(storage.put({ key: "k", data: Buffer.alloc(0), contentType: "image/jpeg" })).rejects.toMatchObject({
      storageCode: "STORAGE_INVALID_MEDIA",
    });
    expect(send).not.toHaveBeenCalled();
    send.mockRestore();
  });

  it("surfaces a normalized error, not the raw SDK failure", async () => {
    const send = mockSend(() => {
      throw awsError("SignatureDoesNotMatch", 403);
    });
    const storage = new CloudflareR2Storage(CONFIG);

    const error: StorageError = await storage
      .put({ key: "k", data: Buffer.from("x"), contentType: "image/jpeg" })
      .then(() => {
        throw new Error("expected the upload to reject");
      })
      .catch((e: unknown) => e as StorageError);

    expect(error).toBeInstanceOf(StorageError);
    expect(error.storageCode).toBe("STORAGE_AUTHENTICATION_FAILED");
    expect(error.message).not.toContain("SignatureDoesNotMatch");
    // The provider detail is kept for logs only.
    expect(error.providerDetail).toContain("SignatureDoesNotMatch");
    send.mockRestore();
  });

  it("retries a transient failure and stops at the bounded attempt limit", async () => {
    let calls = 0;
    const send = mockSend(() => {
      calls += 1;
      throw awsError("InternalError", 500);
    });
    const storage = new CloudflareR2Storage({ ...CONFIG, maxAttempts: 3 });

    await expect(storage.put({ key: "k", data: Buffer.from("x"), contentType: "image/jpeg" })).rejects.toMatchObject({
      storageCode: "STORAGE_UNAVAILABLE",
    });
    expect(calls).toBe(3);
    send.mockRestore();
  });

  it("does not retry a permanent failure", async () => {
    let calls = 0;
    const send = mockSend(() => {
      calls += 1;
      throw awsError("InvalidAccessKeyId", 403);
    });
    const storage = new CloudflareR2Storage({ ...CONFIG, maxAttempts: 3 });

    await expect(storage.put({ key: "k", data: Buffer.from("x"), contentType: "image/jpeg" })).rejects.toMatchObject({
      storageCode: "STORAGE_AUTHENTICATION_FAILED",
    });
    expect(calls).toBe(1);
    send.mockRestore();
  });

  it("is safe to retry: the same key overwrites rather than creating a second object", async () => {
    const keys: string[] = [];
    const send = mockSend((command) => {
      keys.push((command as PutObjectCommand).input.Key!);
      return {};
    });
    const storage = new CloudflareR2Storage(CONFIG);
    const input = { key: "accounts/a/content/c/images/x.jpg", data: Buffer.from("a"), contentType: "image/jpeg" };

    await storage.put(input);
    await storage.put(input);

    expect(keys).toEqual([input.key, input.key]);
    send.mockRestore();
  });
});

describe("CloudflareR2Storage.getPublicUrl", () => {
  it("builds a deterministic URL with no credentials and no network call", async () => {
    const send = mockSend(() => ({}));
    const storage = new CloudflareR2Storage(CONFIG);

    const url = await storage.getPublicUrl("accounts/a1/content/c1/images/as1.jpg");

    expect(url).toBe("https://pub-test.r2.dev/accounts/a1/content/c1/images/as1.jpg");
    expect(url).not.toContain(CONFIG.accessKeyId);
    expect(url).not.toContain(CONFIG.secretAccessKey);
    expect(url).not.toContain(CONFIG.accountId);
    expect(send).not.toHaveBeenCalled();
    send.mockRestore();
  });

  it("normalizes a trailing slash on the configured base URL", async () => {
    const storage = new CloudflareR2Storage({ ...CONFIG, publicBaseUrl: "https://pub-test.r2.dev/" });
    expect(await storage.getPublicUrl("a/b.jpg")).toBe("https://pub-test.r2.dev/a/b.jpg");
  });
});

describe("CloudflareR2Storage.exists", () => {
  it("returns true when the object is there", async () => {
    const send = mockSend((command) => {
      expect(command).toBeInstanceOf(HeadObjectCommand);
      return {};
    });
    const storage = new CloudflareR2Storage(CONFIG);
    expect(await storage.exists("some/key.jpg")).toBe(true);
    send.mockRestore();
  });

  it("returns false — rather than throwing — for a missing object", async () => {
    const send = mockSend(() => {
      throw awsError("NotFound", 404);
    });
    const storage = new CloudflareR2Storage(CONFIG);
    expect(await storage.exists("missing.jpg")).toBe(false);
    send.mockRestore();
  });

  it("still throws when the failure is not 'missing'", async () => {
    const send = mockSend(() => {
      throw awsError("InvalidAccessKeyId", 403);
    });
    const storage = new CloudflareR2Storage(CONFIG);
    await expect(storage.exists("x.jpg")).rejects.toMatchObject({ storageCode: "STORAGE_AUTHENTICATION_FAILED" });
    send.mockRestore();
  });
});

describe("CloudflareR2Storage.delete", () => {
  it("issues a delete for the given key", async () => {
    const commands: DeleteObjectCommand[] = [];
    const send = mockSend((command) => {
      commands.push(command as DeleteObjectCommand);
      return {};
    });
    const storage = new CloudflareR2Storage(CONFIG);

    await storage.delete("accounts/a/content/c/images/x.jpg");

    expect(commands[0]!.input.Key).toBe("accounts/a/content/c/images/x.jpg");
    expect(commands[0]!.input.Bucket).toBe("autonomous-growth-media");
    send.mockRestore();
  });
});

describe("classifyStorageError", () => {
  it("maps provider failures onto normalized, correctly-retryable codes", () => {
    expect(classifyStorageError("put", awsError("NoSuchBucket", 404)).storageCode).toBe("STORAGE_BUCKET_NOT_FOUND");
    expect(classifyStorageError("put", awsError("TimeoutError")).storageCode).toBe("STORAGE_TIMEOUT");
    expect(classifyStorageError("put", awsError("InternalError", 503)).retryable).toBe(true);
    expect(classifyStorageError("put", awsError("AccessDenied", 403)).retryable).toBe(false);
  });
});
