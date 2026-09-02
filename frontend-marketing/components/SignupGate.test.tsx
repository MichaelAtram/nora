import assert from "node:assert/strict";
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
