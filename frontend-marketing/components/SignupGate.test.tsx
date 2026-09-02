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
  const pages: Array<{
    name: string;
    expectedCount: number;
    destination: string;
    dataDrivenDestination?: RegExp;
    gatedDataDrivenDestination?: RegExp;
  }> = [
    { name: "index.tsx", expectedCount: 5, destination: String.raw`\{DEMO_SIGNUP_PATH\}` },
    { name: "login.tsx", expectedCount: 2, destination: '"/signup"' },
    {
      name: "pricing.tsx",
      expectedCount: 3,
      destination: '"/signup"',
      dataDrivenDestination:
        /\{\s*label:\s*"Create account",\s*href:\s*SIGNUP_URL,\s*text:\s*"nora\.solomontsao\.com\/signup"\s*\}/g,
      gatedDataDrivenDestination:
        /item\.href\s*===\s*SIGNUP_URL\s*\?\s*\(\s*<SignupGate key=\{item\.label\}>\{entryLink\}<\/SignupGate>\s*\)\s*:\s*entryLink/g,
    },
    { name: "privacy.tsx", expectedCount: 1, destination: '"/signup"' },
    { name: "terms.tsx", expectedCount: 1, destination: '"/signup"' },
  ];

  for (const {
    name,
    expectedCount,
    destination,
    dataDrivenDestination,
    gatedDataDrivenDestination,
  } of pages) {
    const source = readFileSync(path.join(process.cwd(), "pages", name), "utf8");
    const signupDestination = new RegExp(
      String.raw`<Link\b[^>]*\bhref=${destination}[^>]*>`,
      "g",
    );
    const gatedSignupDestination = new RegExp(
      String.raw`<SignupGate>\s*<Link\b(?=[^>]*\bhref=${destination})[^>]*>[\s\S]*?<\/Link>\s*<\/SignupGate>`,
      "g",
    );

    const destinationCount =
      (source.match(signupDestination)?.length ?? 0) +
      (dataDrivenDestination ? (source.match(dataDrivenDestination)?.length ?? 0) : 0);
    const gatedDestinationCount =
      (source.match(gatedSignupDestination)?.length ?? 0) +
      (gatedDataDrivenDestination
        ? (source.match(gatedDataDrivenDestination)?.length ?? 0)
        : 0);

    assert.equal(
      destinationCount,
      expectedCount,
      `${name} signup destination inventory changed`,
    );
    assert.equal(
      gatedDestinationCount,
      expectedCount,
      `${name} has a signup destination outside its SignupGate wrapper`,
    );
    assert.equal(
      source.match(/<SignupGate(?:\s+key=\{item\.label\})?>/g)?.length ?? 0,
      expectedCount,
      `${name} must contain exactly ${expectedCount} SignupGate wrappers`,
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
