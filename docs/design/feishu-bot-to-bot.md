# 飞书 channel：bot-to-bot 对话支持

Status: Draft
Owner: (TBD)
Scope: `extensions/feishu/**` 内自治；不改 core、不改 Plugin SDK

## 1. 背景与目标

当前 OpenClaw 的 feishu 插件（`extensions/feishu/`）默认按「人 → 机器人」的模式路由入站消息。飞书支持在群聊里由另一只机器人 @ 本机器人并通过 `im.message.receive_v1` 推送事件；现有实现没有针对性分支，会把对方机器人的消息当作普通用户消息走 `allowFrom` / `dmPolicy` / `pairing`，既不合预期，也不符合仓库里其它 channel 的惯例。

目标：

1. 让本机器人能够响应来自另一只机器人的消息，复用现有 allowlist/路由；
2. 语义与配置键与仓库里的 Discord / Slack / Matrix 保持一致（`allowBots`）；
3. 默认行为不变，对现有用户零影响。

**死循环由事件侧负责**：本方案不引入熔断或窗口计数。循环控制来自两点：

- 用户/自己选择 `allowBots: "mentions"`，对端 bot 不 @ 本 bot 就不触发；
- 现有 reaction 路径已有的 `sender_type === "app"` 防自反思路，补到消息路径上（§4.4）。

非目标：

- 不支持 bot-to-bot 的 p2p（飞书平台无此能力）。
- 不主动发起对话，仅在满足 `allowBots` 策略时响应入站消息。
- 不重写 `src/channels/**` 或 `src/plugin-sdk/**`；改动全部收敛在 feishu 插件内。

## 2. 惯例对齐：仓库里其它 channel 的 `allowBots`

| 插件       | 配置项                              | 枚举                 | 位置                                                                                                                       |
| ---------- | ----------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Discord    | `allowBots?: boolean \| "mentions"` | off / all / mentions | `src/config/types.discord.ts:242`；判定在 `extensions/discord/src/monitor/message-handler.preflight.ts:392-440, 1016-1022` |
| Slack      | `allowBots?: boolean`               | off / on             | `src/config/types.slack.ts:39`；判定在 `extensions/slack/src/monitor/message-handler/prepare.ts:148-185`                   |
| Matrix     | `allowBots?: boolean \| "mentions"` | off / all / mentions | `src/config/zod-schema.providers-core.ts:529-531`                                                                          |
| GoogleChat | `allowBots?: boolean`               | off / on             | `src/config/types.googlechat.ts:44-45`                                                                                     |

Discord 的三态语义最契合飞书需求：

- `false`（默认）：不处理 bot 消息；
- `true`：处理所有 bot 消息；
- `"mentions"`：只处理 @ 本 bot 的 bot 消息（群聊典型诉求）。

Discord 额外做了 **bot self-filter**（`preflight.ts:395-398`）：`author.id === botUserId` 的消息直接 drop，防止 webhook 回推形成自反。飞书侧目前只在 reaction 合成路径做了 `senderId === botOpenId` 的过滤（`extensions/feishu/src/monitor.account.ts:113`），消息路径上没有这一层防御，本方案顺手补齐。

## 3. 关键 API 事实（来自 [接收消息 im.message.receive_v1](https://open.larkoffice.com/document/server-docs/im-v1/message/events/receive)）

### 3.1 两套 `sender_type` 枚举（务必区分）

| 来源                                  | 字段路径                     | 枚举值            |
| ------------------------------------- | ---------------------------- | ----------------- |
| Webhook event `im.message.receive_v1` | `event.sender.sender_type`   | `"user" \| "bot"` |
| Message GET API `im.v1.message.get`   | `items[].sender.sender_type` | `"user" \| "app"` |

- 现有代码对 GET API 返回的 `"app"` 判断（`isFetchedGroupContextSenderAllowed` 等）保持不动。
- 本方案新增的入站分支基于 webhook 的 `"bot"`。
- 类型定义注释里需要显式提示不要混用，避免后续改动串掉。

### 3.2 mention 条目自带 `mentioned_type`

文档中 `mentions[].mentioned_type` 为 `"user" | "bot"`。现有 `FeishuMessageEvent.mentions[]` 没有这个字段，补上之后：

- agent hint 可以按"@ 的是人 vs bot"输出更准确的提示；
- 不依赖白名单即可在上下文中识别 mention 身份；
- 授权仍由现有 allowlist 机制负责。

### 3.3 必需权限（硬前置）

- 接收群聊里**其它机器人 @ 本机器人**的消息：**必须**申请 `im:message.group_at_msg.include_bot:readonly`。
- 既有 `im:message.group_at_msg` / `im:message.group_msg` / `im:message.p2p_msg` **不包含**机器人消息。
- 飞书平台没有"机器人主动对另一只机器人发起 p2p"的能力，本方案不覆盖 p2p；DM 在 allowBots 判定下默认走人类逻辑。

## 4. 设计

### 4.1 配置面：新增 `allowBots`，对齐 Discord

位置：`extensions/feishu/src/config-schema.ts` 的 `FeishuConfigSchema` 与 `FeishuGroupSchema`（同时支持账户/群级 override，参考 Slack 的 `channelConfig?.allowBots ?? account.config?.allowBots ?? cfg.channels?.slack?.allowBots`）。

```ts
// FeishuConfig & FeishuGroupConfig
allowBots?: boolean | "mentions";
```

语义：

| 值             | 群聊                                                                  | 单聊                 |
| -------------- | --------------------------------------------------------------------- | -------------------- |
| `false` / 缺省 | 丢弃 bot sender 消息（当前行为）                                      | 同左                 |
| `true`         | 接受所有 bot sender 消息，继续走 `allowFrom` / `groupSenderAllowFrom` | 同左（实际不会触发） |
| `"mentions"`   | 仅当 `ctx.mentionedBot === true` 时接受                               | 同左                 |

解析优先级（向 Discord / Slack 看齐）：**group-level → account-level → channel-level → default(false)**。

### 4.2 类型与事件解析

- `extensions/feishu/src/event-types.ts`
  - `sender.sender_type` 收紧为 `"user" | "bot"`（注释提示"仅 webhook 事件枚举"）。
  - `mentions[]` 新增 `mentioned_type?: "user" | "bot"`。
- `extensions/feishu/src/mention-target.types.ts`
  - `MentionTarget` 新增 `mentionedType?: "user" | "bot"`。
- `extensions/feishu/src/mention.ts`
  - `extractMentionTargets` 透传 `mentioned_type` → `mentionedType`。
- `extensions/feishu/src/types.ts`
  - `FeishuMessageContext` 增加 `senderType: "user" | "bot"`。
- `extensions/feishu/src/bot.ts` 的 `parseFeishuMessageEvent`
  - 读 `event.sender.sender_type`，缺失回退 `"user"`（老载荷兼容）。

### 4.3 入站门禁：`handleFeishuMessage`

在 `extensions/feishu/src/bot.ts:handleFeishuMessage` 里，**不新增 V2 函数**，只在现有流程中插入最小分支。

位置：紧接 `parseFeishuMessageEvent` 之后、`dedup`/`pairing`/`allowFrom` 之前。

```ts
// Self-filter: never process messages authored by ourselves.
// Mirrors extensions/discord/src/monitor/message-handler.preflight.ts:395-398.
if (botOpenId && ctx.senderOpenId === botOpenId) {
  log(`feishu[${accountId}]: dropping bot-self message ${ctx.messageId}`);
  return;
}

// Bot-author gating: mirror Discord allowBots semantics.
if (ctx.senderType === "bot") {
  const allowBots = resolveFeishuAllowBots({
    groupConfig,
    accountConfig: feishuCfg,
    channelConfig: cfg.channels?.feishu,
  }); // → false | true | "mentions"

  if (allowBots === false) {
    log(`feishu[${accountId}]: dropping bot-authored message (allowBots=false)`);
    return;
  }
  if (allowBots === "mentions" && !ctx.mentionedBot) {
    log(`feishu[${accountId}]: dropping bot-authored message (allowBots=mentions, not mentioned)`);
    return;
  }
  // Falls through to existing allowFrom / dmPolicy / routing / dispatch.
}
```

关键点：

1. **不跳过现有 allowlist**：bot sender 通过 `allowBots` 之后继续走 `effectiveGroupSenderAllowFrom` / `configAllowFrom`。对端 bot 的 open_id 加进允许列表即可，复用现有机制，无需新增 `peerBots`。
2. **不绕过 dmPolicy=pairing**：p2p 场景下飞书平台不会推送机器人消息，`allowBots` 分支事实上不会在 p2p 命中；无需额外处理。
3. **不引入熔断**：循环控制交由 `"mentions"` 模式（对端不 @ 本 bot → 不触发）+ 事件侧（对端自身的 `allowBots` 策略）。
4. 分支只在消息级拦截，不触碰 debounce / 顺序队列 / dedup。

`resolveFeishuAllowBots` 是一个纯函数，位于 `extensions/feishu/src/policy.ts` 旁（或同文件内），按 group → account → channel 优先级合并（等价于 Slack 的 `firstDefined` 模式）。

### 4.4 Agent 提示增强（可选但推荐）

在 `buildFeishuAgentBody` 里按现有风格追加 system hint，只在需要时出现：

- `senderType === "bot"` 时：

```
[System: The sender is another bot "<senderName>" (open_id=<ou_xxx>). Keep the reply concise.]
```

- `mentionTargets` 中存在 `mentionedType === "bot"` 时：

```
[System: This message also @-mentions another bot. Treat those targets as normal mention recipients.]
```

不改 `formatMentionForText`——出站 `<at user_id="ou_xxx">Name</at>` 对 bot open_id 同样生效。

### 4.5 会话 scope（保持现状）

不改 `GroupSessionScope`。用户若希望"bot-bot 对话与真人对话不共享记忆"，可在 `feishu.groupSessionScope` 或群级 override 里显式设 `group_sender`（`extensions/feishu/src/bot-content.ts` 已支持）。这是已有能力，不是本方案要新增的功能。

### 4.6 Onboarding / 文档

- `docs/channels/feishu.md` 新增 "Bot-to-bot conversations" 小节，说明：
  - `allowBots` 语义、默认值、群/账号/channel 三级覆盖；
  - 必须申请 `im:message.group_at_msg.include_bot:readonly`，否则事件根本不会推送；
  - 授权通过既有 `allowFrom` / `groupSenderAllowFrom` 管理，对端 bot 的 open_id 要显式列入。
- `extensions/feishu/skills/feishu-perm/SKILL.md` 补 scope 建议。
- `extensions/feishu/src/config-ui-hints.ts` 如果存在，按 Discord/Slack 的 `config-ui-hints.ts:208-211` 风格加一条 `allowBots` 的 label/help。
- 如有 `openclaw doctor` 的飞书段，遇到 `allowBots !== false` 时 echo 一次 scope 提醒（不做真实验证）。

### 4.7 向后兼容

- `allowBots` 默认 `false`：现有用户零影响；
- `FeishuMessageContext.senderType` 新增可选字段，未迁移调用点取 fallback `"user"`；
- `mentions[].mentioned_type` / `MentionTarget.mentionedType` 均 optional，老载荷读为 `undefined`；
- bot self-filter 基于 `botOpenId`，对 `botOpenId` 未知时不影响（不 drop）；
- 不改现有 lifecycle test 行为。

## 5. 实施步骤（按 commit 切分）

1. **Schema + 类型扩展**  
   `config-schema.ts` 加 `allowBots`（channel + group schema 各一）；`types.ts` / `event-types.ts` / `mention-target.types.ts` 按 §4.2 改；`parseFeishuMessageEvent` 填入 `senderType`；`extractMentionTargets` 透传 `mentionedType`。仅类型与 schema 层。

2. **Policy resolver**  
   `policy.ts` 新增 `resolveFeishuAllowBots({ groupConfig, accountConfig, channelConfig })` 纯函数 + 单测。

3. **Self-filter + allowBots 分支接线**  
   `handleFeishuMessage` 按 §4.3 插入两段判定（self-filter + bot gating）。lifecycle 测试 `cross-bot.lifecycle.test.ts` 覆盖：
   - `allowBots=false` → drop；
   - `allowBots=true` 通过，继续走 allowFrom（无 allowlist 时仍按 groupPolicy 原有规则）；
   - `allowBots="mentions"` 且未 @ → drop；
   - `allowBots="mentions"` 且已 @ → 进入 agent；
   - self-message（`senderOpenId === botOpenId`）→ drop；
   - group override 优先级：group > account > channel。

4. **Agent hint + mention metadata snapshot**  
   `buildFeishuAgentBody` 与 `mention.ts` 扩展；为 `bot.test.ts` 补断言。

5. **文档 + 权限提示**  
   `docs/channels/feishu.md`、`feishu-perm/SKILL.md`、`config-ui-hints.ts`（如存在）、`openclaw doctor` 的 echo。

6. **Changelog**  
   `### Changes` 末尾追加一条用户可见条目。

> 依赖顺序：1 → 2 → 3；4/5 可并行；6 最后。

## 6. 测试策略

- **单元**
  - `policy.test.ts`：`resolveFeishuAllowBots` 的三级优先级与默认值。
  - `mention.test.ts`：`mentioned_type` 透传。
  - `bot.checkBotMentioned.test.ts`：sender_type=bot 下 mentionedBot 仍能判为 true。
- **Lifecycle**
  - `cross-bot.lifecycle.test.ts` 覆盖 §5 步骤 3 的六种路径。
- **回归**
  - 现有 `bot.test.ts` / `channel.test.ts` / `monitor.*.lifecycle.test*.ts` / `reaction.test.ts`：默认 `allowBots=false`，行为不变。
- **手工验证（可选）**
  - 两个 OpenClaw 实例各绑一个飞书应用，都 `allowBots: "mentions"` 并互相把 open_id 加进 `groupAllowFrom`；都申请 `im:message.group_at_msg.include_bot:readonly`。
  - 真人 @ A → A 回复并 @ B → B 回复并 @ A。观察是否按预期持续；若需要停止，任何一方改回 `allowBots: false` 或用 agent 引导"不再 @ 对方"即可自然终止。

- **验证门禁**：`pnpm check` + `pnpm test`；未触碰 build 输出、模块边界，无需 `pnpm build`。

## 7. 风险与权衡

- **死循环由事件侧负责**：本方案只保留最小的 self-filter（防 webhook 回推自反）；其它循环的防护依赖配置（`allowBots: "mentions"`）和对端 bot 的行为。与 Discord 一致。
- **`include_bot` scope 没给就没事件**：文档/doctor 里提示，不在代码里做 verify。
- **`allowFrom` 配置遗漏**：对端 bot 要被正常响应，仍需进入群 sender allowlist（与真人同一机制）。这比新造 `peerBots` 更一致。
- **不做熔断**：如未来出现"对端 bot 行为不可控导致刷屏"，再以独立 PR 按需增加 per-chat 限流；本期不预设。

## 8. 参考

- 飞书官方：[接收消息 im.message.receive_v1](https://open.larkoffice.com/document/server-docs/im-v1/message/events/receive)
- 仓库内的 `allowBots` 参考实现：
  - `extensions/discord/src/monitor/message-handler.preflight.ts:392-440, 1016-1022`
  - `extensions/slack/src/monitor/message-handler/prepare.ts:148-185`
  - `extensions/slack/src/monitor/channel-config.ts:13-150`（三级优先级合并范式）
  - `src/config/types.discord.ts:242-243`
  - `src/config/types.slack.ts:39-40, 135-136`
- 现有代码锚点：
  - `extensions/feishu/src/bot.ts`（`handleFeishuMessage`、`parseFeishuMessageEvent`）
  - `extensions/feishu/src/mention.ts`
  - `extensions/feishu/src/event-types.ts`、`types.ts`、`mention-target.types.ts`
  - `extensions/feishu/src/policy.ts`、`config-schema.ts`
  - `extensions/feishu/src/monitor.account.ts:113`（reaction self-filter 范式）
