// @ts-nocheck
const {
  PROXMOX_RELEASE_BLOCKER_ISSUE,
  getBackendCatalog,
  getBackendStatus,
  getDefaultBackend,
  getRuntimeSelectionStatus,
} = require("../../agent-runtime/lib/backendCatalog");

const ORIGINAL_ENV = { ...process.env };
const ENV_KEYS = [
  "ENABLED_BACKENDS",
  "ENABLED_RUNTIME_FAMILIES",
  "ENABLED_SANDBOX_PROFILES",
  "PROXMOX_API_URL",
  "PROXMOX_TOKEN_ID",
  "PROXMOX_TOKEN_SECRET",
  "PROXMOX_SSH_HOST",
  "PROXMOX_SSH_USER",
  "PROXMOX_SSH_PASSWORD",
  "PROXMOX_HERMES_TEMPLATE",
  "PROXMOX_NEMOCLAW_TEMPLATE",
];

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (Object.prototype.hasOwnProperty.call(ORIGINAL_ENV, key)) {
      process.env[key] = ORIGINAL_ENV[key];
    } else {
      delete process.env[key];
    }
  }
}

describe("proxmox runtime selection", () => {
  beforeEach(() => {
    process.env.ENABLED_BACKENDS = "docker,proxmox";
    process.env.PROXMOX_API_URL = "https://pve.example.com:8006/api2/json";
    process.env.PROXMOX_TOKEN_ID = "root@pam!openclaw";
    process.env.PROXMOX_TOKEN_SECRET = "secret";
    process.env.PROXMOX_SSH_HOST = "pve.example.com";
    process.env.PROXMOX_SSH_USER = "root";
    process.env.PROXMOX_SSH_PASSWORD = "secret";
  });

  afterEach(() => {
    restoreEnv();
  });

  it("keeps Proxmox release-blocked even when API and SSH bootstrap configuration exist", () => {
    const status = getBackendStatus("proxmox");

    expect(status.enabled).toBe(true);
    expect(status.configured).toBe(false);
    expect(status.available).toBe(false);
    expect(status.issue).toBe(PROXMOX_RELEASE_BLOCKER_ISSUE);
    expect(status.maturityTier).toBe("blocked");
  });

  it("uses the release blocker before Proxmox token validation", () => {
    process.env.PROXMOX_TOKEN_ID = "root@pam";

    const status = getRuntimeSelectionStatus({
      runtime_family: "openclaw",
      deploy_target: "proxmox",
      sandbox_profile: "standard",
    });

    expect(status.available).toBe(false);
    expect(status.issue).toBe(PROXMOX_RELEASE_BLOCKER_ISSUE);
  });

  it("keeps the first available deploy target as the default standard path", () => {
    const catalog = getBackendCatalog();

    expect(getDefaultBackend(process.env, { sandbox: "standard" })).toBe("docker");
    expect(catalog.find((backend) => backend.id === "docker")?.isDefault).toBe(true);
    expect(catalog.find((backend) => backend.id === "proxmox")?.isDefault).toBe(false);
  });

  it("does not unblock Proxmox selections when runtime-specific templates exist", () => {
    process.env.ENABLED_RUNTIME_FAMILIES = "openclaw,hermes";
    process.env.ENABLED_SANDBOX_PROFILES = "standard,nemoclaw";

    expect(
      getRuntimeSelectionStatus({
        runtime_family: "hermes",
        deploy_target: "proxmox",
        sandbox_profile: "standard",
      }),
    ).toEqual(
      expect.objectContaining({
        enabled: true,
        available: false,
        issue: PROXMOX_RELEASE_BLOCKER_ISSUE,
      }),
    );
    expect(
      getRuntimeSelectionStatus({
        runtime_family: "openclaw",
        deploy_target: "proxmox",
        sandbox_profile: "nemoclaw",
      }),
    ).toEqual(
      expect.objectContaining({
        enabled: true,
        available: false,
        issue: PROXMOX_RELEASE_BLOCKER_ISSUE,
      }),
    );

    process.env.PROXMOX_HERMES_TEMPLATE = "local:vztmpl/nora-hermes.tar.zst";
    process.env.PROXMOX_NEMOCLAW_TEMPLATE = "local:vztmpl/nora-nemoclaw.tar.zst";

    expect(
      getRuntimeSelectionStatus({
        runtime_family: "hermes",
        deploy_target: "proxmox",
        sandbox_profile: "standard",
      }),
    ).toEqual(
      expect.objectContaining({
        enabled: true,
        available: false,
        issue: PROXMOX_RELEASE_BLOCKER_ISSUE,
      }),
    );
    expect(
      getRuntimeSelectionStatus({
        runtime_family: "openclaw",
        deploy_target: "proxmox",
        sandbox_profile: "nemoclaw",
      }),
    ).toEqual(
      expect.objectContaining({
        enabled: true,
        available: false,
        issue: PROXMOX_RELEASE_BLOCKER_ISSUE,
      }),
    );
  });
});
