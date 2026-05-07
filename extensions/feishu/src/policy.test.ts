import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { describe, expect, it } from "vitest";
import { FeishuConfigSchema } from "./config-schema.js";
import {
  hasExplicitFeishuGroupConfig,
  resolveFeishuAllowBots,
  resolveFeishuGroupConfig,
  resolveFeishuGroupSenderActivationIngressAccess,
  resolveFeishuReplyPolicy,
} from "./policy.js";
import type { FeishuConfig, FeishuGroupConfig } from "./types.js";

function createCfg(feishu: Record<string, unknown>): OpenClawConfig {
  return {
    channels: {
      feishu,
    },
  } as OpenClawConfig;
}

function createFeishuConfig(overrides: Partial<FeishuConfig>): FeishuConfig {
  return FeishuConfigSchema.parse(overrides);
}

describe("resolveFeishuReplyPolicy", () => {
  it("defaults open groups to no mention when unset", () => {
    expect(
      resolveFeishuReplyPolicy({
        isDirectMessage: false,
        cfg: createCfg({ groupPolicy: "open" }),
        groupPolicy: "open",
        groupId: "oc_1",
      }),
    ).toEqual({ requireMention: false });
  });

  it("keeps explicit top-level mention gating in open groups", () => {
    expect(
      resolveFeishuReplyPolicy({
        isDirectMessage: false,
        cfg: createCfg({ groupPolicy: "open", requireMention: true }),
        groupPolicy: "open",
        groupId: "oc_1",
      }),
    ).toEqual({ requireMention: true });
  });

  it("keeps explicit account mention gating in open groups", () => {
    expect(
      resolveFeishuReplyPolicy({
        isDirectMessage: false,
        cfg: createCfg({
          groupPolicy: "allowlist",
          requireMention: false,
          accounts: {
            work: {
              groupPolicy: "open",
              requireMention: true,
            },
          },
        }),
        accountId: "work",
        groupPolicy: "open",
        groupId: "oc_1",
      }),
    ).toEqual({ requireMention: true });
  });

  it("keeps explicit per-group mention gating in open groups", () => {
    expect(
      resolveFeishuReplyPolicy({
        isDirectMessage: false,
        cfg: createCfg({
          groupPolicy: "open",
          groups: { oc_1: { requireMention: true } },
        }),
        groupPolicy: "open",
        groupId: "oc_1",
      }),
    ).toEqual({ requireMention: true });
  });

  it("defaults allowlist groups to require mentions", () => {
    expect(
      resolveFeishuReplyPolicy({
        isDirectMessage: false,
        cfg: createCfg({ groupPolicy: "allowlist" }),
        groupPolicy: "allowlist",
        groupId: "oc_1",
      }),
    ).toEqual({ requireMention: true });
  });
});

describe("resolveFeishuGroupConfig", () => {
  it("falls back to wildcard group config when direct match is missing", () => {
    const cfg = createFeishuConfig({
      groups: {
        "*": { requireMention: false },
        "oc-explicit": { requireMention: true },
      },
    });

    const resolved = resolveFeishuGroupConfig({
      cfg,
      groupId: "oc-missing",
    });

    expect(resolved).toEqual({ requireMention: false });
  });

  it("prefers exact group config over wildcard", () => {
    const cfg = createFeishuConfig({
      groups: {
        "*": { requireMention: false },
        "oc-explicit": { requireMention: true },
      },
    });

    const resolved = resolveFeishuGroupConfig({
      cfg,
      groupId: "oc-explicit",
    });

    expect(resolved).toEqual({ requireMention: true });
  });

  it("keeps case-insensitive matching for explicit group ids", () => {
    const cfg = createFeishuConfig({
      groups: {
        "*": { requireMention: false },
        OC_UPPER: { requireMention: true },
      },
    });

    const resolved = resolveFeishuGroupConfig({
      cfg,
      groupId: "oc_upper",
    });

    expect(resolved).toEqual({ requireMention: true });
  });
});

describe("hasExplicitFeishuGroupConfig", () => {
  it("matches direct and case-insensitive group ids", () => {
    const cfg = createFeishuConfig({
      groups: {
        OC_UPPER: { requireMention: true },
      },
    });

    expect(hasExplicitFeishuGroupConfig({ cfg, groupId: "OC_UPPER" })).toBe(true);
    expect(hasExplicitFeishuGroupConfig({ cfg, groupId: "oc_upper" })).toBe(true);
  });

  it("does not treat wildcard group defaults as explicit admission", () => {
    const cfg = createFeishuConfig({
      groups: {
        "*": { requireMention: false },
      },
    });

    expect(hasExplicitFeishuGroupConfig({ cfg, groupId: "oc_any" })).toBe(false);
  });
});

describe("resolveFeishuGroupSenderActivationIngressAccess", () => {
  async function senderDecision(params: {
    allowFrom: Array<string | number>;
    senderOpenId: string;
    senderUserId?: string;
  }) {
    return (
      await resolveFeishuGroupSenderActivationIngressAccess({
        cfg: createCfg({}),
        accountId: "default",
        chatId: "oc_group",
        allowFrom: params.allowFrom,
        senderOpenId: params.senderOpenId,
        senderUserId: params.senderUserId,
        requireMention: false,
        mentionedBot: true,
      })
    ).senderAccess.decision;
  }

  it("allows provider-prefixed wildcard entries", async () => {
    await expect(
      senderDecision({
        allowFrom: ["feishu:*", "lark:*"],
        senderOpenId: "ou_anyone",
      }),
    ).resolves.toBe("allow");
  });

  it("matches normalized immutable user ID entries", async () => {
    await expect(
      senderDecision({
        allowFrom: ["feishu:feishu:user:ou_ALLOWED"],
        senderOpenId: "ou_ALLOWED",
      }),
    ).resolves.toBe("allow");
  });

  it("keeps user and chat allowlist namespaces distinct", async () => {
    await expect(
      senderDecision({
        allowFrom: ["user:oc_group_123"],
        senderOpenId: "oc_group_123",
      }),
    ).resolves.toBe("block");
  });

  it("supports user_id as an additional immutable sender candidate", async () => {
    await expect(
      senderDecision({
        allowFrom: ["on_user_123"],
        senderOpenId: "ou_other",
        senderUserId: "on_user_123",
      }),
    ).resolves.toBe("allow");
  });
});

describe("resolveFeishuAllowBots", () => {
  it("defaults to true when no level sets allowBots", () => {
    expect(resolveFeishuAllowBots({})).toBe(true);
  });

  it("returns the channel-level value when nothing else set", () => {
    expect(
      resolveFeishuAllowBots({
        channelConfig: createFeishuConfig({ allowBots: true }),
      }),
    ).toBe(true);
  });

  it("account-level overrides channel-level", () => {
    expect(
      resolveFeishuAllowBots({
        accountConfig: createFeishuConfig({ allowBots: false }),
        channelConfig: createFeishuConfig({ allowBots: true }),
      }),
    ).toBe(false);
  });

  it("group-level overrides account- and channel-level", () => {
    const groupConfig: FeishuGroupConfig = { allowBots: "mentions" };
    expect(
      resolveFeishuAllowBots({
        groupConfig,
        accountConfig: createFeishuConfig({ allowBots: true }),
        channelConfig: createFeishuConfig({ allowBots: false }),
      }),
    ).toBe("mentions");
  });

  it("preserves the literal 'mentions' through resolution", () => {
    expect(
      resolveFeishuAllowBots({
        accountConfig: createFeishuConfig({ allowBots: "mentions" }),
      }),
    ).toBe("mentions");
  });

  it("treats explicit false at a higher priority as authoritative", () => {
    const groupConfig: FeishuGroupConfig = { allowBots: false };
    expect(
      resolveFeishuAllowBots({
        groupConfig,
        accountConfig: createFeishuConfig({ allowBots: true }),
      }),
    ).toBe(false);
  });

  it("falls through to lower levels when a higher level is undefined", () => {
    const groupConfig: FeishuGroupConfig = {};
    expect(
      resolveFeishuAllowBots({
        groupConfig,
        accountConfig: createFeishuConfig({ allowBots: "mentions" }),
        channelConfig: createFeishuConfig({ allowBots: true }),
      }),
    ).toBe("mentions");
  });
});
