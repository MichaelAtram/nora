# Runtime Signup Availability Design

## Goal

Add an operator-controlled `SIGNUP_ENABLED` environment variable that defaults to `true`. When set to `false`, Nora must reject public account creation at the backend, hide public registration links and buttons, and explain that registration is disabled when someone visits `/signup` directly.

## Implementation status

Implemented across the backend auth routes and OpenAPI contract, the marketing bootstrap parser and
signup UI, Bash and PowerShell setup paths, Compose/Helm wiring, hosted-PaaS preflight, and operator
documentation.

- The public call-to-action inventory covers the homepage, login, Privacy, Terms, and Pricing pages,
  including Pricing's data-driven "Create account" link as well as its direct signup links.
- Frontend tests exercise rendered enabled, disabled, loading, and bootstrap-error behavior. They
  verify that registration controls are absent unless signup is confirmed enabled and that the
  disabled state retains a route back to login.
- Setup preserves the existing `SIGNUP_ENABLED` value when refreshing an environment. Its env
  readers select the last assignment when duplicate keys are present, including quoted values, so
  an operator's final override is retained.

Validation under Node 24 passes the backend auth suite (79 tests), the complete OpenAPI suite (22
tests), and the marketing bootstrap/signup suite (15 tests). Infrastructure validation passes the
signup-specific setup-persistence and hosted-PaaS preflight cases. The repository-wide
infrastructure suite is not a clean baseline on this macOS checkout: 9 unrelated setup/OS-sensitive
tests fail and 4 PowerShell-dependent tests are skipped; the structural PowerShell last-assignment
regression check still passes.

## Configuration contract

- `SIGNUP_ENABLED` is evaluated by the backend at runtime so the same published frontend images can be reused across deployments.
- The variable defaults to enabled when it is absent, preserving the behavior of existing installations.
- Values are parsed using Nora's conventional environment-boolean forms. A missing or empty value defaults to enabled; `true`, `1`, `yes`, and `on` enable signup; and `false`, `0`, `no`, and `off` disable it. An unrecognized non-empty value fails closed by disabling signup.
- `.env.example`, setup-generated environment files, Docker Compose runtime wiring, and the environment-variable documentation expose the setting with a default of `true`.
- Hosted-PaaS signup-challenge preflight is skipped when signup is explicitly disabled, because no public registration request can reach challenge verification.

## Backend behavior

The auth module owns signup availability because it already owns the public signup endpoint and bootstrap-status response.

- `GET /auth/bootstrap-status` adds a required boolean `signupEnabled` property.
- `POST /auth/signup` checks availability before validating input, invoking bot protection, hashing passwords, or querying/inserting users.
- When disabled, signup returns HTTP `403` with a stable machine-readable code, `SIGNUP_DISABLED`, and a human-readable message explaining that registration is disabled by the operator.
- `POST /auth/oauth-login` continues to authenticate an existing linked OAuth user, but returns the same `403` response instead of inserting a new user when signup is disabled.
- Password login remains available. Existing users and sessions are unaffected.
- First-user administrator claiming remains available only while signup is enabled; disabling signup prevents an unclaimed installation from being claimed through the public endpoint.

The OpenAPI contract is updated alongside the route behavior.

## Frontend behavior

The public bootstrap-status parser carries `signupEnabled` to the marketing frontend. Public pages that offer registration use a shared availability hook/component rather than implementing their own environment assumptions.

- While availability is loading or cannot be confirmed, signup calls to action remain hidden. The backend remains the security boundary regardless of frontend state.
- When signup is enabled, current registration links and buttons render unchanged.
- When signup is disabled, public registration links and buttons are omitted.
- A direct visit to `/signup` renders a non-interactive message telling the visitor that registration is disabled and to contact the administrator. The form, OAuth signup action, and submit controls are not rendered.
- Login links and login behavior remain available, including OAuth login for an existing linked OAuth account.

## Data flow

1. The backend reads `SIGNUP_ENABLED` at request time.
2. Public pages request `/api/auth/bootstrap-status` through the existing frontend proxy.
3. The frontend renders signup calls to action only when `signupEnabled` is explicitly `true`.
4. A signup submission still reaches the authoritative backend check, which rejects the request when disabled even if a client bypasses the UI.

## Error handling

- Disabled signup is an intentional authorization decision and returns `403`, not a server error.
- A bootstrap-status loading or parsing failure fails closed in the UI by withholding registration links and disabling the signup form.
- The existing generic bootstrap error remains visible on `/signup` for configuration failures unrelated to signup availability.

## Testing

Backend tests demonstrate that:

- signup remains enabled when `SIGNUP_ENABLED` is absent;
- accepted false-like values disable signup;
- disabled signup returns `403` and `SIGNUP_DISABLED` without creating a user;
- OAuth login still works for an existing linked account but cannot create a new account while signup is disabled;
- bootstrap status reports the effective boolean;
- enabled signup retains current account-creation behavior.

Frontend tests demonstrate that:

- bootstrap metadata requires and parses `signupEnabled`;
- registration calls to action appear only when signup is confirmed enabled;
- `/signup` shows the disabled-registration state without rendering or submitting the form.

Configuration and documentation tests confirm that installation paths preserve the default-enabled setting and that invalid hosted-PaaS values do not bypass signup-protection preflight.

## Scope exclusions

- This change does not add invitation codes, an administrator user-creation flow, or per-domain registration policy.
- It does not delete, suspend, or alter existing accounts when signup is disabled.
- It does not change password login, password reset, existing-account OAuth login, agent quotas, or instance ownership.
