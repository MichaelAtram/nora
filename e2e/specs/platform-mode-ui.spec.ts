import { expect, test, type Page } from "@playwright/test";

import { DEFAULT_PASSWORD, authenticatePage, ensureUserSession } from "./support/app";

async function mockOperatorPolicy(
  page: Page,
  { mode, role }: { mode: string; role: "admin" | "user" },
) {
  await page.route("**/api/auth/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: `${role}-operator`,
        email: `${role}@example.com`,
        role,
      }),
    });
  });
  await page.route("**/api/config/platform", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        mode,
        systemBanner: null,
        deploymentDefaults: { vcpu: 1, ram_mb: 1024, disk_gb: 10 },
      }),
    });
  });
}

async function openMigrationControls(page: Page, token: string) {
  await authenticatePage(page, token, "/app/deploy");
  await page.getByRole("button", { name: /migrate existing/i }).click();
  await expect(page.getByRole("button", { name: /upload bundle/i })).toBeVisible();
}

test("hosted mode hides Remote Hosts and blocks the direct management surface", async ({
  page,
  request,
}) => {
  const user = await ensureUserSession(request, {
    email: "nora-platform-mode-ui@example.com",
    password: DEFAULT_PASSWORD,
  });
  let platformRequests = 0;
  let remoteHostRequests = 0;

  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/remote-hosts")) {
      remoteHostRequests += 1;
    }
  });

  await page.route("**/api/auth/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: "hosted-admin", email: user.email, role: "admin" }),
    });
  });

  await page.route("**/api/config/platform", async (route) => {
    platformRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ mode: "paas", systemBanner: null }),
    });
  });

  await authenticatePage(page, user.token, "/app/dashboard");
  await expect(page.getByRole("link", { name: "Deploy", exact: true })).toBeVisible();
  await expect.poll(() => platformRequests).toBeGreaterThan(0);
  await expect(page.getByRole("link", { name: "Remote Hosts" })).toHaveCount(0);

  await page.goto("/app/remote-hosts");
  await expect(
    page.getByRole("heading", { name: "Remote Hosts require self-hosted Nora" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /register host/i })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Read the Remote Docker guide" })).toBeVisible();

  await openMigrationControls(page, user.token);
  await expect(page.getByRole("button", { name: /live pull/i })).toHaveCount(0);
  await expect(page.getByText(/ssh source/i)).toHaveCount(0);
  await expect(page.getByText(/private key/i)).toHaveCount(0);
  expect(remoteHostRequests).toBe(0);
});

test("self-hosted admins get Docker-only Live Pull controls", async ({ page, request }) => {
  const user = await ensureUserSession(request, {
    email: "nora-live-pull-admin@example.com",
    password: DEFAULT_PASSWORD,
  });
  await mockOperatorPolicy(page, { mode: "selfhosted", role: "admin" });

  await openMigrationControls(page, user.token);
  await page.getByRole("button", { name: /live pull/i }).click();

  await expect(page.getByText("Privileged self-hosted admin operation")).toBeVisible();
  await expect(page.getByText("Local Container ID or Name")).toBeVisible();
  await expect(page.getByText(/ssh source/i)).toHaveCount(0);
  await expect(page.getByText(/private key/i)).toHaveCount(0);
});

test("self-hosted non-admin users get bundle upload only", async ({ page, request }) => {
  const user = await ensureUserSession(request, {
    email: "nora-live-pull-user@example.com",
    password: DEFAULT_PASSWORD,
  });
  await mockOperatorPolicy(page, { mode: "selfhosted", role: "user" });

  await openMigrationControls(page, user.token);
  await expect(page.getByRole("button", { name: /live pull/i })).toHaveCount(0);
});

test("unknown platform mode fails closed and hides Live Pull", async ({ page, request }) => {
  const user = await ensureUserSession(request, {
    email: "nora-live-pull-unknown-mode@example.com",
    password: DEFAULT_PASSWORD,
  });
  await mockOperatorPolicy(page, { mode: "unknown", role: "admin" });

  await authenticatePage(page, user.token, "/app/remote-hosts");
  await expect(page.getByRole("heading", { name: "Remote Hosts are unavailable" })).toBeVisible();
  await expect(page.getByLabel("SSH host")).toHaveCount(0);
  await expect(page.getByLabel("SSH private key")).toHaveCount(0);

  await openMigrationControls(page, user.token);
  await expect(page.getByRole("button", { name: /live pull/i })).toHaveCount(0);
});
