import assert from "node:assert/strict";
import test from "node:test";

import { CONNECT_FIELD_MASK, connectFieldDisplay, isSecretRevealed } from "./connectField";

test("secret fields are masked by default (not revealed)", () => {
  assert.equal(connectFieldDisplay("s3cret-password", { secret: true, revealed: false }), CONNECT_FIELD_MASK);
});

test("revealing a secret shows its real value", () => {
  assert.equal(connectFieldDisplay("s3cret-password", { secret: true, revealed: true }), "s3cret-password");
});

test("non-secret fields always show the real value", () => {
  assert.equal(connectFieldDisplay("http://100.71.115.105:19500", { secret: false }), "http://100.71.115.105:19500");
  assert.equal(connectFieldDisplay("nora", {}), "nora");
});

test("the mask is fixed-width and does not leak the secret's length", () => {
  assert.equal(
    connectFieldDisplay("short", { secret: true }),
    connectFieldDisplay("a-considerably-longer-secret-value", { secret: true }),
  );
});

test("a secret is revealed only for the exact value it was revealed for", () => {
  assert.equal(isSecretRevealed("v1", "v1"), true);
  assert.equal(isSecretRevealed(null, "v1"), false);
  assert.equal(isSecretRevealed("v1", "v2"), false);
});

test("rotating a revealed secret re-masks it (redeploy regenerates credentials)", () => {
  // The field was revealed for the old password; after rotation the value the
  // component holds differs, so it must be treated as not-revealed and re-masked.
  const revealed = isSecretRevealed("old-password", "new-password");
  assert.equal(revealed, false);
  assert.equal(connectFieldDisplay("new-password", { secret: true, revealed }), CONNECT_FIELD_MASK);
});

test("independent fields: revealing one value does not reveal a different one", () => {
  // Each field tracks its own "revealed-for" value; a value revealed in one
  // field is not revealed in a field holding a different value.
  const revealedForApiKey = "api-key-abc";
  assert.equal(isSecretRevealed(revealedForApiKey, "api-key-abc"), true);
  assert.equal(isSecretRevealed(revealedForApiKey, "dashboard-password-xyz"), false);
});
