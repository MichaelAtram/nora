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

const signupBody = {
  required: true,
  content: {
    "application/json": {
      schema: {
        ...credentialsBody.content["application/json"].schema,
        properties: {
          ...credentialsBody.content["application/json"].schema.properties,
          botProtectionToken: {
            type: "string",
            description:
              "Turnstile or reCAPTCHA token when signup bot protection is enabled by the operator.",
          },
        },
      },
    },
  },
};

module.exports = {
  "/auth/bootstrap-status": {
    get: {
      tags: ["Auth"],
      summary: "Public runtime authentication bootstrap status",
      description:
        "True until the first user registers (who becomes the platform admin), plus safe runtime OAuth, platform-mode, and signup-challenge metadata. Public; never exposes verification secrets.",
      security: [],
      responses: ok("Status", {
        type: "object",
        required: ["needsFirstAdmin", "oauthLoginEnabled", "platformMode", "signupBotProtection"],
        properties: {
          needsFirstAdmin: { type: "boolean" },
          oauthLoginEnabled: { type: "boolean" },
          platformMode: { type: "string", enum: ["selfhosted", "paas"] },
          signupBotProtection: {
            type: "object",
            required: ["enabled", "provider", "siteKey", "configured", "configurationError"],
            properties: {
              enabled: { type: "boolean" },
              provider: {
                type: ["string", "null"],
                enum: ["none", "turnstile", "recaptcha", null],
              },
              siteKey: { type: ["string", "null"] },
              configured: { type: "boolean" },
              configurationError: { type: ["string", "null"] },
            },
          },
        },
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
      requestBody: signupBody,
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
