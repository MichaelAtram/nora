import { expect, test } from "@playwright/test";

test.describe("Getting started capabilities", () => {
  test("hides the local Docker demo action on Kubernetes-only deployments", async ({ page }) => {
    let activationRequested = false;
    const consoleErrors: string[] = [];
    const httpFailures: string[] = [];

    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => consoleErrors.push(error.message));
    page.on("response", (response) => {
      if (response.status() >= 400) httpFailures.push(`${response.status()} ${response.url()}`);
    });

    await page.route("**/api/auth/me", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: "operator-1", email: "operator@example.com", role: "admin" }),
      });
    });
    await page.route("**/api/config/platform", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          mode: "selfhosted",
          enabledDeployTargets: ["k8s"],
          systemBanner: null,
          language: { defaultLocale: "en" },
        }),
      });
    });
    await page.route("**/api/agents/activate-demo", async (route) => {
      activationRequested = true;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Activation should not be called" }),
      });
    });
    await page.route("**/api/llm-providers", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.route("**/api/agents", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.route("**/api/workspaces", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });

    await page.goto("/app/getting-started");

    const demoButton = page.getByRole("button", { name: /local docker demo unavailable/i });
    await expect(demoButton).toBeDisabled();
    await expect(page.getByTestId("demo-activation-unavailable")).toContainText(
      /does not enable the local Docker target/i,
    );
    expect(activationRequested).toBe(false);
    expect(consoleErrors).toEqual([]);
    expect(httpFailures).toEqual([]);
  });
});
