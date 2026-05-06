import { describe, expect, it } from "vitest";
import { SessionSchema } from "./zod-schema.session.js";

describe("SessionSchema maintenance extensions", () => {
  it("accepts session write-lock acquire timeout", () => {
    expect(() =>
      SessionSchema.parse({
        writeLock: {
          acquireTimeoutMs: 60_000,
        },
      }),
    ).not.toThrow();
  });

  it("rejects invalid session write-lock acquire timeout values", () => {
    expect(() =>
      SessionSchema.parse({
        writeLock: {
          acquireTimeoutMs: 0,
        },
      }),
    ).toThrow(/acquireTimeoutMs|number/i);
  });

  it("accepts ignored legacy disk budget settings", () => {
    expect(() =>
      SessionSchema.parse({
        maintenance: {
          maxDiskBytes: "big",
          highWaterBytes: "legacy",
        },
      }),
    ).not.toThrow();
  });
});
