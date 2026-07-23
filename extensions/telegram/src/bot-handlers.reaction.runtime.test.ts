// Telegram tests cover reaction dispatch and topic recovery before authorization.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { getChildLogger } from "openclaw/plugin-sdk/runtime-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultTelegramBotDeps } from "./bot-deps.js";
import { createTelegramEventBindings } from "./bot-handlers.event-bindings.js";
import { createTelegramHandlerAuthorization } from "./bot-handlers.inbound-authorization.js";
import { createTelegramMessagePipeline } from "./bot-handlers.message-pipeline.js";
import type { RegisterTelegramHandlerParams } from "./bot-handlers.types.js";
import type { TelegramThreadSpec } from "./bot/helpers.js";

const FIRE_EMOJI = "\u{1F525}";
const FORUM_CHAT_ID = 5678;
const FORUM_TOPIC_ID = 77;
const REACTED_MESSAGE_ID = 100;

type ReactionHandler = (ctx: Record<string, unknown>) => Promise<void>;

const processMessage = vi.fn<RegisterTelegramHandlerParams["processMessage"]>(async () => ({
  kind: "completed",
}));
const runtimeLog = vi.fn();
const runtimeError = vi.fn();
const resolveCachedMessageThreadSpec = vi.fn<
  (params: {
    chatId: number | string;
    messageId: number | string;
  }) => Promise<TelegramThreadSpec | undefined>
>(async () => undefined);

function buildTelegramConfig(overrides?: {
  topics?: Record<string, { enabled?: boolean; agentId?: string }>;
}): OpenClawConfig {
  return {
    channels: {
      telegram: {
        dmPolicy: "open",
        allowFrom: ["*"],
        reactionNotifications: "all",
        groupPolicy: "open",
        groups: {
          [String(FORUM_CHAT_ID)]: {
            enabled: true,
            ...(overrides?.topics ? { topics: overrides.topics } : {}),
          },
        },
      },
    },
  } as OpenClawConfig;
}

/**
 * Registers the real reaction handler against the real authorization runtime so
 * the test proves topic-scoped config lookup, not just the handler's own branch.
 */
function registerHandler(cfg: OpenClawConfig): ReactionHandler {
  const handlers = new Map<string, ReactionHandler>();
  const params: RegisterTelegramHandlerParams = {
    accountId: "default",
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
    ) => {
      const groups = (
        config.channels?.telegram as
          | {
              groups?: Record<
                string,
                {
                  enabled?: boolean;
                  topics?: Record<string, { enabled?: boolean; agentId?: string }>;
                }
              >;
            }
          | undefined
      )?.groups;
      const groupConfig = groups?.[String(chatId)];
      return {
        groupConfig,
        topicConfig:
          messageThreadId === undefined
            ? undefined
            : groupConfig?.topics?.[String(messageThreadId)],
      };
    },
    processMessage,
    telegramDeps: {
      ...defaultTelegramBotDeps,
      getRuntimeConfig: () => cfg,
      wasSentByBot: () => true,
      readChannelAllowFromStore: async () => [],
    },
  };

  createTelegramEventBindings({
    params,
    message: {
      ...createTelegramMessagePipeline(params),
      resolveCachedMessageThreadSpec,
    },
    authorization: createTelegramHandlerAuthorization(params),
    registerMessages: () => {},
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
    me: { id: 99, first_name: "OpenClaw", is_bot: true },
    getFile: async () => ({ download: async () => new Uint8Array() }),
    messageReaction: {
      chat: {
        id: FORUM_CHAT_ID,
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

describe("registerTelegramReactionHandler forum topic recovery", () => {
  beforeEach(() => {
    processMessage.mockClear();
    runtimeLog.mockClear();
    runtimeError.mockClear();
    resolveCachedMessageThreadSpec.mockReset();
    resolveCachedMessageThreadSpec.mockResolvedValue(undefined);
  });

  it("recovers the cached topic before dispatch and retains it on the synthetic message", async () => {
    resolveCachedMessageThreadSpec.mockResolvedValue({ scope: "forum", id: FORUM_TOPIC_ID });
    const handler = registerHandler(
      buildTelegramConfig({ topics: { [String(FORUM_TOPIC_ID)]: { enabled: true } } }),
    );

    await handler(forumReactionContext());

    expect(resolveCachedMessageThreadSpec).toHaveBeenCalledWith({
      chatId: FORUM_CHAT_ID,
      messageId: REACTED_MESSAGE_ID,
    });
    expect(processMessage).toHaveBeenCalledTimes(1);
    const dispatchedMessage = processMessage.mock.calls[0]?.[0].ctx.message;
    expect(dispatchedMessage?.message_thread_id).toBe(FORUM_TOPIC_ID);
    expect(dispatchedMessage?.is_topic_message).toBe(true);
    expect(dispatchedMessage?.text).toContain(`added ${FIRE_EMOJI}`);
    expect(dispatchedMessage?.text).toContain("by Bob (@bob_user) on message 100");
    expect(processMessage.mock.calls[0]?.[0].options).toMatchObject({
      forceWasMentioned: true,
      messageIdOverride: "900",
    });
  });

  it("applies the recovered topic's disabled config instead of the General topic's", async () => {
    resolveCachedMessageThreadSpec.mockResolvedValue({ scope: "forum", id: FORUM_TOPIC_ID });
    const handler = registerHandler(
      buildTelegramConfig({
        topics: { "1": { enabled: true }, [String(FORUM_TOPIC_ID)]: { enabled: false } },
      }),
    );

    await handler(forumReactionContext());

    expect(processMessage).not.toHaveBeenCalled();
  });

  it("drops a forum reaction with an unknown topic instead of guessing General", async () => {
    resolveCachedMessageThreadSpec.mockResolvedValue(undefined);
    const handler = registerHandler(buildTelegramConfig({ topics: { "1": { enabled: true } } }));

    await handler(forumReactionContext());

    expect(processMessage).not.toHaveBeenCalled();
    expect(runtimeLog).toHaveBeenCalledTimes(1);
    const logged = String(runtimeLog.mock.calls[0]?.[0] ?? "");
    expect(logged).toContain("thread-context-unavailable");
    expect(logged).toContain(`chat=${FORUM_CHAT_ID}`);
    expect(logged).toContain(`message=${REACTED_MESSAGE_ID}`);
    // Bounded degradation: route ids only, never message content or display names.
    expect(logged).not.toContain("bob_user");
    expect(logged).not.toContain(FIRE_EMOJI);
  });

  it("dispatches channel Direct Messages reactions through their recovered topic", async () => {
    resolveCachedMessageThreadSpec.mockResolvedValue({
      scope: "direct-messages",
      id: FORUM_TOPIC_ID,
    });
    const handler = registerHandler(
      buildTelegramConfig({
        topics: { [String(FORUM_TOPIC_ID)]: { enabled: true, agentId: "direct-topic-agent" } },
      }),
    );

    await handler(forumReactionContext({ isForum: false, isDirectMessages: true }));

    expect(processMessage).toHaveBeenCalledTimes(1);
    expect(processMessage.mock.calls[0]?.[0].ctx.message?.direct_messages_topic?.topic_id).toBe(
      FORUM_TOPIC_ID,
    );
  });

  it.each([
    { name: "cache miss", recovered: undefined },
    { name: "scope mismatch", recovered: { scope: "forum" as const, id: FORUM_TOPIC_ID } },
  ])("drops a channel Direct Messages reaction on $name", async ({ recovered }) => {
    resolveCachedMessageThreadSpec.mockResolvedValue(recovered);
    const handler = registerHandler(buildTelegramConfig());

    await handler(forumReactionContext({ isForum: false, isDirectMessages: true }));

    expect(processMessage).not.toHaveBeenCalled();
    expect(runtimeLog).toHaveBeenCalledTimes(1);
    expect(String(runtimeLog.mock.calls[0]?.[0])).toContain("thread-context-unavailable");
  });

  it("never consults the message cache for non-forum groups", async () => {
    const handler = registerHandler(buildTelegramConfig());

    await handler(forumReactionContext({ isForum: false }));

    expect(resolveCachedMessageThreadSpec).not.toHaveBeenCalled();
    expect(processMessage).toHaveBeenCalledTimes(1);
    expect(processMessage.mock.calls[0]?.[0].ctx.message?.message_thread_id).toBeUndefined();
  });

  it("never consults the message cache for direct chats", async () => {
    const handler = registerHandler(buildTelegramConfig());

    await handler(forumReactionContext({ isForum: false, chatType: "private" }));

    expect(resolveCachedMessageThreadSpec).not.toHaveBeenCalled();
    expect(processMessage).toHaveBeenCalledTimes(1);
    expect(processMessage.mock.calls[0]?.[0].ctx.message?.message_thread_id).toBeUndefined();
  });

  it("dispatches a removal-only reaction update", async () => {
    resolveCachedMessageThreadSpec.mockResolvedValue({ scope: "forum", id: FORUM_TOPIC_ID });
    const handler = registerHandler(
      buildTelegramConfig({ topics: { [String(FORUM_TOPIC_ID)]: { enabled: true } } }),
    );

    await handler(
      forumReactionContext({
        oldReaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        newReaction: [],
      }),
    );

    expect(resolveCachedMessageThreadSpec).toHaveBeenCalledTimes(1);
    expect(processMessage).toHaveBeenCalledTimes(1);
    expect(processMessage.mock.calls[0]?.[0].ctx.message?.text).toContain(`removed ${FIRE_EMOJI}`);
    expect(runtimeLog).not.toHaveBeenCalled();
  });

  it("skips unchanged emoji reactions before topic recovery", async () => {
    const handler = registerHandler(buildTelegramConfig());

    await handler(
      forumReactionContext({
        oldReaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        newReaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
      }),
    );

    expect(resolveCachedMessageThreadSpec).not.toHaveBeenCalled();
    expect(processMessage).not.toHaveBeenCalled();
  });

  it("combines added and removed emojis into one agent turn", async () => {
    const handler = registerHandler(buildTelegramConfig());

    await handler(
      forumReactionContext({
        isForum: false,
        chatType: "private",
        oldReaction: [{ type: "emoji", emoji: "\u{1F44D}" }],
        newReaction: [
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: "\u{1F389}" },
        ],
      }),
    );

    expect(processMessage).toHaveBeenCalledTimes(1);
    const text = processMessage.mock.calls[0]?.[0].ctx.message?.text;
    expect(text).toContain(`added ${FIRE_EMOJI} \u{1F389}`);
    expect(text).toContain("removed \u{1F44D}");
  });
});
