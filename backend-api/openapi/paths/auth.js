// @ts-nocheck
// Auth routes (mounted at /auth). Drift-checked against routes/auth.ts.
// These are session endpoints — API keys do not apply here.

const ok = (description, schema) => ({
  200: { description, ...(schema ? { content: { "application/json": { schema } } } : {}) },
});

const credentialsBody = {
  required: true,
  content: {
    "application/json": {
      schema: {
        type: "object",
        required: ["email", "password"],
        properties: {
          email: { type: "string", format: "email" },
          password: { type: "string", minLength: 8 },
        },
      },
    },
  },
};

module.exports = {
  "/auth/bootstrap-status": {
    get: {
      tags: ["Auth"],
      summary: "First-run claim check",
      description:
        "True until the first user registers (who becomes the platform admin). Public; exposes only the boolean.",
      security: [],
      responses: ok("Status", {
        type: "object",
        properties: { needsFirstAdmin: { type: "boolean" } },
      }),
    },
  },
  "/auth/signup": {
    post: {
      tags: ["Auth"],
      summary: "Create an operator account",
      description:
        "The first registered user becomes the platform admin. Rate-limited; optional bot-protection token when the operator configured Turnstile/reCAPTCHA.",
      security: [],
      requestBody: credentialsBody,
      responses: ok("Created user"),
    },
  },
  "/auth/login": {
    post: {
      tags: ["Auth"],
      summary: "Log in and receive a JWT + HttpOnly session cookie",
      security: [],
      requestBody: credentialsBody,
      responses: ok("Token + user"),
    },
  },
  "/auth/oauth-login": {
    post: {
      tags: ["Auth"],
      summary: "Exchange a verified OAuth identity for a Nora session",
      security: [],
      responses: ok("Token + user"),
    },
  },
  "/auth/logout": {
    post: {
      tags: ["Auth"],
      summary: "Clear the session cookie",
      security: [],
      responses: ok("Logout result"),
    },
  },
  "/auth/me": {
    get: {
      tags: ["Auth"],
      summary: "Current user profile",
      responses: ok("Profile"),
    },
  },
  "/auth/profile": {
    patch: {
      tags: ["Auth"],
      summary: "Update profile fields (name, preferred locale)",
      responses: ok("Updated profile"),
    },
  },
  "/auth/password": {
    patch: {
      tags: ["Auth"],
      summary: "Change password",
      responses: ok("Result"),
    },
  },
  "/auth/session-upgrade": {
    post: {
      tags: ["Auth"],
      summary: "Mirror a bearer-token session into the HttpOnly cookie",
      responses: ok("Result"),
    },
  },
};
