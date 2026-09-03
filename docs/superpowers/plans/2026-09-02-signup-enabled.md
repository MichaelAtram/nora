# Runtime Signup Availability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a default-enabled `SIGNUP_ENABLED` runtime switch that blocks new password and OAuth registrations while preserving existing-account login and presenting a consistent disabled state in the public UI.

**Architecture:** The backend parses the environment at request time, publishes the effective boolean through auth bootstrap metadata, and rejects every new-account path when disabled. The marketing frontend loads that metadata once through a context provider, gates all signup calls to action, and replaces the direct signup form with an operator-disabled message. Setup, validation, OpenAPI, and operator documentation carry the same contract.

**Tech Stack:** Express 5, Jest/Supertest, Next.js 16, React 19, TypeScript/tsx with Node's test runner, Bash/PowerShell setup scripts, OpenAPI, Docker Compose.

---

### Task 1: Backend password-signup availability contract

**Files:**

- Modify: `backend-api/__tests__/auth.test.ts`
- Modify: `backend-api/routes/auth.ts`

- [ ] **Step 1: Write failing parser, bootstrap, and password-signup tests**

Add `delete process.env.SIGNUP_ENABLED` to the existing top-level `beforeEach`. Add these helper tests:

```js
describe("signup availability", () => {
  it("defaults signup to enabled when SIGNUP_ENABLED is absent or blank", () => {
    delete process.env.SIGNUP_ENABLED;
    expect(authRouteTestHelpers.isSignupEnabled()).toBe(true);
    process.env.SIGNUP_ENABLED = "   ";
    expect(authRouteTestHelpers.isSignupEnabled()).toBe(true);
  });

  it.each(["true", "1", "YES", " on "])("enables signup for %s", (value) => {
    process.env.SIGNUP_ENABLED = value;
    expect(authRouteTestHelpers.isSignupEnabled()).toBe(true);
  });

  it.each(["false", "0", "NO", " off ", "invalid"])("disables signup for %s", (value) => {
    process.env.SIGNUP_ENABLED = value;
    expect(authRouteTestHelpers.isSignupEnabled()).toBe(false);
  });
});
```

Extend existing bootstrap payload expectations with `signupEnabled: true`, then add a disabled case that expects `signupEnabled: false` and `needsFirstAdmin: false`. Add a `POST /auth/signup` test that sets `SIGNUP_ENABLED=false`, sends invalid input, expects HTTP `403` with `{ error: "Registration is disabled by this Nora operator.", code: "SIGNUP_DISABLED" }`, and asserts bcrypt/database calls were not made.

- [ ] **Step 2: Run the auth test and verify RED**

Run: `npm test -- --runInBand __tests__/auth.test.ts`

Working directory: `backend-api`

Expected: FAIL because `isSignupEnabled` and `signupEnabled` do not exist and disabled signup still reaches validation.

- [ ] **Step 3: Implement the minimal backend contract**

Add to `backend-api/routes/auth.ts`:

```js
const SIGNUP_DISABLED_CODE = "SIGNUP_DISABLED";
const SIGNUP_DISABLED_MESSAGE = "Registration is disabled by this Nora operator.";
const SIGNUP_ENABLED_VALUES = new Set(["true", "1", "yes", "on"]);

function isSignupEnabled(value = process.env.SIGNUP_ENABLED) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!normalized) return true;
  return SIGNUP_ENABLED_VALUES.has(normalized);
}

function sendSignupDisabled(res) {
  return res.status(403).json({ error: SIGNUP_DISABLED_MESSAGE, code: SIGNUP_DISABLED_CODE });
}
```

Publish `signupEnabled` from `/bootstrap-status`, include it in the `needsFirstAdmin` expression, and make `if (!isSignupEnabled()) return sendSignupDisabled(res);` the first statement in the signup handler. Export `isSignupEnabled` through the existing `__test` object.

- [ ] **Step 4: Run the auth test and verify GREEN**

Run: `npm test -- --runInBand __tests__/auth.test.ts`

Working directory: `backend-api`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend-api/routes/auth.ts backend-api/__tests__/auth.test.ts
git commit -m "feat(auth): add runtime signup availability gate"
```

### Task 2: Prevent OAuth registration while preserving OAuth login

**Files:**

- Modify: `backend-api/__tests__/auth.test.ts`
- Modify: `backend-api/routes/auth.ts`

- [ ] **Step 1: Write failing OAuth distinction tests**

Under `OAuth hardening`, add a new-user case that enables OAuth, disables signup, returns a verified Google identity, and supplies four empty query results for `BEGIN`, the advisory lock, linked-account lookup, and email lookup. Expect HTTP `403`, code `SIGNUP_DISABLED`, and no `INSERT INTO users`. Add an existing-user control with query results for `BEGIN`, the advisory lock, the linked user, the same email user, the upsert return row, and `COMMIT`; set `SIGNUP_ENABLED=false` and assert HTTP `200` plus a valid JWT for that existing user.

```js
expect(res.status).toBe(403);
expect(res.body).toEqual({
  error: "Registration is disabled by this Nora operator.",
  code: "SIGNUP_DISABLED",
});
expect(mockDb.query).not.toHaveBeenCalledWith(
  expect.stringMatching(/INSERT INTO users/i),
  expect.anything(),
);
```

- [ ] **Step 2: Run the OAuth tests and verify RED**

Run: `npm test -- --runInBand __tests__/auth.test.ts -t "OAuth hardening"`

Working directory: `backend-api`

Expected: the new-user case FAILS because OAuth still upserts an account; the existing-user control passes.

- [ ] **Step 3: Add the transactional new-user guard**

After linked-account and email-account lookups, before `nextRegisteredUserRole`, add:

```js
if (!linkedUser && !existingUser && !isSignupEnabled()) {
  const error = new Error(SIGNUP_DISABLED_MESSAGE);
  error.statusCode = 403;
  error.code = SIGNUP_DISABLED_CODE;
  throw error;
}
```

Handle `SIGNUP_DISABLED_CODE` in the route catch through `sendSignupDisabled(res)`. Do not block OAuth before identity verification/account lookup, because an existing linked OAuth user must still authenticate.

- [ ] **Step 4: Run the complete auth suite and verify GREEN**

Run: `npm test -- --runInBand __tests__/auth.test.ts`

Working directory: `backend-api`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend-api/routes/auth.ts backend-api/__tests__/auth.test.ts
git commit -m "fix(auth): close OAuth registration when signup is disabled"
```

### Task 3: Publish and parse one shared frontend contract

**Files:**

- Modify: `frontend-marketing/package.json`
- Create: `frontend-marketing/lib/authBootstrap.test.ts`
- Modify: `frontend-marketing/lib/authBootstrap.ts`
- Create: `frontend-marketing/components/AuthBootstrapProvider.tsx`
- Create: `frontend-marketing/components/SignupGate.tsx`
- Create: `frontend-marketing/components/SignupGate.test.tsx`
- Modify: `frontend-marketing/pages/_app.tsx`

- [ ] **Step 1: Add a test command and failing tests**

Add `"test": "tsx --test lib/*.test.ts components/*.test.tsx"` to the marketing scripts. In `authBootstrap.test.ts`, build the existing valid bootstrap fixture plus `signupEnabled: true`; assert parsing returns the boolean, and assert missing/non-boolean values throw `/signup availability/i`.

In `SignupGate.test.tsx`, render with `react-dom/server` and the exported context:

```tsx
test("renders children only when signup is explicitly enabled", () => {
  const enabled = renderToStaticMarkup(
    <AuthBootstrapContext.Provider value={{ status: validStatus, error: "", loading: false }}>
      <SignupGate>
        <a href="/signup">Create Account</a>
      </SignupGate>
    </AuthBootstrapContext.Provider>,
  );
  const disabled = renderToStaticMarkup(
    <AuthBootstrapContext.Provider
      value={{ status: { ...validStatus, signupEnabled: false }, error: "", loading: false }}
    >
      <SignupGate>
        <a href="/signup">Create Account</a>
      </SignupGate>
    </AuthBootstrapContext.Provider>,
  );
  assert.match(enabled, /Create Account/);
  assert.equal(disabled, "");
});
```

Add a `status: null` case expecting an empty string.

- [ ] **Step 2: Run marketing tests and verify RED**

Run: `npm test`

Working directory: `frontend-marketing`

Expected: FAIL because `signupEnabled`, `AuthBootstrapContext`, and `SignupGate` do not exist.

- [ ] **Step 3: Implement parser, provider, and gate**

Add `signupEnabled: boolean` to `AuthBootstrapStatus`; validate `raw.signupEnabled` before bot-protection parsing and return it. Create an `AuthBootstrapProvider` exporting this context and `useAuthBootstrap()`:

```tsx
export type AuthBootstrapContextValue = {
  status: AuthBootstrapStatus | null;
  error: string;
  loading: boolean;
};

export const AuthBootstrapContext = createContext<AuthBootstrapContextValue>({
  status: null,
  error: "",
  loading: true,
});
```

The provider uses one effect, an `AbortController`, and `fetchAuthBootstrapStatus`; failures retain `status=null`, set an error, and stop loading. `SignupGate` returns its children only when `status?.signupEnabled === true`. Wrap the current `_app.tsx` provider tree in `AuthBootstrapProvider`.

- [ ] **Step 4: Run tests and typecheck; verify GREEN**

Run: `npm test && npm run typecheck`

Working directory: `frontend-marketing`

Expected: both commands PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend-marketing/package.json frontend-marketing/lib/authBootstrap.ts frontend-marketing/lib/authBootstrap.test.ts frontend-marketing/components/AuthBootstrapProvider.tsx frontend-marketing/components/SignupGate.tsx frontend-marketing/components/SignupGate.test.tsx frontend-marketing/pages/_app.tsx
git commit -m "feat(marketing): share runtime signup availability"
```

### Task 4: Hide registration CTAs and render the disabled page

**Files:**

- Modify: `frontend-marketing/pages/index.tsx`
- Modify: `frontend-marketing/pages/login.tsx`
- Modify: `frontend-marketing/pages/pricing.tsx`
- Modify: `frontend-marketing/pages/privacy.tsx`
- Modify: `frontend-marketing/pages/terms.tsx`
- Modify: `frontend-marketing/pages/signup.tsx`
- Modify: `frontend-marketing/components/SignupGate.test.tsx`

- [ ] **Step 1: Write failing public-page inventory tests**

Extend `SignupGate.test.tsx` to read the five CTA pages and assert every JSX signup destination is enclosed by `SignupGate`. Assert current per-page gated counts: index 5, login 2, pricing 2, privacy 1, terms 1. Assert `signup.tsx` contains the exact disabled heading/message and a `signupEnabled === false` branch.

```tsx
const expectedCounts = {
  "index.tsx": 5,
  "login.tsx": 2,
  "pricing.tsx": 2,
  "privacy.tsx": 1,
  "terms.tsx": 1,
};
for (const [page, count] of Object.entries(expectedCounts)) {
  const source = readFileSync(path.join(pagesDir, page), "utf8");
  assert.equal((source.match(/<SignupGate>/g) || []).length, count);
}
```

- [ ] **Step 2: Run the inventory test and verify RED**

Run: `npm test -- --test-name-pattern "public signup"`

Working directory: `frontend-marketing`

Expected: FAIL because CTAs are unconditional and `/signup` has no disabled branch.

- [ ] **Step 3: Gate public signup calls to action**

Import `SignupGate` and wrap each current `/signup` or `DEMO_SIGNUP_PATH` link in the five pages, retaining the existing child link and classes exactly:

```tsx
<SignupGate>
  <Link
    href="/signup"
    className="rounded-full bg-brand-cyan px-4 py-2 text-sm font-black text-brand-ink shadow-lg shadow-brand-cyan/25 transition-transform hover:-translate-y-0.5"
  >
    Create Account
  </Link>
</SignupGate>
```

Replace the local bootstrap-fetch effects in `login.tsx` and `signup.tsx` with `useAuthBootstrap()` so `_app.tsx` is the only bootstrap loader.

- [ ] **Step 4: Render the direct disabled-registration state**

Derive `const signupDisabled = bootstrapStatus?.signupEnabled === false`. When true, replace the entire form card with:

```tsx
<h2>Registration is disabled</h2>
<p>This Nora operator is not accepting new accounts. Contact the administrator for access.</p>
<Link href="/login">Return to login</Link>
```

Do not render password inputs, OAuth signup controls, bot-challenge widgets, or submit controls in this branch. Preserve existing loading/configuration-error behavior while status is unknown.

- [ ] **Step 5: Run tests, typecheck, and build**

Run: `npm test && npm run typecheck && npm run build`

Working directory: `frontend-marketing`

Expected: all commands PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend-marketing/pages frontend-marketing/components/SignupGate.test.tsx
git commit -m "feat(marketing): hide registration when disabled"
```

### Task 5: Persist configuration and skip irrelevant PaaS preflight

**Files:**

- Modify: `scripts/infra-security.test.mjs`
- Modify: `.env.example`
- Modify: `setup.sh`
- Modify: `setup.ps1`
- Modify: `scripts/validate-paas-signup-protection.sh`

- [ ] **Step 1: Write failing setup and validator tests**

Add an infra test asserting `.env.example` contains `SIGNUP_ENABLED=true`, both setup scripts read it with default `true`, and both generated environment templates emit it. In the existing PaaS validator test, add:

```js
const signupClosed = run([
  "PLATFORM_MODE=paas",
  "SIGNUP_ENABLED=false",
  "SIGNUP_BOT_PROTECTION_PROVIDER=none",
]);
assert.equal(signupClosed.status, 0, signupClosed.stderr || signupClosed.stdout);
```

- [ ] **Step 2: Run infra tests and verify RED**

Run: `node --test scripts/infra-security.test.mjs`

Working directory: repository root

Expected: FAIL because setup omits the setting and the hosted validator still requires a challenge.

- [ ] **Step 3: Implement setup persistence and validation bypass**

Add `SIGNUP_ENABLED=true` above signup limits in `.env.example`. Make both setup scripts read the existing value with default `true`, preserve it in update helpers, and emit it in generated environment content. In `validate-paas-signup-protection.sh`, read with default `true` and exit successfully for normalized `false`, `0`, `no`, or `off` after confirming PaaS mode; invalid values must not bypass validation.

- [ ] **Step 4: Run infrastructure validation and verify GREEN**

Run: `npm run ci:validate-infra`

Working directory: repository root

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .env.example setup.sh setup.ps1 scripts/validate-paas-signup-protection.sh scripts/infra-security.test.mjs
git commit -m "feat(setup): persist signup availability setting"
```

### Task 6: Document the API and operator setting

**Files:**

- Modify: `backend-api/__tests__/openapi.test.ts`
- Modify: `backend-api/openapi/paths/auth.js`
- Modify: `docs/configuration/environment-variables.mdx`
- Modify: `docs/api/authentication.mdx`
- Modify: `docs/superpowers/specs/2026-09-02-signup-enabled-design.md`

- [ ] **Step 1: Write failing OpenAPI assertions**

Extend the bootstrap OpenAPI test:

```js
expect(bootstrapSchema.required).toContain("signupEnabled");
expect(bootstrapSchema.properties.signupEnabled).toEqual({ type: "boolean" });
expect(doc.paths["/auth/signup"].post.responses[403]).toEqual(
  expect.objectContaining({ description: expect.stringMatching(/disabled/i) }),
);
```

- [ ] **Step 2: Run the OpenAPI test and verify RED**

Run: `npm test -- --runInBand __tests__/openapi.test.ts -t "runtime auth bootstrap"`

Working directory: `backend-api`

Expected: FAIL because the boolean and disabled response are absent.

- [ ] **Step 3: Update OpenAPI and docs**

Add required boolean `signupEnabled` to bootstrap status and document `403` on password/OAuth registration. Add this environment row:

```mdx
| `SIGNUP_ENABLED` | No | `true` | Set to `false` to reject new password and OAuth registrations and hide public signup actions. Existing-account login remains available. |
```

Document accepted boolean values, invalid-value fail-closed behavior, the hosted-preflight exemption, `SIGNUP_DISABLED`, and the fact that existing OAuth-linked users can still authenticate.

- [ ] **Step 4: Run OpenAPI and formatting checks**

Run: `npm test -- --runInBand __tests__/openapi.test.ts`

Working directory: `backend-api`

Then run from repository root: `npm run ci:format:check -- backend-api/openapi/paths/auth.js backend-api/__tests__/openapi.test.ts docs/configuration/environment-variables.mdx docs/api/authentication.mdx`

Expected: both commands PASS.

- [ ] **Step 5: Commit**

```bash
git add backend-api/openapi/paths/auth.js backend-api/__tests__/openapi.test.ts docs/configuration/environment-variables.mdx docs/api/authentication.mdx docs/superpowers/specs/2026-09-02-signup-enabled-design.md
git commit -m "docs(auth): document signup availability"
```

### Task 7: Verify, review, push, and open the requested PR

**Files:**

- Verify: all modified files
- Read: `.github/pull_request_template.md`

- [ ] **Step 1: Run focused verification**

```bash
(cd backend-api && npm test -- --runInBand __tests__/auth.test.ts __tests__/openapi.test.ts)
(cd frontend-marketing && npm test && npm run typecheck && npm run build)
npm run ci:validate-infra
```

Expected: all commands PASS.

- [ ] **Step 2: Run repository-wide checks**

```bash
(cd backend-api && npm test -- --runInBand)
(cd backend-api && npm run typecheck)
npm run ci:lint
npm run ci:format:check
npm run ci:secret-scan
git diff --check michael-branch...HEAD
```

Expected: all commands PASS with no warnings or failures.

- [ ] **Step 3: Request code review**

Use the code-review workflow with base `michael-branch`, head `feat/signup-enabled`, the approved design, and full diff. Fix every Critical or Important finding; add a failing regression test before any behavior fix and rerun affected checks.

- [ ] **Step 4: Re-run final verification after review**

Repeat focused verification and every repository-wide command affected by review changes. Commit review fixes and confirm `git status --short` is empty.

- [ ] **Step 5: Push and create the PR**

```bash
git push -u origin feat/signup-enabled
gh pr create --base michael-branch --head feat/signup-enabled --title "feat: add runtime signup availability control" --body-file /tmp/nora-signup-enabled-pr.md
```

Build the PR body from `.github/pull_request_template.md`, including security/compatibility notes, exact validation commands, and API/UI proof. Preserve the worktree for PR feedback.
