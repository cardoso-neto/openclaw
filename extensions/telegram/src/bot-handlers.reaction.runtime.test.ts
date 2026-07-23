import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { getChildLogger } from "openclaw/plugin-sdk/runtime-env";
import * as runtimeEnv from "openclaw/plugin-sdk/runtime-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTelegramEventBindings } from "./bot-handlers.event-bindings.js";
import { createTelegramHandlerAuthorization } from "./bot-handlers.inbound-authorization.js";
import type { TelegramMessagePipeline } from "./bot-handlers.message-pipeline.js";
import type { RegisterTelegramHandlerParams } from "./bot-handlers.types.js";
import { resolveTelegramScopedGroupConfig } from "./group-config-helpers.js";
import { setTelegramRuntime } from "./runtime.js";
import type { TelegramThreadSpec } from "./thread-spec.js";

const FIRE_EMOJI = "\u{1F525}";
const FORUM_CHAT_ID = -1005678;
const FORUM_TOPIC_ID = 77;
const REACTED_MESSAGE_ID = 100;
type ReactionHandler = (ctx: Record<string, unknown>) => Promise<void>;

const { readRuntimeConfig, wasSentByBotMock } = vi.hoisted(() => ({
  readRuntimeConfig: vi.fn(),
  wasSentByBotMock: vi.fn<() => boolean | Promise<boolean>>(),
}));
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>()),
  readRuntimeConfig,
}));
vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/conversation-runtime")>()),
  readChannelAllowFromStore: async () => [],
}));
vi.mock("./sent-message-cache.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sent-message-cache.js")>()),
  wasSentByBot: async () => await wasSentByBotMock(),
}));
const runtimeLog = vi.fn();
const runtimeError = vi.fn();
const processMessageWithReplyChain =
  vi.fn<TelegramMessagePipeline["processMessageWithReplyChain"]>();
const resolveCachedMessageThreadSpec =
  vi.fn<
    (params: {
      chatId: number | string;
      messageId: number | string;
    }) => Promise<TelegramThreadSpec | undefined>
  >();

function buildTelegramConfig(overrides?: {
  reactionNotifications?: "all" | "own";
  topics?: Record<string, { enabled?: boolean; agentId?: string }>;
}): OpenClawConfig {
  return {
    channels: {
      telegram: {
        dmPolicy: "open",
        allowFrom: ["*"],
        reactionNotifications: overrides?.reactionNotifications ?? "all",
        groupPolicy: "open",
        groups: {
          [String(FORUM_CHAT_ID)]: {
            enabled: true,
            ...(overrides?.topics ? { topics: overrides.topics } : {}),
          },
        },
      },
    },
  };
}

function registerHandler(
  cfg: OpenClawConfig,
  wasSentByBot: () => boolean | Promise<boolean> = () => true,
): ReactionHandler {
  readRuntimeConfig.mockReturnValue(cfg);
  wasSentByBotMock.mockImplementation(wasSentByBot);
  const handlers = new Map<string, ReactionHandler>();
  const params: RegisterTelegramHandlerParams = {
    accountId: "default",
    ownerAgentId: "main",
    bot: {
      on: (name: string, handler: ReactionHandler) => {
        handlers.set(name, handler);
      },
    } as RegisterTelegramHandlerParams["bot"],
    cfg,
    mediaMaxBytes: 1,
    opts: { token: "tok" },
    telegramCfg: {},
    logger: getChildLogger({ module: "telegram/reaction-test" }),
    runtime: { log: runtimeLog, error: runtimeError, exit: vi.fn() },
    shouldSkipUpdate: () => false,
    resolveGroupPolicy: () => ({ allowlistEnabled: false, allowed: true }),
    resolveGroupActivation: () => undefined,
    resolveGroupRequireMention: () => false,
    resolveTelegramGroupConfig: (
      chatId: string | number,
      messageThreadId: number | undefined,
      config: OpenClawConfig,
    ) => resolveTelegramScopedGroupConfig(config.channels?.telegram ?? {}, chatId, messageThreadId),
    processMessage: vi.fn<RegisterTelegramHandlerParams["processMessage"]>(),
  };
  createTelegramEventBindings({
    params,
    message: { processMessageWithReplyChain, resolveCachedMessageThreadSpec },
    authorization: createTelegramHandlerAuthorization(params),
  }).registerReaction();
  const handler = handlers.get("message_reaction");
  if (!handler) {
    throw new Error("expected message_reaction handler");
  }
  return handler;
}

function forumReactionContext(overrides?: {
  oldReaction?: Array<{ type: string; emoji: string }>;
  newReaction?: Array<{ type: string; emoji: string }>;
  isForum?: boolean;
  isDirectMessages?: boolean;
  chatType?: string;
}) {
  return {
    update: { update_id: 900 },
    me: { id: 999, username: "openclaw_bot" },
    getFile: async () => ({}),
    messageReaction: {
      chat: {
        id: overrides?.chatType === "private" ? 5678 : FORUM_CHAT_ID,
        type: overrides?.chatType ?? "supergroup",
        ...(overrides?.isForum === false ? {} : { is_forum: true }),
        ...(overrides?.isDirectMessages ? { is_direct_messages: true } : {}),
      },
      message_id: REACTED_MESSAGE_ID,
      user: { id: 10, first_name: "Bob", username: "bob_user" },
      date: 1736380800,
      old_reaction: overrides?.oldReaction ?? [],
      new_reaction: overrides?.newReaction ?? [{ type: "emoji", emoji: FIRE_EMOJI }],
    },
  };
}

function firstDispatch() {
  const call = processMessageWithReplyChain.mock.calls[0]?.[0];
  if (!call) {
    throw new Error("expected an agent-turn dispatch");
  }
  return call;
}

describe("registerTelegramReactionHandler agent turns", () => {
  beforeEach(() => {
    setTelegramRuntime(createPluginRuntimeMock());
    processMessageWithReplyChain.mockReset();
    processMessageWithReplyChain.mockResolvedValue({ kind: "completed" });
    runtimeLog.mockClear();
    runtimeError.mockClear();
    resolveCachedMessageThreadSpec.mockReset();
    resolveCachedMessageThreadSpec.mockResolvedValue(undefined);
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
    vi.restoreAllMocks();
  });

  it("keeps reaction content in the agent turn and out of verbose diagnostics", async () => {
    const log = vi.spyOn(runtimeEnv, "logVerbose").mockImplementation(() => {});
    await registerHandler(buildTelegramConfig())(
      forumReactionContext({ isForum: false, chatType: "private" }),
    );
    expect(firstDispatch().msg.text).toBe(
      "[Emoji reaction update: added \u{1F525} by Bob (@bob_user) on message 100]",
    );
    expect(firstDispatch().options?.forceWasMentioned).toBe(true);
    expect(firstDispatch().options?.messageIdOverride).toBe("900");
    const diagnostics = log.mock.calls.map(([line]) => line).join("\n");
    expect(diagnostics).not.toContain("Bob");
    expect(diagnostics).not.toContain(FIRE_EMOJI);
  });

  it.each(["private", "supergroup"] as const)(
    "authorizes %s reaction senders before combining distinct additions into one turn",
    async (chatType) => {
      const cfg: OpenClawConfig = {
        channels: {
          telegram: {
            dmPolicy: "allowlist",
            allowFrom: ["10"],
            groupPolicy: "allowlist",
            groupAllowFrom: ["10"],
            reactionNotifications: "all",
          },
        },
      };
      const handler = registerHandler(cfg);
      const context = forumReactionContext({ isForum: false, chatType });
      await handler({
        ...context,
        messageReaction: { ...context.messageReaction, user: { id: 11, first_name: "Denied" } },
      });
      expect(processMessageWithReplyChain).not.toHaveBeenCalled();
      await handler({
        ...context,
        messageReaction: {
          ...context.messageReaction,
          old_reaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
          new_reaction: [
            { type: "emoji", emoji: FIRE_EMOJI },
            { type: "emoji", emoji: "\u{1F44D}" },
            { type: "emoji", emoji: "\u{1F389}" },
          ],
        },
      });
      expect(processMessageWithReplyChain).toHaveBeenCalledTimes(1);
      expect(firstDispatch().msg.text).toBe(
        "[Emoji reaction update: added \u{1F44D} \u{1F389} by Bob (@bob_user) on message 100]",
      );
      expect(firstDispatch().msg.from?.id).toBe(10);
      expect(firstDispatch().msg.chat.id).toBe(context.messageReaction.chat.id);
    },
  );

  it("keeps repeated reactions distinct by Telegram update ID", async () => {
    const handler = registerHandler(buildTelegramConfig());
    const context = forumReactionContext({ isForum: false, chatType: "private" });
    await handler(context);
    await handler({ ...context, update: { update_id: 901 } });
    expect(
      processMessageWithReplyChain.mock.calls.map(([call]) => call.options?.messageIdOverride),
    ).toEqual(["900", "901"]);
  });

  it("includes the reacting sender when the update ID is unavailable", async () => {
    const handler = registerHandler(buildTelegramConfig());
    const context = forumReactionContext({ isForum: false, chatType: "private" });
    await handler({ ...context, update: {} });
    expect(firstDispatch().options?.messageIdOverride).toBe("reaction:100:10");
  });

  it("keeps default own, off, and all notification modes distinct", async () => {
    const cfg: OpenClawConfig = {
      channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
    };
    const context = forumReactionContext({ isForum: false, chatType: "private" });
    await registerHandler(cfg, () => false)(context);
    expect(processMessageWithReplyChain).not.toHaveBeenCalled();
    await registerHandler(cfg, () => true)(context);
    expect(processMessageWithReplyChain).toHaveBeenCalledTimes(1);
    processMessageWithReplyChain.mockClear();
    cfg.channels!.telegram!.reactionNotifications = "off";
    await registerHandler(cfg, () => true)(context);
    expect(processMessageWithReplyChain).not.toHaveBeenCalled();
    cfg.channels!.telegram!.reactionNotifications = "all";
    await registerHandler(cfg, () => false)(context);
    expect(processMessageWithReplyChain).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch bot actors or unchanged reactions", async () => {
    const handler = registerHandler(buildTelegramConfig());
    const context = forumReactionContext({ isForum: false, chatType: "private" });
    await handler({
      ...context,
      messageReaction: {
        ...context.messageReaction,
        user: { id: 10, first_name: "Bot", is_bot: true },
      },
    });
    for (const newReaction of [[{ type: "emoji", emoji: FIRE_EMOJI }]]) {
      await handler(
        forumReactionContext({
          isForum: false,
          chatType: "private",
          oldReaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
          newReaction,
        }),
      );
    }
    expect(processMessageWithReplyChain).not.toHaveBeenCalled();
  });

  it.each([
    { name: "removal", newReaction: [], expected: "removed \u{1F525}" },
    {
      name: "swap",
      newReaction: [{ type: "emoji", emoji: "\u{1F44D}" }],
      expected: "added \u{1F44D}; removed \u{1F525}",
    },
  ])("dispatches a reaction $name as one agent turn", async ({ newReaction, expected }) => {
    await registerHandler(buildTelegramConfig())(
      forumReactionContext({
        isForum: false,
        chatType: "private",
        oldReaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        newReaction,
      }),
    );
    expect(processMessageWithReplyChain).toHaveBeenCalledTimes(1);
    expect(firstDispatch().msg.text).toBe(
      `[Emoji reaction update: ${expected} by Bob (@bob_user) on message 100]`,
    );
  });

  it.each([
    { scope: "forum" as const, isDirectMessages: false },
    { scope: "direct-messages" as const, isDirectMessages: true },
  ])(
    "dispatches recovered $scope topics with native topic metadata",
    async ({ scope, isDirectMessages }) => {
      resolveCachedMessageThreadSpec.mockResolvedValue({ scope, id: FORUM_TOPIC_ID });
      const handler = registerHandler(
        buildTelegramConfig({ topics: { [String(FORUM_TOPIC_ID)]: { enabled: true } } }),
      );
      await handler(forumReactionContext({ isForum: !isDirectMessages, isDirectMessages }));
      expect(processMessageWithReplyChain).toHaveBeenCalledTimes(1);
      expect(firstDispatch().options?.threadSpec).toEqual({ scope, id: FORUM_TOPIC_ID });
      if (isDirectMessages) {
        expect(firstDispatch().msg.direct_messages_topic).toEqual({ topic_id: FORUM_TOPIC_ID });
        expect(firstDispatch().msg.message_thread_id).toBeUndefined();
        expect(firstDispatch().msg.is_topic_message).toBeUndefined();
      } else {
        expect(firstDispatch().msg.message_thread_id).toBe(FORUM_TOPIC_ID);
        expect(firstDispatch().msg.is_topic_message).toBe(true);
      }
    },
  );

  it("applies the recovered topic's disabled config instead of the General topic's", async () => {
    resolveCachedMessageThreadSpec.mockResolvedValue({ scope: "forum", id: FORUM_TOPIC_ID });
    const handler = registerHandler(
      buildTelegramConfig({
        topics: { "1": { enabled: true }, [String(FORUM_TOPIC_ID)]: { enabled: false } },
      }),
    );
    await handler(forumReactionContext());
    expect(processMessageWithReplyChain).not.toHaveBeenCalled();
  });

  it("drops a forum reaction with an unknown topic instead of guessing General", async () => {
    const handler = registerHandler(buildTelegramConfig({ topics: { "1": { enabled: true } } }));
    await handler(forumReactionContext());
    expect(processMessageWithReplyChain).not.toHaveBeenCalled();
    expect(runtimeLog).toHaveBeenCalledTimes(1);
    const logged = String(runtimeLog.mock.calls[0]?.[0] ?? "");
    expect(logged).toContain("thread-context-unavailable");
    expect(logged).toContain(`chat=${FORUM_CHAT_ID}`);
    expect(logged).toContain(`message=${REACTED_MESSAGE_ID}`);
    expect(logged).not.toContain("bob_user");
    expect(logged).not.toContain(FIRE_EMOJI);
  });

  it.each([
    { name: "cache miss", recovered: undefined },
    { name: "scope mismatch", recovered: { scope: "forum" as const, id: FORUM_TOPIC_ID } },
  ])("drops a channel Direct Messages reaction on $name", async ({ recovered }) => {
    resolveCachedMessageThreadSpec.mockResolvedValue(recovered);
    const handler = registerHandler(buildTelegramConfig());
    await handler(forumReactionContext({ isForum: false, isDirectMessages: true }));
    expect(processMessageWithReplyChain).not.toHaveBeenCalled();
    expect(runtimeLog).toHaveBeenCalledTimes(1);
    expect(String(runtimeLog.mock.calls[0]?.[0])).toContain("thread-context-unavailable");
  });

  it.each([false, true])(
    "awaits own-message lookup before reaction delivery: %s",
    async (sentByBot) => {
      const lookup = createDeferred<boolean>();
      const cfg = buildTelegramConfig({ reactionNotifications: "own" });
      const handler = registerHandler(cfg, () => lookup.promise);
      const delivery = handler(forumReactionContext({ isForum: false }));
      try {
        await Promise.resolve();
        expect(processMessageWithReplyChain).not.toHaveBeenCalled();
      } finally {
        lookup.resolve(sentByBot);
        await delivery;
      }
      expect(processMessageWithReplyChain).toHaveBeenCalledTimes(sentByBot ? 1 : 0);
    },
  );
});
