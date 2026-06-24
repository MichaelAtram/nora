// @ts-nocheck
const express = require("express");
const request = require("supertest");

process.env.JWT_SECRET = process.env.JWT_SECRET || "secret";

const {
  DEMO_MODEL_ID,
  deriveDemoToken,
  demoLlmBaseUrl,
  buildDemoReply,
  chunkReply,
} = require("../demoLlm");

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/demo-llm", require("../routes/demoLlm"));
  return app;
}

const TOKEN = deriveDemoToken();

describe("demoLlm helpers", () => {
  it("derives a stable token from JWT_SECRET", () => {
    expect(deriveDemoToken()).toBe(deriveDemoToken());
    expect(deriveDemoToken({ JWT_SECRET: "a" })).not.toBe(deriveDemoToken({ JWT_SECRET: "b" }));
  });

  it("builds the in-network stub URL from the backend env contract", () => {
    expect(demoLlmBaseUrl({})).toBe("http://backend-api:4000/demo-llm/v1");
    expect(demoLlmBaseUrl({ BACKEND_API_URL: "http://api.internal:9999/" })).toBe(
      "http://api.internal:9999/demo-llm/v1",
    );
    expect(
      demoLlmBaseUrl({
        AGENT_RUNTIME_BACKEND_API_URL: "http://k8s-backend:4000",
        BACKEND_API_URL: "http://other",
      }),
    ).toBe("http://k8s-backend:4000/demo-llm/v1");
  });

  it("produces a deterministic reply echoing the user message", () => {
    const messages = [{ role: "user", content: "Hello demo" }];
    expect(buildDemoReply(messages)).toBe(buildDemoReply(messages));
    expect(buildDemoReply(messages)).toContain('You said: "Hello demo"');
  });

  it("chunks replies without losing characters", () => {
    const reply = buildDemoReply([{ role: "user", content: "chunk me please" }]);
    expect(chunkReply(reply).join("")).toBe(reply);
  });
});

describe("POST /demo-llm/v1/chat/completions", () => {
  it("rejects a missing or wrong bearer token", async () => {
    const app = makeApp();
    const noAuth = await request(app).post("/demo-llm/v1/chat/completions").send({ messages: [] });
    expect(noAuth.status).toBe(401);
    const badAuth = await request(app)
      .post("/demo-llm/v1/chat/completions")
      .set("Authorization", "Bearer wrong")
      .send({ messages: [] });
    expect(badAuth.status).toBe(401);
  });

  it("returns an OpenAI-shaped non-streaming completion", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/demo-llm/v1/chat/completions")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ model: DEMO_MODEL_ID, messages: [{ role: "user", content: "ping" }] });
    expect(res.status).toBe(200);
    expect(res.body.object).toBe("chat.completion");
    expect(res.body.model).toBe(DEMO_MODEL_ID);
    expect(res.body.choices[0].message.role).toBe("assistant");
    expect(res.body.choices[0].message.content).toContain('You said: "ping"');
    expect(res.body.choices[0].finish_reason).toBe("stop");
  });

  it("streams SSE chunks with OpenAI delta framing and a [DONE] sentinel", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/demo-llm/v1/chat/completions")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ stream: true, messages: [{ role: "user", content: "stream test" }] });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);

    const events = res.text
      .split("\n\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6));
    expect(events[events.length - 1]).toBe("[DONE]");

    const parsed = events.slice(0, -1).map((e) => JSON.parse(e));
    expect(parsed[0].choices[0].delta.role).toBe("assistant");
    expect(parsed[parsed.length - 1].choices[0].finish_reason).toBe("stop");
    const text = parsed.map((p) => p.choices[0].delta.content || "").join("");
    expect(text).toContain('You said: "stream test"');
    // Reassembled stream matches the non-streaming reply exactly.
    expect(text).toBe(buildDemoReply([{ role: "user", content: "stream test" }]));
  });

  it("lists the demo model", async () => {
    const app = makeApp();
    const res = await request(app)
      .get("/demo-llm/v1/models")
      .set("Authorization", `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.data[0].id).toBe(DEMO_MODEL_ID);
  });
});

describe("runtime wiring", () => {
  it("registers the nora-demo custom provider when token+url env are present", () => {
    const {
      buildOpenClawCustomProviders,
      mapNoraProviderIdToOpenClaw,
    } = require("../../agent-runtime/lib/runtimeBootstrap");
    const providers = buildOpenClawCustomProviders({
      NORA_DEMO_LLM_TOKEN: "tok",
      NORA_DEMO_LLM_BASE_URL: "http://backend-api:4000/demo-llm/v1/",
    });
    expect(providers["nora-demo"]).toMatchObject({
      api: "openai-completions",
      baseUrl: "http://backend-api:4000/demo-llm/v1",
      apiKey: "tok",
    });
    expect(providers["nora-demo"].models[0].id).toBe("nora-demo-1");
    expect(mapNoraProviderIdToOpenClaw("demo")).toBe("nora-demo");
    // No env -> no provider.
    expect(buildOpenClawCustomProviders({})).toEqual({});
  });
});
