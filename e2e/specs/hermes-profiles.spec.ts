// Real-credential smoke for Hermes multi-profile support: create a named
// profile, scope a Telegram channel to it, confirm the default profile does
// NOT see that channel (isolation), then delete the profile. Runs against a
// real, deployed local-Docker Hermes agent — gated behind
// REAL_ENABLE_HERMES_DOCKER exactly like the hermes-docker cell in
// real-deploy-matrix.spec.ts (see e2e/REAL_TESTS.md).
//
// The profile/channel REST surface (backend-api/routes/agents.ts
// `hermes-ui/profiles` and `hermes-ui/channels`) has no dedicated e2e helper
// yet, so this spec issues requests directly via the same `apiJson` mechanism
// the sibling real-deploy specs use for arbitrary API calls.

import { expect, test, type APIRequestContext } from "@playwright/test";
import {
  DEFAULT_PASSWORD,
  apiJson,
  createUserSession,
  ensureUserSession,
  getCurrentUser,
  uniqueEmail,
  uniqueName,
} from "./support/app";
import {
  deployAgent,
  getAgent,
  waitForAgentStatus,
  deleteAgent,
  saveProviderKey,
  setProviderDefault,
} from "./support/agents";
import { real } from "./support/realConfig";

type HermesProfile = {
  name: string;
  displayName?: string;
  isDefault?: boolean;
  running?: boolean;
  [key: string]: unknown;
};

type HermesProfilesPayload = {
  profiles: HermesProfile[];
  [key: string]: unknown;
};

type HermesChannel = {
  type?: string;
  configured?: boolean;
  [key: string]: unknown;
};

type HermesChannelsPayload = {
  channels: HermesChannel[];
  [key: string]: unknown;
};

const PROFILE_NAME = "smoke";

function hermesProfilesPath(agentId: string) {
  return `/api/agents/${agentId}/hermes-ui/profiles`;
}

function hermesChannelsPath(agentId: string, profile: string) {
  return `/api/agents/${agentId}/hermes-ui/channels?profile=${encodeURIComponent(profile)}`;
}

async function waitForHermesUiReady(
  request: APIRequestContext,
  token: string,
  agentId: string,
  timeoutMs: number,
) {
  // The container flips to `running` as soon as it starts, but the Hermes
  // WebUI control surface inside it (which the hermes-ui/* routes proxy to)
  // can take a while longer to come up on a fresh image pull. Poll the
  // profiles endpoint — the cheapest hermes-ui route — until it stops 5xx/404ing.
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    const { response } = await apiJson(request, hermesProfilesPath(agentId), {
      token,
      failOnStatus: false,
    });
    lastStatus = response.status();
    if (lastStatus < 400) return;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(
    `Hermes WebUI never became ready within ${Math.round(timeoutMs / 1000)}s; last status: ${lastStatus}`,
  );
}

async function cleanupSmokeProfile(
  request: APIRequestContext,
  token: string,
  agentId: string,
) {
  // Best-effort — a prior step may have already deleted it, or never
  // gotten far enough to create it.
  await apiJson(request, `${hermesProfilesPath(agentId)}/${PROFILE_NAME}`, {
    method: "DELETE",
    token,
    failOnStatus: false,
  });
}

async function destroyAgentAndVerify(request: APIRequestContext, token: string, agentId: string) {
  const { response: deleteResponse, body: deleteBody } = await deleteAgent(request, token, agentId);
  if (!deleteResponse.ok() && deleteResponse.status() !== 404) {
    throw new Error(
      `Failed to destroy hermes-profiles smoke agent ${agentId}: ${deleteResponse.status()} ${JSON.stringify(
        deleteBody,
      )}`,
    );
  }
}

test.describe("Hermes multi-profile smoke (real credentials)", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(real.provisionTimeoutMs + 300000);

  /** @type {{email: string, password: string, token: string} | null} */
  let operator: { email: string; password: string; token: string } | null = null;
  /** @type {{id: string, status?: string, [key: string]: unknown} | null} */
  let agent: { id: string; status?: string; [key: string]: unknown } | null = null;

  test.beforeAll(async ({ request }) => {
    test.skip(!real.enableHermesDocker, "REAL_ENABLE_HERMES_DOCKER not set (set to 1 to run)");
    test.skip(
      !real.llmApiKey,
      "REAL_LLM_API_KEY (or provider-specific real key) not set — required to deploy a standard-profile Hermes agent",
    );
    test.skip(!real.telegramBotToken, "REAL_TELEGRAM_BOT_TOKEN not set");

    operator = real.operatorEmail
      ? await ensureUserSession(request, {
          email: real.operatorEmail,
          password: real.operatorPassword || DEFAULT_PASSWORD,
        })
      : await createUserSession(request, {
          email: uniqueEmail("nora-hermes-profiles"),
          password: DEFAULT_PASSWORD,
        });
    await getCurrentUser(request, operator.token);

    const provider = await saveProviderKey(request, operator.token, {
      provider: real.llmProviderId,
      apiKey: real.llmApiKey!,
      model: real.llmModel || undefined,
    });
    if (provider?.id) {
      await setProviderDefault(request, operator.token, provider.id);
    }
  });

  test.afterAll(async ({ request }, testInfo) => {
    testInfo.setTimeout(180000);
    if (!agent?.id || !operator?.token) return;
    await cleanupSmokeProfile(request, operator.token, agent.id);
    await destroyAgentAndVerify(request, operator.token, agent.id);
    agent = null;
  });

  test("deploy a local-Docker Hermes agent and reach hermes-ui readiness", async ({ request }) => {
    test.setTimeout(real.provisionTimeoutMs + 60000);

    const deployed = await deployAgent(request, operator!.token, {
      name: uniqueName("hermes-profiles-smoke"),
      runtimeFamily: "hermes",
      backend: "docker",
      sandboxProfile: "standard",
      vcpu: 1,
      ramMb: 1024,
      diskGb: 5,
    });
    expect(deployed?.id).toBeTruthy();
    expect(deployed?.status).toBe("queued");

    const running = await waitForAgentStatus(
      request,
      operator!.token,
      deployed.id,
      ["running", "warning"],
      { timeoutMs: real.provisionTimeoutMs },
    );
    agent = running as { id: string; status?: string; [key: string]: unknown };
    expect(["running", "warning"]).toContain(agent.status);

    await waitForHermesUiReady(request, operator!.token, agent.id, real.provisionTimeoutMs);
  });

  test("POST hermes-ui/profiles creates the smoke profile", async ({ request }) => {
    test.skip(!agent, "no agent from deploy step");

    const { response, body } = await apiJson<{ profile?: HermesProfile }>(
      request,
      hermesProfilesPath(agent!.id),
      {
        method: "POST",
        token: operator!.token,
        data: { name: PROFILE_NAME },
        failOnStatus: false,
      },
    );

    expect(response.status(), JSON.stringify(body)).toBe(200);
    expect(body && typeof body === "object" ? (body as { profile?: HermesProfile }).profile?.name : undefined).toBe(
      PROFILE_NAME,
    );
  });

  test("GET hermes-ui/profiles lists both default and smoke, default.isDefault === true", async ({
    request,
  }) => {
    test.skip(!agent, "no agent from deploy step");

    const { response, body } = await apiJson<HermesProfilesPayload>(request, hermesProfilesPath(agent!.id), {
      token: operator!.token,
    });

    expect(response.ok()).toBe(true);
    const profiles = Array.isArray((body as HermesProfilesPayload)?.profiles)
      ? (body as HermesProfilesPayload).profiles
      : [];
    const byName = Object.fromEntries(profiles.map((p) => [p.name, p]));

    expect(byName.default, `expected a "default" profile, got: ${JSON.stringify(profiles)}`).toBeTruthy();
    expect(byName.default.isDefault).toBe(true);
    expect(byName[PROFILE_NAME], `expected a "${PROFILE_NAME}" profile, got: ${JSON.stringify(profiles)}`).toBeTruthy();
  });

  test("POST hermes-ui/channels?profile=smoke configures a Telegram channel", async ({ request }) => {
    test.skip(!agent, "no agent from deploy step");

    const { response, body } = await apiJson<{ channel?: HermesChannel }>(
      request,
      hermesChannelsPath(agent!.id, PROFILE_NAME),
      {
        method: "POST",
        token: operator!.token,
        data: {
          type: "telegram",
          config: { TELEGRAM_BOT_TOKEN: real.telegramBotToken },
        },
        failOnStatus: false,
      },
    );

    expect(response.status(), JSON.stringify(body)).toBe(200);
    const channel = (body as { channel?: HermesChannel })?.channel;
    expect(channel?.type).toBe("telegram");
    expect(channel?.configured).toBe(true);
  });

  test("channel is visible scoped to smoke but absent scoped to default (isolation)", async ({ request }) => {
    test.skip(!agent, "no agent from deploy step");

    const { body: smokeBody } = await apiJson<HermesChannelsPayload>(
      request,
      hermesChannelsPath(agent!.id, PROFILE_NAME),
      { token: operator!.token },
    );
    const smokeChannels = Array.isArray((smokeBody as HermesChannelsPayload)?.channels)
      ? (smokeBody as HermesChannelsPayload).channels
      : [];
    const smokeTelegram = smokeChannels.find((c) => c.type === "telegram");
    expect(
      smokeTelegram?.configured,
      `expected a configured telegram channel in profile "${PROFILE_NAME}", got: ${JSON.stringify(smokeChannels)}`,
    ).toBe(true);

    const { body: defaultBody } = await apiJson<HermesChannelsPayload>(
      request,
      hermesChannelsPath(agent!.id, "default"),
      { token: operator!.token },
    );
    const defaultChannels = Array.isArray((defaultBody as HermesChannelsPayload)?.channels)
      ? (defaultBody as HermesChannelsPayload).channels
      : [];
    const defaultTelegram = defaultChannels.find((c) => c.type === "telegram");
    expect(
      defaultTelegram?.configured ?? false,
      `expected NO configured telegram channel in the "default" profile (isolation breach), got: ${JSON.stringify(defaultChannels)}`,
    ).toBe(false);
  });

  test("DELETE hermes-ui/profiles/smoke removes it from the profile list", async ({ request }) => {
    test.skip(!agent, "no agent from deploy step");

    const { response, body } = await apiJson<HermesProfilesPayload>(
      request,
      `${hermesProfilesPath(agent!.id)}/${PROFILE_NAME}`,
      { method: "DELETE", token: operator!.token, failOnStatus: false },
    );

    expect(response.status(), JSON.stringify(body)).toBe(200);
    const profiles = Array.isArray((body as HermesProfilesPayload)?.profiles)
      ? (body as HermesProfilesPayload).profiles
      : [];
    expect(profiles.some((p) => p.name === PROFILE_NAME)).toBe(false);
  });
});
