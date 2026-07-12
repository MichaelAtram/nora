// @ts-nocheck
const request = require("supertest");
const express = require("express");

const mockAddProvider = jest.fn();
const mockSyncAuthToUserAgents = jest.fn();

jest.mock("../llmProviders", () => ({
  addProvider: mockAddProvider,
  listProviders: jest.fn(),
  getAvailableProviders: jest.fn(),
  updateProvider: jest.fn(),
  deleteProvider: jest.fn(),
}));
jest.mock("../authSync", () => ({
  syncAuthToUserAgents: mockSyncAuthToUserAgents,
}));

const router = require("../routes/llmProviders");
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = { id: "user-1" };
  next();
});
app.use("/llm-providers", router);

beforeEach(() => {
  jest.clearAllMocks();
  mockAddProvider.mockResolvedValue({
    id: "provider-openai",
    provider: "openai",
    model: "gpt-5.5",
    is_default: true,
  });
});

describe("POST /llm-providers", () => {
  it("awaits runtime sync after saving a real provider and returns per-agent warnings", async () => {
    mockSyncAuthToUserAgents.mockResolvedValue([
      { agentId: "agent-1", status: "synced" },
      { agentId: "agent-2", status: "failed", error: "runtime unavailable" },
    ]);

    const response = await request(app).post("/llm-providers").send({
      provider: "openai",
      apiKey: "sk-live",
      model: "gpt-5.5",
    });

    expect(response.status).toBe(200);
    expect(mockAddProvider).toHaveBeenCalledWith(
      "user-1",
      "openai",
      "sk-live",
      "gpt-5.5",
      undefined,
    );
    expect(mockSyncAuthToUserAgents).toHaveBeenCalledWith("user-1");
    expect(response.body).toEqual(
      expect.objectContaining({
        id: "provider-openai",
        sync_results: expect.arrayContaining([
          expect.objectContaining({ agentId: "agent-2", status: "failed" }),
        ]),
        sync_warning: expect.stringMatching(/1 running agent/i),
      }),
    );
  });

  it("keeps the successful save response when runtime sync rejects", async () => {
    mockSyncAuthToUserAgents.mockRejectedValue(new Error("runtime sync crashed"));

    const response = await request(app).post("/llm-providers").send({
      provider: "openai",
      apiKey: "sk-live",
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({
        id: "provider-openai",
        sync_results: [],
        sync_warning: expect.stringMatching(/provider saved/i),
      }),
    );
  });
});
