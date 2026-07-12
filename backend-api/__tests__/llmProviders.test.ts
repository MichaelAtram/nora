// @ts-nocheck
const mockDbClient = { query: jest.fn(), release: jest.fn() };
const mockDb = { query: jest.fn(), connect: jest.fn() };
const mockEncrypt = jest.fn((value) => `enc(${value})`);

jest.mock("../db", () => mockDb);
jest.mock("../crypto", () => ({
  encrypt: mockEncrypt,
  decrypt: jest.fn(),
  ensureEncryptionConfigured: jest.fn(),
}));

const {
  addProvider,
  buildAuthProfiles,
  ensureDemoProvider,
  getDeploymentProvider,
} = require("../llmProviders");

beforeEach(() => {
  mockDb.query.mockReset();
  mockDb.connect.mockReset().mockResolvedValue(mockDbClient);
  mockDbClient.query.mockReset();
  mockDbClient.release.mockReset();
  mockEncrypt.mockClear();
});

describe("llmProviders demo/default transitions", () => {
  it("reuses one demo provider across repeated activation attempts", async () => {
    let persisted = null;
    mockDbClient.query.mockImplementation(async (sql, params) => {
      if (sql.includes("FROM llm_providers") && sql.includes("provider = $2")) {
        return { rows: persisted ? [persisted] : [] };
      }
      if (sql.includes("COUNT(*)::int AS provider_count")) {
        return { rows: [{ provider_count: persisted ? 1 : 0 }] };
      }
      if (sql.includes("INSERT INTO llm_providers")) {
        persisted = {
          id: "provider-demo",
          provider: "demo",
          model: "nora-demo-1",
          is_default: true,
          created_at: "2026-07-12T00:00:00.000Z",
        };
        return { rows: [persisted] };
      }
      if (sql.includes("UPDATE llm_providers")) {
        return { rows: [persisted] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const first = await ensureDemoProvider("user-1", mockDbClient);
    const second = await ensureDemoProvider("user-1", mockDbClient);

    expect(first.id).toBe("provider-demo");
    expect(second.id).toBe("provider-demo");
    expect(
      mockDbClient.query.mock.calls.filter(([sql]) => sql.includes("INSERT INTO llm_providers")),
    ).toHaveLength(1);
  });

  it("reconciles legacy duplicate demo providers to one canonical row", async () => {
    mockDbClient.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "provider-demo-default",
            provider: "demo",
            model: "nora-demo-1",
            is_default: true,
          },
          {
            id: "provider-demo-duplicate",
            provider: "demo",
            model: "nora-demo-1",
            is_default: false,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "provider-demo-default",
            provider: "demo",
            model: "nora-demo-1",
            is_default: true,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const result = await ensureDemoProvider("user-1", mockDbClient);

    expect(result.id).toBe("provider-demo-default");
    expect(mockDbClient.query).toHaveBeenCalledWith(
      "DELETE FROM llm_providers WHERE user_id = $1 AND provider = $2 AND id <> $3",
      ["user-1", "demo", "provider-demo-default"],
    );
  });

  it("promotes the first real provider when demo is the current default", async () => {
    mockDbClient.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // advisory lock
      .mockResolvedValueOnce({ rows: [{ provider_count: 1, demo_is_default: true }] })
      .mockResolvedValueOnce({ rows: [] }) // clear demo default
      .mockResolvedValueOnce({
        rows: [
          {
            id: "provider-openai",
            provider: "openai",
            model: "gpt-5.5",
            is_default: true,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const result = await addProvider("user-1", "openai", "sk-live", "gpt-5.5");

    expect(result).toEqual(expect.objectContaining({ id: "provider-openai", is_default: true }));
    expect(mockDbClient.query).toHaveBeenCalledWith(
      "UPDATE llm_providers SET is_default = false WHERE user_id = $1",
      ["user-1"],
    );
    expect(mockDbClient.release).toHaveBeenCalledTimes(1);
  });

  it("does not replace an existing real default when ensuring demo", async () => {
    mockDbClient.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ provider_count: 1 }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "provider-demo",
            provider: "demo",
            model: "nora-demo-1",
            is_default: false,
          },
        ],
      });

    const result = await ensureDemoProvider("user-1", mockDbClient);

    expect(result.is_default).toBe(false);
    const insertCall = mockDbClient.query.mock.calls.find(([sql]) =>
      sql.includes("INSERT INTO llm_providers"),
    );
    expect(insertCall[1][5]).toBe(false);
  });

  it("keeps a new real provider non-default when a real default already exists", async () => {
    mockDbClient.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ provider_count: 2, demo_is_default: false }] })
      .mockResolvedValueOnce({
        rows: [{ id: "provider-groq", provider: "groq", model: null, is_default: false }],
      })
      .mockResolvedValueOnce({ rows: [] });

    await addProvider("user-1", "groq", "gsk-live");

    const insertCall = mockDbClient.query.mock.calls.find(([sql]) =>
      sql.includes("INSERT INTO llm_providers"),
    );
    expect(insertCall[1][5]).toBe(false);
    expect(mockDbClient.query).not.toHaveBeenCalledWith(
      "UPDATE llm_providers SET is_default = false WHERE user_id = $1",
      expect.anything(),
    );
  });

  it("selects an explicit owned provider instead of the global default", async () => {
    const queryable = {
      query: jest.fn().mockResolvedValue({
        rows: [
          {
            id: "provider-demo",
            provider: "demo",
            model: "nora-demo-1",
            config: { baseUrl: "http://backend-api:4000/demo-llm/v1" },
          },
        ],
      }),
    };

    const result = await getDeploymentProvider("user-1", "provider-demo", queryable);

    expect(result.provider).toBe("demo");
    expect(queryable.query).toHaveBeenCalledWith(expect.stringContaining("id = $2"), [
      "user-1",
      "provider-demo",
    ]);
    expect(queryable.query).toHaveBeenCalledTimes(1);
  });
});

describe("llmProviders.buildAuthProfiles", () => {
  it("builds a persisted OpenClaw auth profile store", () => {
    expect(
      buildAuthProfiles({
        OPENAI_API_KEY: "sk-live-test",
        GEMINI_API_KEY: "gm-live-test",
      }),
    ).toEqual({
      version: 1,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: "sk-live-test",
        },
        "google:default": {
          type: "api_key",
          provider: "google",
          key: "gm-live-test",
          endpoint: "https://generativelanguage.googleapis.com/v1beta",
        },
      },
      order: {
        openai: ["openai:default"],
        google: ["google:default"],
      },
      lastGood: {
        openai: "openai:default",
        google: "google:default",
      },
    });
  });

  it("maps MICROSOFT_FOUNDRY_API_KEY to a microsoft-foundry profile (no shared default endpoint)", () => {
    // Foundry endpoints are per-resource — without a saved override the profile
    // ships no endpoint and the runtime must rely on the per-user base_url.
    expect(
      buildAuthProfiles({
        MICROSOFT_FOUNDRY_API_KEY: "msft-live-test",
      }),
    ).toEqual({
      version: 1,
      profiles: {
        "microsoft-foundry:default": {
          type: "api_key",
          provider: "microsoft-foundry",
          key: "msft-live-test",
        },
      },
      order: {
        "microsoft-foundry": ["microsoft-foundry:default"],
      },
      lastGood: {
        "microsoft-foundry": "microsoft-foundry:default",
      },
    });
  });

  it("applies a per-user endpoint override for microsoft-foundry", () => {
    const result = buildAuthProfiles(
      { MICROSOFT_FOUNDRY_API_KEY: "msft-live-test" },
      { "microsoft-foundry": "https://my-foundry.openai.azure.com/openai/v1/" },
    );
    expect(result.profiles["microsoft-foundry:default"]).toEqual({
      type: "api_key",
      provider: "microsoft-foundry",
      key: "msft-live-test",
      endpoint: "https://my-foundry.openai.azure.com/openai/v1/",
    });
  });

  it("writes api_version when a per-user override is supplied", () => {
    const result = buildAuthProfiles(
      { MICROSOFT_FOUNDRY_API_KEY: "msft-live-test" },
      { "microsoft-foundry": "https://my-foundry.openai.azure.com/openai/deployments/my-gpt/" },
      { "microsoft-foundry": "2024-10-21" },
    );
    expect(result.profiles["microsoft-foundry:default"]).toEqual({
      type: "api_key",
      provider: "microsoft-foundry",
      key: "msft-live-test",
      endpoint: "https://my-foundry.openai.azure.com/openai/deployments/my-gpt/",
      api_version: "2024-10-21",
    });
  });

  it("per-user override wins over the catalog endpoint", () => {
    // google has a catalog default (https://generativelanguage.googleapis.com/v1beta)
    // but a user-saved override should win.
    const result = buildAuthProfiles(
      { GEMINI_API_KEY: "gm-live-test" },
      { google: "https://custom-gemini.example.com/v1" },
    );
    expect(result.profiles["google:default"].endpoint).toBe("https://custom-gemini.example.com/v1");
  });
});

describe("llmProviders.buildBaseUrlEnvVars", () => {
  const { buildBaseUrlEnvVars } = require("../llmProviders");

  it("derives <PROVIDER>_BASE_URL env vars from <PROVIDER>_API_KEY-keyed overrides", () => {
    expect(
      buildBaseUrlEnvVars({
        MICROSOFT_FOUNDRY_API_KEY: "https://my-foundry.openai.azure.com/openai/v1/",
      }),
    ).toEqual({
      MICROSOFT_FOUNDRY_BASE_URL: "https://my-foundry.openai.azure.com/openai/v1/",
    });
  });

  it("skips entries without a base URL", () => {
    expect(buildBaseUrlEnvVars({ MICROSOFT_FOUNDRY_API_KEY: "" })).toEqual({});
  });
});

describe("llmProviders.buildApiVersionEnvVars", () => {
  const { buildApiVersionEnvVars } = require("../llmProviders");

  it("derives <PROVIDER>_API_VERSION env vars", () => {
    expect(buildApiVersionEnvVars({ MICROSOFT_FOUNDRY_API_KEY: "2024-10-21" })).toEqual({
      MICROSOFT_FOUNDRY_API_VERSION: "2024-10-21",
    });
  });

  it("skips entries without an api-version", () => {
    expect(buildApiVersionEnvVars({ MICROSOFT_FOUNDRY_API_KEY: "" })).toEqual({});
  });
});
