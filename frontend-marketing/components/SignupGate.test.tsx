import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AuthBootstrapStatus } from "../lib/authBootstrap";
import { AuthBootstrapContext } from "./AuthBootstrapProvider";
import { SignupGate } from "./SignupGate";

const validStatus: AuthBootstrapStatus = {
  needsFirstAdmin: false,
  oauthLoginEnabled: true,
  platformMode: "paas",
  signupEnabled: true,
  signupBotProtection: {
    enabled: false,
    provider: "none",
    siteKey: null,
    configured: true,
    configurationError: null,
  },
};

function renderGate(status: AuthBootstrapStatus | null): string {
  return renderToStaticMarkup(
    <AuthBootstrapContext.Provider value={{ status, error: "", loading: false }}>
      <SignupGate>
        <a href="/signup">Create Account</a>
      </SignupGate>
    </AuthBootstrapContext.Provider>,
  );
}

test("renders children when signup availability is exactly true", () => {
  assert.match(renderGate(validStatus), /Create Account/);
});

test("renders nothing when signup is disabled", () => {
  assert.equal(renderGate({ ...validStatus, signupEnabled: false }), "");
});

test("renders nothing while bootstrap status is unavailable", () => {
  assert.equal(renderGate(null), "");
});

test("public signup destinations are all enclosed by SignupGate", () => {
  const pages = [
    { name: "index.tsx", expectedCount: 5, destination: String.raw`\{DEMO_SIGNUP_PATH\}` },
    { name: "login.tsx", expectedCount: 2, destination: '"/signup"' },
    { name: "pricing.tsx", expectedCount: 2, destination: '"/signup"' },
    { name: "privacy.tsx", expectedCount: 1, destination: '"/signup"' },
    { name: "terms.tsx", expectedCount: 1, destination: '"/signup"' },
  ];

  for (const { name, expectedCount, destination } of pages) {
    const source = readFileSync(path.join(process.cwd(), "pages", name), "utf8");
    const signupDestination = new RegExp(
      String.raw`<Link\b[^>]*\bhref=${destination}[^>]*>`,
      "g",
    );
    const gatedSignupDestination = new RegExp(
      String.raw`<SignupGate>\s*<Link\b(?=[^>]*\bhref=${destination})[^>]*>[\s\S]*?<\/Link>\s*<\/SignupGate>`,
      "g",
    );

    assert.equal(
      source.match(signupDestination)?.length ?? 0,
      expectedCount,
      `${name} signup destination inventory changed`,
    );
    assert.equal(
      source.match(/<SignupGate>/g)?.length ?? 0,
      expectedCount,
      `${name} must contain exactly ${expectedCount} SignupGate wrappers`,
    );
    assert.equal(
      source.match(gatedSignupDestination)?.length ?? 0,
      expectedCount,
      `${name} has a signup destination outside its SignupGate wrapper`,
    );
  }
});

test("public signup page has an explicit disabled-registration branch", () => {
  const source = readFileSync(path.join(process.cwd(), "pages", "signup.tsx"), "utf8");

  assert.match(source, /signupEnabled\s*===\s*false/);
  assert.match(source, />Registration is disabled<\/h2>/);
  assert.match(
    source,
    />This Nora operator is not accepting new accounts\. Contact the administrator for access\.<\/p>/,
  );
});
