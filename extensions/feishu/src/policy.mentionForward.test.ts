import { describe, expect, it } from "vitest";
import { FeishuConfigSchema } from "./config-schema.js";
import { resolveFeishuMentionForward } from "./policy.js";
import type { FeishuConfig } from "./types.js";

function createFeishuConfig(overrides: Partial<FeishuConfig>): FeishuConfig {
  return FeishuConfigSchema.parse(overrides);
}

describe("resolveFeishuMentionForward", () => {
  it("defaults to false when nothing is configured", () => {
    expect(resolveFeishuMentionForward({})).toBe(false);
  });

  it("returns group-level value when set", () => {
    expect(
      resolveFeishuMentionForward({
        groupConfig: { mentionForward: false },
        accountConfig: createFeishuConfig({ mentionForward: true }),
        channelConfig: createFeishuConfig({ mentionForward: true }),
      }),
    ).toBe(false);
  });

  it("falls back to account when group is unset", () => {
    expect(
      resolveFeishuMentionForward({
        accountConfig: createFeishuConfig({ mentionForward: false }),
        channelConfig: createFeishuConfig({ mentionForward: true }),
      }),
    ).toBe(false);
  });

  it("falls back to channel when group and account are unset", () => {
    expect(
      resolveFeishuMentionForward({
        channelConfig: createFeishuConfig({ mentionForward: false }),
      }),
    ).toBe(false);
  });

  it("treats explicit true at any level as enabled", () => {
    expect(
      resolveFeishuMentionForward({
        groupConfig: { mentionForward: true },
      }),
    ).toBe(true);
  });
});
