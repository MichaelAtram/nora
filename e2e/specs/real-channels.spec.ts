// Real-credential channel tests: configure OpenClaw channel setup through the
// Nora API and verify the current OpenClaw catalog contract. OpenClaw channels
// do not expose Nora's legacy test-message/delete adapter routes.

import { expect, test } from "@playwright/test";
import { DEFAULT_PASSWORD, createUserSession, uniqueEmail, uniqueName } from "./support/app";
import {
  deployAgent,
  waitForAgentStatus,
  waitForOpenClawGateway,
  deleteAgent,
  saveProviderKey,
  getPlatformConfig,
  backendSupported,
  listAgentChannels,
  getChannelType,
  saveChannelSetup,
  testChannelAction,
  deleteChannelAction,
} from "./support/agents";
import { real } from "./support/realConfig";

const OPENCLAW_CHANNEL_IDS = [
  "bluebubbles",
  "discord",
  "feishu",
  "googlechat",
  "imessage",
  "irc",
  "line",
  "mattermost",
  "matrix",
  "msteams",
  "nextcloud-talk",
  "nostr",
  "qqbot",
  "signal",
  "slack",
  "synology-chat",
  "telegram",
  "tlon",
  "twitch",
  "whatsapp",
  "yuanbao",
  "zalo",
  "zalouser",
];

function payloadChannels(payload: Record<string, unknown>) {
  return Array.isArray(payload.channels) ? (payload.channels as Record<string, unknown>[]) : [];
}

function channelByType(payload: Record<string, unknown>, type: string) {
  return payloadChannels(payload).find((channel) => channel.type === type || channel.id === type);
}

function fieldKeys(metadata: Record<string, unknown>) {
  return Array.isArray(metadata.configFields)
    ? metadata.configFields.map((field) => String((field as Record<string, unknown>).key || ""))
    : [];
}

function actionErrorText(result: { body: Record<string, unknown> }) {
  return String(result.body.error || result.body.message || "");
}

test.describe("Channels — OpenClaw real runtime", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(real.provisionTimeoutMs + 300000);

  /** @type {{email: string, password: string, token: string} | null} */
  let operator = null;
  /** @type {any} */
  let agent = null;

  test.beforeAll(async ({ request }) => {
    test.setTimeout(real.provisionTimeoutMs + 300000);
    test.skip(!real.llmApiKey, "REAL_LLM_API_KEY (or provider-specific key) not set");
    test.skip(
      !real.enableOpenclawDocker,
      "OpenClaw+Docker cell disabled; channels spec needs a host agent",
    );

    operator = await createUserSession(request, {
      email: uniqueEmail("nora-real-channels"),
      password: DEFAULT_PASSWORD,
    });
    await saveProviderKey(request, operator.token, {
      provider: real.llmProviderId,
      apiKey: real.llmApiKey,
      model: real.llmModel || undefined,
    });

    const platform = await getPlatformConfig(request, operator.token);
    test.skip(!backendSupported(platform, "docker"), "Docker backend not enabled");

    agent = await deployAgent(request, operator.token, {
      name: uniqueName("real-channels-host"),
      runtimeFamily: "openclaw",
      backend: "docker",
      sandboxProfile: "standard",
    });
    agent = await waitForAgentStatus(request, operator.token, agent.id, ["running", "warning"], {
      timeoutMs: real.provisionTimeoutMs,
    });
    await waitForOpenClawGateway(request, operator.token, agent.id, {
      timeoutMs: real.provisionTimeoutMs,
    });
  });

  test.afterAll(async ({ request }) => {
    if (agent?.id) {
      await deleteAgent(request, operator.token, agent.id);
    }
  });

  test("[C0] catalog exposes all built-in OpenClaw channel metadata", async ({ request }) => {
    const payload = await listAgentChannels(request, operator.token, agent.id);
    expect(payload.runtime).toBe("openclaw");
    expect(payload.capabilities?.supportsTesting).toBe(false);
    expect(payload.capabilities?.supportsMessageHistory).toBe(false);
    expect(payload.capabilities?.supportsLazyTypeDefinitions).toBe(true);

    const ids = new Set(
      payloadChannels(payload).map((channel) => String(channel.type || channel.id)),
    );
    for (const id of OPENCLAW_CHANNEL_IDS) {
      expect(ids.has(id), `${id} should be listed in the OpenClaw catalog`).toBe(true);
    }

    const metadata = await Promise.all(
      OPENCLAW_CHANNEL_IDS.map((id) => getChannelType(request, operator.token, agent.id, id)),
    );

    for (const entry of metadata) {
      expect(entry.type).toBeTruthy();
      expect(Array.isArray(entry.configFields), `${entry.type} configFields`).toBe(true);
      expect(entry.hasComplexFields, `${entry.type} should use docs-backed metadata`).toBe(false);
    }

    const whatsapp = metadata.find((entry) => entry.type === "whatsapp");
    expect(whatsapp?.actions?.canQrLogin).toBe(true);
    expect(whatsapp?.actions?.loginKind).toBe("web");
    expect(fieldKeys(whatsapp || {})).toEqual([]);

    const feishu = metadata.find((entry) => entry.type === "feishu");
    expect(feishu?.actions?.canQrLogin).toBe(true);
    expect(feishu?.actions?.loginKind).toBe("cli");

    const telegram = metadata.find((entry) => entry.type === "telegram");
    expect(fieldKeys(telegram || {})).toEqual(expect.arrayContaining(["botToken"]));

    const slack = metadata.find((entry) => entry.type === "slack");
    expect(fieldKeys(slack || {})).toEqual(
      expect.arrayContaining(["mode", "botToken", "appToken", "signingSecret", "webhookPath"]),
    );

    const discord = metadata.find((entry) => entry.type === "discord");
    expect(fieldKeys(discord || {})).toEqual(expect.arrayContaining(["token", "applicationId"]));
  });

  test("[C1] Telegram — real bot token saves through OpenClaw setup", async ({ request }) => {
    test.skip(!real.telegramBotToken, "REAL_TELEGRAM_BOT_TOKEN not set");

    const result = await saveChannelSetup(request, operator.token, agent.id, {
      type: "telegram",
      config: { botToken: real.telegramBotToken },
      enabled: true,
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(result.channel).toBe("telegram");

    const payload = await listAgentChannels(request, operator.token, agent.id);
    const telegram = channelByType(payload, "telegram");
    expect(telegram?.configured).toBe(true);
    expect(telegram?.enabled).toBe(true);
  });

  test("[C2] Discord — real bot config saves through OpenClaw setup", async ({ request }) => {
    test.skip(
      !real.openclawDiscordConfig,
      "REAL_OPENCLAW_DISCORD_CONFIG_JSON not set; legacy webhook URLs are not accepted by OpenClaw Discord",
    );

    const result = await saveChannelSetup(request, operator.token, agent.id, {
      type: "discord",
      config: real.openclawDiscordConfig,
      enabled: true,
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(result.channel).toBe("discord");

    const payload = await listAgentChannels(request, operator.token, agent.id);
    const discord = channelByType(payload, "discord");
    expect(discord?.configured).toBe(true);
    expect(discord?.enabled).toBe(true);
  });

  test("[C3] OpenClaw rejects legacy test and delete channel actions", async ({ request }) => {
    const testResult = await testChannelAction(request, operator.token, agent.id, "whatsapp");
    expect(testResult.status).toBe(409);
    expect(actionErrorText(testResult)).toMatch(/OpenClaw.*test|test.*OpenClaw/i);

    const deleteResult = await deleteChannelAction(request, operator.token, agent.id, "whatsapp");
    expect(deleteResult.status).toBe(409);
    expect(actionErrorText(deleteResult)).toMatch(/OpenClaw.*delete|Disable instead/i);
  });
});
