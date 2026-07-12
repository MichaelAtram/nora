import { expect, test } from "@playwright/test";

test.describe("Auth gates", () => {
  test("signup renders runtime Turnstile configuration and submits its token", async ({ page }) => {
    let signupPayload: Record<string, unknown> | null = null;

    await page.route("**/api/auth/bootstrap-status", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          needsFirstAdmin: false,
          oauthLoginEnabled: true,
          platformMode: "paas",
          signupBotProtection: {
            enabled: true,
            provider: "turnstile",
            siteKey: "runtime-turnstile-site-key",
            configured: true,
            configurationError: null,
          },
        }),
      });
    });
    await page.route(
      /https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js.*/,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/javascript",
          body: `
            window.turnstile = {
              render(container, options) {
                container.textContent = "Simulated Turnstile challenge";
                container.dataset.sitekey = String(options.sitekey || "");
                queueMicrotask(() => options.callback("simulated-turnstile-token"));
                return "simulated-turnstile-widget";
              },
              reset() {}
            };
          `,
        });
      },
    );
    await page.route("**/api/auth/signup", async (route) => {
      signupPayload = route.request().postDataJSON();
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: "Simulated signup stop" }),
      });
    });

    await page.goto("/signup");
    await expect(page.getByText(/this hosted Nora instance/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /continue with google/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /continue with github/i })).toBeVisible();
    const challenge = page.getByTestId("signup-bot-protection");
    await expect(challenge).toContainText("Simulated Turnstile challenge");
    await expect(challenge.locator("[data-sitekey='runtime-turnstile-site-key']")).toBeVisible();

    await page.getByLabel(/email address/i).fill("runtime-protection@example.com");
    await page.getByLabel(/^password$/i).fill("validpassword123");
    const submit = page.getByRole("button", { name: /create account/i });
    await expect(submit).toBeEnabled();
    await submit.click();

    await expect(page.getByText("Simulated signup stop")).toBeVisible();
    expect(signupPayload).toMatchObject({
      email: "runtime-protection@example.com",
      password: "validpassword123",
      botProtectionToken: "simulated-turnstile-token",
    });
  });

  test("signup fails closed when runtime public challenge configuration is incomplete", async ({
    page,
  }) => {
    let providerScriptRequested = false;
    await page.route("**/api/auth/bootstrap-status", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          needsFirstAdmin: false,
          oauthLoginEnabled: false,
          platformMode: "selfhosted",
          signupBotProtection: {
            enabled: true,
            provider: "turnstile",
            siteKey: null,
            configured: false,
            configurationError:
              "Signup verification is enabled, but its public site key is missing. Contact the administrator.",
          },
        }),
      });
    });
    await page.route(
      /https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js.*/,
      async (route) => {
        providerScriptRequested = true;
        await route.abort();
      },
    );

    await page.goto("/signup");

    await expect(page.getByTestId("signup-protection-configuration-error")).toContainText(
      /public site key is missing/i,
    );
    await expect(page.getByRole("button", { name: /create account/i })).toBeDisabled();
    expect(providerScriptRequested).toBe(false);
  });

  test("login renders OAuth and hosted copy from runtime bootstrap metadata", async ({ page }) => {
    await page.route("**/api/auth/bootstrap-status", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          needsFirstAdmin: false,
          oauthLoginEnabled: true,
          platformMode: "paas",
          signupBotProtection: {
            enabled: false,
            provider: "none",
            siteKey: null,
            configured: true,
            configurationError: null,
          },
        }),
      });
    });

    await page.goto("/login");

    await expect(page.getByText(/this hosted instance is new for you/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /continue with google/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /continue with github/i })).toBeVisible();
    await expect(page.getByText(/or use email/i)).toBeVisible();
  });

  test("login rejects invalid credentials", async ({ page }) => {
    await page.goto("/login");
    await expect(
      page.getByRole("heading", { name: /log in to your operator account/i }),
    ).toBeVisible();

    await page.getByLabel(/email address/i).fill("invalid@example.com");
    await page.getByLabel(/^password$/i).fill("not-the-right-password");
    await page.getByRole("button", { name: /^log in$/i }).click();

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByText(/invalid email or password|login failed/i)).toBeVisible();
  });

  test("operator and admin surfaces require authentication", async ({ page }) => {
    await page.goto("/app/dashboard");
    await page.waitForURL(/\/login$/, { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: /log in to your operator account/i }),
    ).toBeVisible();

    await page.goto("/admin");
    await page.waitForURL(/\/login$/, { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: /log in to your operator account/i }),
    ).toBeVisible();
  });

  test("localized operator and admin auth gates preserve locale", async ({ page }) => {
    await page.goto("/app/es/dashboard");
    await page.waitForURL(/\/es\/login$/, { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: /inicia sesion en tu cuenta de operador/i }),
    ).toBeVisible();

    await page.goto("/admin/fr");
    await page.waitForURL(/\/fr\/login$/, { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: /connectez-vous a votre compte operateur/i }),
    ).toBeVisible();

    await page.goto("/app/zh-Hans/dashboard");
    await page.waitForURL(/\/zh-Hans\/login$/, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: /登录您的操作员账户/i })).toBeVisible();

    await page.goto("/admin/zh-Hant");
    await page.waitForURL(/\/zh-Hant\/login$/, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: /登入您的操作員帳戶/i })).toBeVisible();
  });
});
