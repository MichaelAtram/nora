import assert from "node:assert/strict";
import test from "node:test";
import { parseAuthBootstrapStatus } from "./authBootstrap";

const validBootstrap = {
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

test("parses signup availability", () => {
  const result = parseAuthBootstrapStatus(validBootstrap);

  assert.equal(result.signupEnabled, true);
});

test("rejects missing signup availability", () => {
  const { signupEnabled: _signupEnabled, ...missingSignupEnabled } = validBootstrap;

  assert.throws(() => parseAuthBootstrapStatus(missingSignupEnabled), /signup availability/i);
});

test("rejects non-boolean signup availability", () => {
  assert.throws(
    () => parseAuthBootstrapStatus({ ...validBootstrap, signupEnabled: "yes" }),
    /signup availability/i,
  );
});
