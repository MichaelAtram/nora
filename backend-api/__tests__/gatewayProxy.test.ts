// @ts-nocheck
const express = require("express");
const request = require("supertest");
const { EventEmitter } = require("events");

const mockDb = { query: jest.fn() };
const mockRecordMetric = jest.fn().mockResolvedValue();
const mockRecordTokenUsage = jest.fn().mockResolvedValue();
const mockGetIntegrationsForSync = jest.fn();
const mockBuildIntegrationToolCatalogEntries = jest.fn();

class mockFakeWebSocket extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.readyState = mockFakeWebSocket.OPEN;
    mockFakeWebSocket.instances.push(this);
    setImmediate(() => {
      if (this.readyState !== mockFakeWebSocket.OPEN) return;
      this.emit(
        "message",
        Buffer.from(
          JSON.stringify({
            type: "event",
            event: "connect.challenge",
            payload: { nonce: "nonce-1" },
          }),
        ),
      );
    });
  }

  send(payload) {
    const msg = JSON.parse(payload);
    if (msg.method === "connect") {
      mockFakeWebSocket.connectParams.push(msg.params);
      return setImmediate(() => {
        this.emit(
          "message",
          Buffer.from(
            JSON.stringify({
              id: "__connect__",
              ok: true,
              result: { connected: true },
            }),
          ),
        );
      });
    }

    if (msg.method === "health") {
      if (mockFakeWebSocket.healthMode === "error") {
        return setImmediate(() => {
          this.emit(
            "message",
            Buffer.from(
              JSON.stringify({
                id: msg.id,
                ok: false,
                error: { message: "health failed" },
              }),
            ),
          );
        });
      }
      return setImmediate(() => {
        this.emit(
          "message",
          Buffer.from(
            JSON.stringify({
              id: msg.id,
              ok: true,
              result: { status: "ok" },
            }),
          ),
        );
      });
    }

    if (msg.method === "status") {
      if (mockFakeWebSocket.statusMode === "error") {
        return setImmediate(() => {
          this.emit(
            "message",
            Buffer.from(
              JSON.stringify({
                id: msg.id,
                ok: false,
                error: { message: "status failed" },
              }),
            ),
          );
        });
      }
      return setImmediate(() => {
        this.emit(
          "message",
          Buffer.from(
            JSON.stringify({
              id: msg.id,
              ok: true,
              result: { state: "idle" },
            }),
          ),
        );
      });
    }

    if (msg.method === "sessions.messages.subscribe") {
      mockFakeWebSocket.sessionMessageSubscriptions.push(msg.params);
      mockFakeWebSocket.onSessionMessageSubscribe?.(msg.params);
      if (mockFakeWebSocket.subscriptionMode === "timeout") return;
      const canonicalKey = mockFakeWebSocket.canonicalizeSessionKey(msg.params.key);
      const registryKey = mockFakeWebSocket.sessionMessageSubscriptionRegistryKey(msg.params);
      const respondToSubscription = () => {
        if (mockFakeWebSocket.subscriptionMode !== "error") {
          mockFakeWebSocket.sessionMessageSubscriptionRegistry.add(registryKey);
        }
        this.emit(
          "message",
          Buffer.from(
            JSON.stringify({
              id: msg.id,
              ok: mockFakeWebSocket.subscriptionMode !== "error",
              ...(mockFakeWebSocket.subscriptionMode === "error"
                ? { error: { message: "unknown method: sessions.messages.subscribe" } }
                : { result: { subscribed: true, key: canonicalKey } }),
            }),
          ),
        );
      };
      if (Number(mockFakeWebSocket.subscriptionDelayMs) > 0) {
        return setTimeout(respondToSubscription, Number(mockFakeWebSocket.subscriptionDelayMs));
      }
      return setImmediate(respondToSubscription);
    }

    if (msg.method === "sessions.messages.unsubscribe") {
      mockFakeWebSocket.sessionMessageUnsubscriptions.push(msg.params);
      const canonicalKey = mockFakeWebSocket.canonicalizeSessionKey(msg.params.key);
      const registryKey = mockFakeWebSocket.sessionMessageSubscriptionRegistryKey(msg.params);
      mockFakeWebSocket.sessionMessageSubscriptionRegistry.delete(registryKey);
      return setImmediate(() => {
        this.emit(
          "message",
          Buffer.from(
            JSON.stringify({
              id: msg.id,
              ok: true,
              result: { subscribed: false, key: canonicalKey },
            }),
          ),
        );
      });
    }

    if (msg.method === "chat.send") {
      mockFakeWebSocket.chatSendRequests.push(msg.params);
      const chatResponse = mockFakeWebSocket.chatResponses.shift() || {};
      const streamMode = chatResponse.streamMode ?? mockFakeWebSocket.streamMode;
      const chatRunId = Object.hasOwn(chatResponse, "runId")
        ? chatResponse.runId
        : mockFakeWebSocket.chatRunId;
      const streamEvents = chatResponse.streamEvents || mockFakeWebSocket.streamEvents;
      if (streamMode) {
        const emitWireEvent = (nextEvent) => {
          this.emit(
            "message",
            Buffer.from(
              JSON.stringify({
                type: "event",
                event: nextEvent.event || "chat",
                payload: nextEvent.payload,
              }),
            ),
          );
        };
        const acknowledgeChat = () => {
          for (const preAckEvent of chatResponse.preAckEvents || []) {
            emitWireEvent(preAckEvent);
          }
          const ok = chatResponse.ok !== false;
          const responseResult = Object.hasOwn(chatResponse, "result")
            ? chatResponse.result
            : { runId: chatRunId, status: "started" };
          this.emit(
            "message",
            Buffer.from(
              JSON.stringify({
                id: msg.id,
                ok,
                ...(ok
                  ? { result: responseResult }
                  : { error: chatResponse.error || { message: "chat.send rejected" } }),
              }),
            ),
          );
          const emitStreamEvent = (index) => {
            const nextEvent = streamEvents[index];
            if (!nextEvent) return;
            const emitEvent = () => {
              emitWireEvent(nextEvent);
              emitStreamEvent(index + 1);
            };
            if (Number(nextEvent.delayMs) > 0) {
              setTimeout(emitEvent, Number(nextEvent.delayMs));
            } else {
              setImmediate(emitEvent);
            }
          };
          emitStreamEvent(0);
        };
        if (Number(chatResponse.ackDelayMs) > 0) {
          return setTimeout(acknowledgeChat, Number(chatResponse.ackDelayMs));
        }
        return setImmediate(acknowledgeChat);
      }
      return setImmediate(() => {
        this.emit(
          "message",
          Buffer.from(
            JSON.stringify({
              id: msg.id,
              ok: true,
              result: {
                content: "pong",
                usage: { total_tokens: 42 },
              },
            }),
          ),
        );
      });
    }

    if (msg.method === "tools.catalog") {
      return setImmediate(() => {
        this.emit(
          "message",
          Buffer.from(
            JSON.stringify({
              id: msg.id,
              ok: true,
              result: mockFakeWebSocket.toolsCatalogResult || { tools: [] },
            }),
          ),
        );
      });
    }
  }

  close() {
    if (this.readyState === mockFakeWebSocket.CLOSED) return;
    this.readyState = mockFakeWebSocket.CLOSED;
    this.emit("close");
  }
}
mockFakeWebSocket.CONNECTING = 0;
mockFakeWebSocket.OPEN = 1;
mockFakeWebSocket.CLOSING = 2;
mockFakeWebSocket.CLOSED = 3;
mockFakeWebSocket.healthMode = "success";
mockFakeWebSocket.statusMode = "success";
mockFakeWebSocket.toolsCatalogResult = { tools: [] };
mockFakeWebSocket.connectParams = [];
mockFakeWebSocket.instances = [];
mockFakeWebSocket.streamMode = false;
mockFakeWebSocket.chatRunId = "run-1";
mockFakeWebSocket.subscriptionMode = "success";
mockFakeWebSocket.subscriptionDelayMs = 0;
mockFakeWebSocket.sessionMessageSubscriptions = [];
mockFakeWebSocket.sessionMessageUnsubscriptions = [];
mockFakeWebSocket.sessionMessageSubscriptionRegistry = new Set();
mockFakeWebSocket.canonicalizeSessionKey = (key) =>
  key === "main"
    ? "agent:main:main"
    : key === "global" || /^agent:[^:]+:global$/.test(key)
      ? "global"
      : key;
mockFakeWebSocket.sessionMessageSubscriptionRegistryKey = (params) => {
  const canonicalKey = mockFakeWebSocket.canonicalizeSessionKey(params.key);
  return canonicalKey === "global" ? `agent:${params.agentId || "main"}:global` : canonicalKey;
};
mockFakeWebSocket.onSessionMessageSubscribe = null;
mockFakeWebSocket.chatSendRequests = [];
mockFakeWebSocket.chatResponses = [];
mockFakeWebSocket.streamEvents = [];

class mockFakeWebSocketServer {
  on() {}
  handleUpgrade(req, socket, head, callback) {
    if (callback) callback(new EventEmitter());
  }
}

jest.mock("../db", () => mockDb);
jest.mock("../metrics", () => ({
  recordMetric: mockRecordMetric,
  recordTokenUsage: mockRecordTokenUsage,
}));
jest.mock("../integrations", () => ({
  getIntegrationsForSync: mockGetIntegrationsForSync,
  buildIntegrationToolCatalogEntries: mockBuildIntegrationToolCatalogEntries,
}));
jest.mock("ws", () => ({
  WebSocket: mockFakeWebSocket,
  WebSocketServer: mockFakeWebSocketServer,
}));

describe("gateway proxy control-plane routes", () => {
  let createGatewayRouter;
  let evictConnection;
  let app;
  const originalFetch = global.fetch;

  function buildApp(routerOptions = {}) {
    const nextApp = express();
    nextApp.use(express.json());
    nextApp.use((req, res, next) => {
      req.user = { id: "user-1" };
      next();
    });
    nextApp.use(createGatewayRouter(routerOptions));
    return nextApp;
  }

  function mockRunningAgent(overrides = {}) {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "agent-1",
          user_id: "user-1",
          status: "running",
          host: "10.0.0.10",
          gateway_token: "gateway-token",
          gateway_host_port: null,
          ...overrides,
        },
      ],
    });
  }

  function postStreamingChat(body = {}) {
    return request(app)
      .post("/agents/agent-1/gateway/chat")
      .buffer(true)
      .parse((stream, callback) => {
        let responseBody = "";
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => {
          responseBody += chunk;
        });
        stream.on("end", () => callback(null, responseBody));
      })
      .send({ message: "ping", stream: true, ...body });
  }

  function parseSsePayloads(body) {
    return String(body)
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice("data: ".length))
      .filter((data) => data !== "[DONE]")
      .map((data) => JSON.parse(data));
  }

  beforeEach(() => {
    jest.resetModules();
    mockDb.query.mockReset();
    mockRecordMetric.mockClear();
    mockRecordTokenUsage.mockClear();
    global.fetch = jest.fn();
    mockFakeWebSocket.healthMode = "success";
    mockFakeWebSocket.statusMode = "success";
    mockFakeWebSocket.toolsCatalogResult = { tools: [] };
    mockFakeWebSocket.connectParams = [];
    mockFakeWebSocket.instances = [];
    mockFakeWebSocket.streamMode = false;
    mockFakeWebSocket.chatRunId = "run-1";
    mockFakeWebSocket.subscriptionMode = "success";
    mockFakeWebSocket.subscriptionDelayMs = 0;
    mockFakeWebSocket.sessionMessageSubscriptions = [];
    mockFakeWebSocket.sessionMessageUnsubscriptions = [];
    mockFakeWebSocket.sessionMessageSubscriptionRegistry = new Set();
    mockFakeWebSocket.onSessionMessageSubscribe = null;
    mockFakeWebSocket.chatSendRequests = [];
    mockFakeWebSocket.chatResponses = [];
    mockFakeWebSocket.streamEvents = [
      {
        event: "chat",
        payload: {
          runId: "run-1",
          sessionKey: "main",
          seq: 1,
          state: "final",
          model: "openai/gpt-5.5",
          provider: "openai",
          message: { role: "assistant" },
          usage: {
            input_tokens: 1000,
            output_tokens: 500,
            total_tokens: 1500,
          },
        },
      },
    ];
    mockGetIntegrationsForSync.mockReset();
    mockBuildIntegrationToolCatalogEntries.mockReset();

    ({ createGatewayRouter, evictConnection } = require("../gatewayProxy"));

    app = buildApp();
  });

  afterEach(() => {
    evictConnection("10.0.0.10");
    evictConnection("10.0.0.20");
    evictConnection("10.0.0.30");
    global.fetch = originalFetch;
  });

  it("sends non-streaming chat through the gateway and records usage metrics", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "agent-1",
          user_id: "user-1",
          status: "running",
          host: "10.0.0.10",
          gateway_token: "gateway-token",
          gateway_host_port: null,
        },
      ],
    });

    const res = await request(app).post("/agents/agent-1/gateway/chat").send({ message: "ping" });

    expect(res.status).toBe(200);
    expect(res.body.content).toBe("pong");
    expect(mockFakeWebSocket.connectParams[0]).toEqual(
      expect.objectContaining({
        minProtocol: 3,
        maxProtocol: 4,
      }),
    );
    expect(mockRecordMetric).toHaveBeenCalledWith("agent-1", "user-1", "messages_sent", 1);
    expect(mockRecordTokenUsage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-1" }),
      "user-1",
      expect.objectContaining({ usage: { total_tokens: 42 } }),
      expect.objectContaining({ source: "openclaw.gateway", sessionId: "main" }),
    );
  });

  it("creates a fresh authenticated connection when Docker reuses an agent endpoint", async () => {
    const agents = new Map([
      [
        "agent-old",
        {
          id: "agent-old",
          user_id: "user-1",
          status: "running",
          host: "10.0.0.10",
          gateway_token: "old-gateway-token",
          gateway_host_port: null,
        },
      ],
      [
        "agent-new",
        {
          id: "agent-new",
          user_id: "user-1",
          status: "running",
          host: "10.0.0.10",
          gateway_token: "new-gateway-token",
          gateway_host_port: null,
        },
      ],
    ]);
    mockDb.query.mockImplementation(async (sql, params = []) => {
      if (String(sql).includes("FROM agents WHERE id = $1")) {
        const agent = agents.get(params[0]);
        return { rows: agent ? [agent] : [] };
      }
      return { rows: [] };
    });

    const first = await request(app)
      .post("/agents/agent-old/gateway/chat")
      .send({ message: "first" });
    const second = await request(app)
      .post("/agents/agent-new/gateway/chat")
      .send({ message: "second" });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(mockFakeWebSocket.connectParams.map((params) => params.auth.password)).toEqual([
      "old-gateway-token",
      "new-gateway-token",
    ]);
    expect(mockFakeWebSocket.connectParams[0].device.id).not.toBe(
      mockFakeWebSocket.connectParams[1].device.id,
    );
    expect(mockFakeWebSocket.instances).toHaveLength(2);
    expect(mockFakeWebSocket.instances[0].readyState).toBe(mockFakeWebSocket.CLOSED);
    expect(mockFakeWebSocket.instances[1].readyState).toBe(mockFakeWebSocket.OPEN);
  });

  it("coalesces concurrent cold gateway status probes into one authenticated socket", async () => {
    mockDb.query.mockImplementation(async (sql) => {
      if (String(sql).includes("FROM agents WHERE id = $1")) {
        return {
          rows: [
            {
              id: "agent-concurrent-status",
              user_id: "user-1",
              status: "running",
              host: "10.0.0.44",
              gateway_token: "concurrent-gateway-token",
              gateway_host_port: null,
            },
          ],
        };
      }
      return { rows: [] };
    });

    const response = await request(app).get("/agents/agent-concurrent-status/gateway/status");

    expect(response.status).toBe(200);
    expect(mockFakeWebSocket.instances).toHaveLength(1);
    expect(mockFakeWebSocket.instances[0].readyState).toBe(mockFakeWebSocket.OPEN);
    expect(mockFakeWebSocket.connectParams).toHaveLength(1);
    expect(mockFakeWebSocket.connectParams[0].auth.password).toBe("concurrent-gateway-token");
  });

  it("reconnects with a new identity when an agent gateway token rotates", async () => {
    let token = "gateway-token-v1";
    mockDb.query.mockImplementation(async (sql) => {
      if (String(sql).includes("FROM agents WHERE id = $1")) {
        return {
          rows: [
            {
              id: "agent-1",
              user_id: "user-1",
              status: "running",
              host: "10.0.0.10",
              gateway_token: token,
              gateway_host_port: null,
            },
          ],
        };
      }
      return { rows: [] };
    });

    await request(app).post("/agents/agent-1/gateway/chat").send({ message: "before rotation" });
    token = "gateway-token-v2";
    await request(app).post("/agents/agent-1/gateway/chat").send({ message: "after rotation" });

    expect(mockFakeWebSocket.connectParams.map((params) => params.auth.password)).toEqual([
      "gateway-token-v1",
      "gateway-token-v2",
    ]);
    expect(mockFakeWebSocket.instances).toHaveLength(2);
    expect(mockFakeWebSocket.instances[0].readyState).toBe(mockFakeWebSocket.CLOSED);
  });

  it("does not reconnect a retired socket after its endpoint is reassigned", async () => {
    const agents = new Map([
      [
        "agent-old",
        {
          id: "agent-old",
          user_id: "user-1",
          status: "running",
          host: "10.0.0.10",
          gateway_token: "old-gateway-token",
          gateway_host_port: null,
        },
      ],
      [
        "agent-new",
        {
          id: "agent-new",
          user_id: "user-1",
          status: "running",
          host: "10.0.0.10",
          gateway_token: "new-gateway-token",
          gateway_host_port: null,
        },
      ],
    ]);
    mockDb.query.mockImplementation(async (sql, params = []) => {
      if (String(sql).includes("FROM agents WHERE id = $1")) {
        const agent = agents.get(params[0]);
        return { rows: agent ? [agent] : [] };
      }
      return { rows: [] };
    });

    await request(app).post("/agents/agent-old/gateway/chat").send({ message: "first" });
    mockFakeWebSocket.instances[0].close();
    await request(app).post("/agents/agent-new/gateway/chat").send({ message: "second" });

    // The old connection already scheduled its one-second background retry
    // before the replacement request retired it. It must not dial again.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(mockFakeWebSocket.instances).toHaveLength(2);
    expect(mockFakeWebSocket.connectParams.map((params) => params.auth.password)).toEqual([
      "old-gateway-token",
      "new-gateway-token",
    ]);
  });

  it("records model token metadata from streaming chat final events", async () => {
    mockFakeWebSocket.streamMode = true;
    mockRunningAgent();

    const res = await postStreamingChat();

    expect(res.status).toBe(200);
    expect(res.body).toContain("[DONE]");
    expect(mockRecordMetric).toHaveBeenCalledWith("agent-1", "user-1", "messages_sent", 1);
    expect(mockRecordTokenUsage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-1" }),
      "user-1",
      expect.objectContaining({
        model: "openai/gpt-5.5",
        provider: "openai",
        usage: {
          input_tokens: 1000,
          output_tokens: 500,
          total_tokens: 1500,
        },
      }),
      expect.objectContaining({ source: "openclaw.gateway", sessionId: "main" }),
    );
  });

  it("subscribes to the requested session before streaming chat", async () => {
    const sessionKey = "agent:main:session-42";
    mockFakeWebSocket.streamMode = true;
    mockFakeWebSocket.streamEvents = [
      {
        event: "chat",
        payload: {
          runId: "run-1",
          sessionKey,
          state: "final",
          message: { role: "assistant", content: [{ type: "text", text: "done" }] },
        },
      },
    ];
    mockRunningAgent();

    const res = await postStreamingChat({ session_id: sessionKey });
    const payloads = parseSsePayloads(res.body);

    expect(res.status).toBe(200);
    expect(mockFakeWebSocket.sessionMessageSubscriptions).toEqual([{ key: sessionKey }]);
    expect(payloads).toContainEqual({ type: "done", runId: "run-1", sessionKey });
  });

  it("shares one subscription lifetime across concurrent alias and canonical streams", async () => {
    mockFakeWebSocket.streamMode = true;
    mockFakeWebSocket.chatResponses = [
      {
        runId: "run-1",
        streamEvents: [
          {
            delayMs: 30,
            event: "chat",
            payload: {
              runId: "run-1",
              sessionKey: "main",
              state: "final",
              message: { role: "assistant", content: [{ type: "text", text: "first" }] },
            },
          },
        ],
      },
      {
        runId: "run-2",
        streamEvents: [
          {
            delayMs: 80,
            event: "chat",
            payload: {
              runId: "run-2",
              sessionKey: "main",
              state: "final",
              message: { role: "assistant", content: [{ type: "text", text: "second" }] },
            },
          },
        ],
      },
    ];
    mockDb.query.mockResolvedValue({
      rows: [
        {
          id: "agent-1",
          user_id: "user-1",
          status: "running",
          host: "10.0.0.10",
          gateway_token: "gateway-token",
          gateway_host_port: null,
        },
      ],
    });
    let markAliasSubscriptionStarted;
    const aliasSubscriptionStarted = new Promise((resolve) => {
      markAliasSubscriptionStarted = resolve;
    });
    mockFakeWebSocket.onSessionMessageSubscribe = markAliasSubscriptionStarted;

    const firstRequest = Promise.resolve(postStreamingChat({ session_id: "main" }));
    await aliasSubscriptionStarted;
    const secondRequest = Promise.resolve(postStreamingChat({ session_id: "agent:main:main" }));
    const firstCompleted = await firstRequest;

    expect(firstCompleted.status).toBe(200);
    expect(mockFakeWebSocket.sessionMessageSubscriptions).toEqual([{ key: "main" }]);
    expect(mockFakeWebSocket.sessionMessageUnsubscriptions).toHaveLength(0);
    expect(mockFakeWebSocket.sessionMessageSubscriptionRegistry).toEqual(
      new Set(["agent:main:main"]),
    );

    const secondResponse = await secondRequest;
    await new Promise((resolve) => setImmediate(resolve));

    expect(firstCompleted.body).toContain("[DONE]");
    expect(secondResponse.body).toContain("[DONE]");
    expect(mockFakeWebSocket.sessionMessageSubscriptions).toEqual([{ key: "main" }]);
    expect(mockFakeWebSocket.sessionMessageUnsubscriptions).toEqual([{ key: "agent:main:main" }]);
    expect(mockFakeWebSocket.sessionMessageSubscriptionRegistry).toEqual(new Set());
  });

  it("keeps scoped and bare global subscriptions independent", async () => {
    mockFakeWebSocket.streamMode = true;
    mockFakeWebSocket.chatResponses = [
      {
        runId: "run-scoped",
        streamEvents: [
          {
            delayMs: 30,
            event: "chat",
            payload: {
              runId: "run-scoped",
              sessionKey: "agent:foo:global",
              state: "final",
              message: { role: "assistant", content: [{ type: "text", text: "scoped" }] },
            },
          },
        ],
      },
      {
        runId: "run-default",
        streamEvents: [
          {
            delayMs: 80,
            event: "chat",
            payload: {
              runId: "run-default",
              sessionKey: "global",
              state: "final",
              message: { role: "assistant", content: [{ type: "text", text: "default" }] },
            },
          },
        ],
      },
    ];
    mockDb.query.mockResolvedValue({
      rows: [
        {
          id: "agent-1",
          user_id: "user-1",
          status: "running",
          host: "10.0.0.10",
          gateway_token: "gateway-token",
          gateway_host_port: null,
        },
      ],
    });
    let markScopedSubscriptionStarted;
    const scopedSubscriptionStarted = new Promise((resolve) => {
      markScopedSubscriptionStarted = resolve;
    });
    mockFakeWebSocket.onSessionMessageSubscribe = markScopedSubscriptionStarted;

    const scopedRequest = Promise.resolve(postStreamingChat({ session_id: "agent:foo:global" }));
    await scopedSubscriptionStarted;
    const defaultRequest = Promise.resolve(postStreamingChat({ session_id: "global" }));
    const scopedResponse = await scopedRequest;
    await new Promise((resolve) => setImmediate(resolve));

    expect(scopedResponse.body).toContain("[DONE]");
    expect(mockFakeWebSocket.sessionMessageSubscriptions).toEqual([
      { key: "global", agentId: "foo" },
      { key: "global", agentId: "main" },
    ]);
    expect(mockFakeWebSocket.sessionMessageUnsubscriptions).toEqual([
      { key: "global", agentId: "foo" },
    ]);
    expect(mockFakeWebSocket.sessionMessageSubscriptionRegistry).toEqual(
      new Set(["agent:main:global"]),
    );

    const defaultResponse = await defaultRequest;
    await new Promise((resolve) => setImmediate(resolve));

    expect(defaultResponse.body).toContain("[DONE]");
    expect(mockFakeWebSocket.sessionMessageUnsubscriptions).toEqual([
      { key: "global", agentId: "foo" },
      { key: "global", agentId: "main" },
    ]);
    expect(mockFakeWebSocket.sessionMessageSubscriptionRegistry).toEqual(new Set());
  });

  it("continues streaming when an older gateway rejects session subscriptions", async () => {
    mockFakeWebSocket.streamMode = true;
    mockFakeWebSocket.subscriptionMode = "error";
    mockRunningAgent();

    const res = await postStreamingChat();
    const payloads = parseSsePayloads(res.body);

    expect(res.status).toBe(200);
    expect(mockFakeWebSocket.sessionMessageSubscriptions).toEqual([{ key: "main" }]);
    expect(payloads).toContainEqual(expect.objectContaining({ state: "final", runId: "run-1" }));
    expect(payloads).toContainEqual({ type: "done", runId: "run-1", sessionKey: "main" });
    expect(mockFakeWebSocket.sessionMessageUnsubscriptions).toHaveLength(0);
  });

  it("stops promptly when the client closes during the subscription RPC", async () => {
    app = buildApp({ chatTimeoutMs: 20 });
    mockFakeWebSocket.streamMode = true;
    mockFakeWebSocket.subscriptionDelayMs = 20;
    mockFakeWebSocket.streamEvents = [];
    mockRunningAgent();
    let markSubscriptionStarted;
    const subscriptionStarted = new Promise((resolve) => {
      markSubscriptionStarted = resolve;
    });
    mockFakeWebSocket.onSessionMessageSubscribe = markSubscriptionStarted;

    const pendingRequest = postStreamingChat();
    const requestOutcome = pendingRequest.then(
      () => null,
      (error) => error,
    );
    await subscriptionStarted;
    pendingRequest.abort();
    await requestOutcome;
    if (pendingRequest._server?.listening) {
      await new Promise((resolve) => pendingRequest._server.close(resolve));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockFakeWebSocket.chatSendRequests).toHaveLength(0);
    expect(
      mockRecordMetric.mock.calls.some(
        (call) => call[2] === "error" && call[4]?.code === "CHAT_TIMEOUT",
      ),
    ).toBe(false);
  });

  it("filters pooled-socket events from a different acknowledged run", async () => {
    mockFakeWebSocket.streamMode = true;
    mockFakeWebSocket.streamEvents = [
      {
        event: "chat",
        payload: {
          runId: "run-stale",
          sessionKey: "main",
          state: "final",
          message: { role: "assistant", content: [{ type: "text", text: "stale" }] },
        },
      },
      {
        event: "chat",
        payload: {
          runId: "run-1",
          sessionKey: "main",
          state: "final",
          message: { role: "assistant", content: [{ type: "text", text: "current" }] },
        },
      },
    ];
    mockRunningAgent();

    const res = await postStreamingChat();
    const payloads = parseSsePayloads(res.body);

    expect(res.body).not.toContain("run-stale");
    expect(res.body).not.toContain("stale");
    expect(payloads).toContainEqual(
      expect.objectContaining({
        runId: "run-1",
        state: "final",
        message: expect.objectContaining({
          content: [{ type: "text", text: "current" }],
        }),
      }),
    );
  });

  it("drops malformed pooled events that omit runId", async () => {
    mockFakeWebSocket.streamMode = true;
    mockFakeWebSocket.streamEvents = [
      {
        event: "chat",
        payload: {
          sessionKey: "main",
          state: "final",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "runless pooled output" }],
          },
        },
      },
      {
        event: "chat",
        payload: {
          runId: "run-1",
          sessionKey: "main",
          state: "final",
          message: { role: "assistant", content: [{ type: "text", text: "current" }] },
        },
      },
    ];
    mockRunningAgent();

    const res = await postStreamingChat();
    const payloads = parseSsePayloads(res.body);

    expect(res.body).not.toContain("runless pooled output");
    expect(payloads).toContainEqual(
      expect.objectContaining({
        runId: "run-1",
        state: "final",
        message: expect.objectContaining({
          content: [{ type: "text", text: "current" }],
        }),
      }),
    );
  });

  it.each([
    ["an RPC error", { ok: false, error: { message: "chat.send denied" } }, "chat.send denied"],
    ["a missing runId", { result: { status: "started" } }, "no valid runId"],
    ["a blank runId", { runId: "   " }, "no valid runId"],
  ])("fails closed on %s without forwarding pooled events", async (_label, response, errorText) => {
    const unrelatedEvent = {
      event: "chat",
      payload: {
        runId: "run-unrelated",
        sessionKey: "main",
        state: "final",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "unrelated concurrent output" }],
        },
      },
    };
    mockFakeWebSocket.streamMode = true;
    mockFakeWebSocket.chatResponses = [
      {
        ...response,
        preAckEvents: [unrelatedEvent],
        streamEvents: [unrelatedEvent],
      },
    ];
    mockRunningAgent();

    const res = await postStreamingChat();
    const payloads = parseSsePayloads(res.body);

    expect(res.status).toBe(200);
    expect(payloads).toContainEqual(
      expect.objectContaining({ type: "error", error: expect.stringContaining(errorText) }),
    );
    expect(res.body).not.toContain("run-unrelated");
    expect(res.body).not.toContain("unrelated concurrent output");
    expect(payloads.some((payload) => payload.type === "done")).toBe(false);
    expect(mockRecordMetric).not.toHaveBeenCalledWith("agent-1", "user-1", "messages_sent", 1);
  });

  it("does not terminate on or accumulate text from a matching user-message echo", async () => {
    mockFakeWebSocket.streamMode = true;
    mockFakeWebSocket.streamEvents = [
      {
        event: "chat",
        payload: {
          runId: "run-1",
          sessionKey: "main",
          state: "final",
          message: { role: "user", content: [{ type: "text", text: "ping" }] },
        },
      },
      {
        event: "chat",
        payload: {
          runId: "run-1",
          sessionKey: "main",
          state: "delta",
          deltaText: "pong",
        },
      },
      {
        event: "chat",
        payload: {
          runId: "run-1",
          sessionKey: "main",
          state: "final",
        },
      },
    ];
    mockRunningAgent();

    const res = await postStreamingChat();
    const payloads = parseSsePayloads(res.body);

    expect(payloads).toContainEqual(
      expect.objectContaining({
        state: "final",
        message: expect.objectContaining({ role: "user" }),
      }),
    );
    expect(payloads).toContainEqual(
      expect.objectContaining({
        state: "delta",
        message: expect.objectContaining({
          role: "assistant",
          content: [{ type: "text", text: "pong" }],
        }),
      }),
    );
    expect(payloads).toContainEqual(
      expect.objectContaining({
        state: "final",
        message: expect.objectContaining({
          role: "assistant",
          content: [{ type: "text", text: "pong" }],
        }),
      }),
    );
    expect(res.body).not.toContain("pingpong");
    expect(payloads.at(-1)).toEqual({ type: "done", runId: "run-1", sessionKey: "main" });
  });

  it("accumulates protocol v4 deltaText and projects it onto an empty final event", async () => {
    mockFakeWebSocket.streamMode = true;
    mockFakeWebSocket.streamEvents = [
      {
        event: "chat",
        payload: { runId: "run-1", sessionKey: "main", state: "delta", deltaText: "Hel" },
      },
      {
        event: "chat",
        payload: { runId: "run-1", sessionKey: "main", state: "delta", deltaText: "lo" },
      },
      {
        event: "chat",
        payload: { runId: "run-1", sessionKey: "main", state: "final" },
      },
    ];
    mockRunningAgent();

    const res = await postStreamingChat();
    const chatPayloads = parseSsePayloads(res.body).filter((payload) => payload.runId === "run-1");

    expect(chatPayloads.map((payload) => payload.message?.content?.[0]?.text)).toEqual([
      "Hel",
      "Hello",
      "Hello",
      undefined,
    ]);
    expect(chatPayloads.at(-1)).toEqual({ type: "done", runId: "run-1", sessionKey: "main" });
  });

  it.each(["error", "aborted"])(
    "terminates on a chat %s event even when no assistant content preceded it",
    async (state) => {
      app = buildApp({ chatTimeoutMs: 100 });
      mockFakeWebSocket.streamMode = true;
      mockFakeWebSocket.streamEvents = [
        {
          event: "chat",
          payload: {
            runId: "run-1",
            sessionKey: "main",
            state,
            errorMessage: state === "error" ? "provider failed" : undefined,
          },
        },
      ];
      mockRunningAgent();

      const res = await postStreamingChat();
      const payloads = parseSsePayloads(res.body);

      expect(payloads).toContainEqual(expect.objectContaining({ runId: "run-1", state }));
      expect(payloads).toContainEqual({ type: "done", runId: "run-1", sessionKey: "main" });
      expect(res.body).not.toContain("CHAT_TIMEOUT");
    },
  );

  it.each([
    ["error", "error", "AGENT_LIFECYCLE_ERROR", true],
    ["end", "final", undefined, undefined],
  ])(
    "uses an agent lifecycle %s event as a terminal fallback",
    async (phase, expectedState, expectedCode, fallbackExhaustedFailure) => {
      app = buildApp({
        chatTimeoutMs: 100,
        agentTerminalFallbackGraceMs: 1,
        agentErrorFallbackGraceMs: 50,
      });
      mockFakeWebSocket.streamMode = true;
      mockFakeWebSocket.streamEvents = [
        {
          event: "agent",
          payload: {
            runId: "run-1",
            sessionKey: "main",
            stream: "lifecycle",
            data: {
              phase,
              error: phase === "error" ? "agent failed" : undefined,
              fallbackExhaustedFailure,
            },
          },
        },
      ];
      mockRunningAgent();

      const res = await postStreamingChat();
      const payloads = parseSsePayloads(res.body);
      const terminalPayload = payloads.find((payload) => payload.state === expectedState);

      expect(terminalPayload).toEqual(
        expect.objectContaining({
          runId: "run-1",
          sessionKey: "main",
          state: expectedState,
          ...(expectedCode ? { code: expectedCode, error: "agent failed" } : {}),
        }),
      );
      expect(payloads).toContainEqual({ type: "done", runId: "run-1", sessionKey: "main" });
      expect(res.body).not.toContain("CHAT_TIMEOUT");
    },
  );

  it("waits through the upstream retry grace and accepts recovered chat activity", async () => {
    app = buildApp({
      chatTimeoutMs: 100,
      agentTerminalFallbackGraceMs: 1,
      agentErrorFallbackGraceMs: 15,
    });
    mockFakeWebSocket.streamMode = true;
    mockFakeWebSocket.streamEvents = [
      {
        event: "agent",
        payload: {
          runId: "run-1",
          sessionKey: "main",
          stream: "lifecycle",
          data: { phase: "error", error: "first provider failed" },
        },
      },
      {
        event: "agent",
        payload: {
          runId: "run-1",
          sessionKey: "main",
          stream: "assistant",
          data: { text: "retrying" },
        },
      },
      {
        event: "chat",
        delayMs: 20,
        payload: {
          runId: "run-1",
          sessionKey: "main",
          state: "delta",
          deltaText: "recovered",
        },
      },
      {
        event: "chat",
        payload: {
          runId: "run-1",
          sessionKey: "main",
          state: "final",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "recovered" }],
          },
        },
      },
    ];
    mockRunningAgent();

    const res = await postStreamingChat();
    const payloads = parseSsePayloads(res.body);

    expect(payloads).toContainEqual(
      expect.objectContaining({
        runId: "run-1",
        state: "final",
        message: expect.objectContaining({
          content: [{ type: "text", text: "recovered" }],
        }),
      }),
    );
    expect(res.body).not.toContain("AGENT_LIFECYCLE_ERROR");
    expect(res.body).not.toContain("CHAT_TIMEOUT");
  });

  it("falls back after the retry-aware lifecycle error grace expires", async () => {
    app = buildApp({
      chatTimeoutMs: 100,
      agentTerminalFallbackGraceMs: 1,
      agentErrorFallbackGraceMs: 5,
    });
    mockFakeWebSocket.streamMode = true;
    mockFakeWebSocket.streamEvents = [
      {
        event: "agent",
        payload: {
          runId: "run-1",
          sessionKey: "main",
          stream: "lifecycle",
          data: { phase: "error", error: "all retries stalled" },
        },
      },
    ];
    mockRunningAgent();

    const res = await postStreamingChat();
    const payloads = parseSsePayloads(res.body);

    expect(payloads).toContainEqual(
      expect.objectContaining({
        state: "error",
        code: "AGENT_LIFECYCLE_ERROR",
        error: "all retries stalled",
      }),
    );
    expect(res.body).not.toContain("CHAT_TIMEOUT");
  });

  it("emits an explicit error event and metric when the chat stream times out", async () => {
    app = buildApp({ chatTimeoutMs: 10 });
    mockFakeWebSocket.streamMode = true;
    mockFakeWebSocket.streamEvents = [];
    mockRunningAgent();

    const res = await postStreamingChat();
    const payloads = parseSsePayloads(res.body);

    expect(payloads).toContainEqual(
      expect.objectContaining({
        type: "error",
        state: "error",
        code: "CHAT_TIMEOUT",
        runId: "run-1",
        sessionKey: "main",
      }),
    );
    expect(payloads).toContainEqual({ type: "done", runId: "run-1", sessionKey: "main" });
    expect(mockRecordMetric).toHaveBeenCalledWith("agent-1", "user-1", "error", 1, {
      code: "CHAT_TIMEOUT",
      error: "Chat stream timed out after 10ms",
      runId: "run-1",
    });
  });

  it("returns 502 when gateway health and status both fail", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "agent-1",
          user_id: "user-1",
          status: "running",
          host: "10.0.0.10",
          gateway_token: "gateway-token",
          gateway_host_port: null,
        },
      ],
    });
    mockFakeWebSocket.healthMode = "error";
    mockFakeWebSocket.statusMode = "error";

    const res = await request(app).get("/agents/agent-1/gateway/status");

    expect(res.status).toBe(502);
    expect(res.body).toEqual(
      expect.objectContaining({
        error: "Gateway unreachable",
      }),
    );
  });

  it("returns 409 for Hermes runtimes", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "agent-hermes-1",
          user_id: "user-1",
          status: "running",
          host: "10.0.0.30",
          backend_type: "docker",
          runtime_family: "hermes",
          gateway_token: null,
          gateway_host_port: null,
        },
      ],
    });

    const res = await request(app).get("/agents/agent-hermes-1/gateway/status");

    expect(res.status).toBe(409);
    expect(res.body).toEqual(
      expect.objectContaining({
        error: "This runtime family does not expose an OpenClaw gateway",
      }),
    );
  });

  it("merges gateway-native tools with integration manifest tools", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "agent-2",
          user_id: "user-1",
          status: "running",
          host: "10.0.0.20",
          gateway_token: "gateway-token",
          gateway_host_port: null,
        },
      ],
    });
    mockFakeWebSocket.toolsCatalogResult = {
      tools: [
        {
          type: "function",
          function: {
            name: "gateway_native_tool",
            description: "Native gateway tool.",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    };
    mockGetIntegrationsForSync.mockResolvedValue([
      { id: "int-gh", provider: "github", toolSpecs: [{ name: "github_list_repositories" }] },
    ]);
    mockBuildIntegrationToolCatalogEntries.mockReturnValue([
      {
        type: "function",
        function: {
          name: "github_list_repositories",
          description: "List repositories.",
          parameters: { type: "object", properties: {} },
        },
        nora: { source: "integration-manifest" },
      },
    ]);

    const res = await request(app).get("/agents/agent-2/gateway/tools");

    expect(res.status).toBe(200);
    expect(res.body.tools).toHaveLength(2);
    expect(res.body.tools[0].function.name).toBe("gateway_native_tool");
    expect(res.body.tools[1].function.name).toBe("github_list_repositories");
    expect(mockGetIntegrationsForSync).toHaveBeenCalledWith("agent-2");
    expect(mockBuildIntegrationToolCatalogEntries).toHaveBeenCalledWith(
      [{ id: "int-gh", provider: "github", toolSpecs: [{ name: "github_list_repositories" }] }],
      { reservedNames: new Set(["gateway_native_tool"]) },
    );
  });

  it("proxies gateway UI assets only after resolving a safe gateway target", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "agent-1",
          user_id: "user-1",
          status: "running",
          host: "10.0.0.10",
          gateway_token: "gateway-token",
          gateway_host_port: null,
        },
      ],
    });
    global.fetch.mockResolvedValueOnce({
      status: 200,
      headers: new Headers({ "content-type": "application/javascript" }),
      arrayBuffer: async () => Buffer.from("console.log('ok')"),
    });

    const res = await request(app).get("/agents/agent-1/gateway/assets/app.js?cache=1");

    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledWith(
      "http://10.0.0.10:18789/assets/app.js?cache=1",
      expect.objectContaining({
        headers: expect.objectContaining({
          Host: "10.0.0.10:18789",
        }),
      }),
    );
  });

  it("rejects gateway UI proxy targets that resolve to metadata addresses", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "agent-1",
          user_id: "user-1",
          status: "running",
          host: "169.254.169.254",
          gateway_token: "gateway-token",
          gateway_host_port: null,
        },
      ],
    });

    const res = await request(app).get("/agents/agent-1/gateway/assets/app.js");

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("Gateway UI unreachable");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects gateway UI proxy targets on non-gateway ports", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "agent-1",
          user_id: "user-1",
          status: "running",
          host: "10.0.0.10",
          gateway_host: "10.0.0.10",
          gateway_port: 80,
          gateway_token: "gateway-token",
          gateway_host_port: null,
        },
      ],
    });

    const res = await request(app).get("/agents/agent-1/gateway/assets/app.js");

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("Gateway UI unreachable");
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
