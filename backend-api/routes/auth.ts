// @ts-nocheck
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const db = require("../db");
const { authenticateToken } = require("../middleware/auth");
const { setAuthCookie, clearAuthCookie } = require("../authCookie");
const { normalizeEmail, normalizeProvider, verifyOAuthIdentity } = require("../oauthProviders");
const {
  getLanguageSettings,
  parseRequiredLocale,
  resolvePreferredLocale,
} = require("../platformSettings");

const router = express.Router();
const FIRST_USER_ADMIN_LOCK_KEY = 20260408;
const DUPLICATE_SIGNUP_MESSAGE = "Account already exists for this email";
const SIGNUP_CHALLENGE_MESSAGE = "Complete the verification challenge and try again";
const TURNSTILE_SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const RECAPTCHA_SITEVERIFY_URL = "https://www.google.com/recaptcha/api/siteverify";

function isOAuthLoginEnabled() {
  return process.env.OAUTH_LOGIN_ENABLED === "true";
}

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts, please try again later" },
});

function parsePositiveIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const signupBurstLimiter = rateLimit({
  windowMs: parsePositiveIntegerEnv("SIGNUP_RATE_LIMIT_BURST_WINDOW_MS", 10 * 60 * 1000),
  max: parsePositiveIntegerEnv("SIGNUP_RATE_LIMIT_BURST_MAX", 5),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many signup attempts, please try again later" },
});

const signupDailyLimiter = rateLimit({
  windowMs: parsePositiveIntegerEnv("SIGNUP_RATE_LIMIT_DAILY_WINDOW_MS", 24 * 60 * 60 * 1000),
  max: parsePositiveIntegerEnv("SIGNUP_RATE_LIMIT_DAILY_MAX", 20),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many signup attempts, please try again later" },
});

function createHttpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeSignupBotProtectionProvider(value) {
  const provider = String(value || "")
    .trim()
    .toLowerCase();
  if (!provider) return "";
  if (["none", "turnstile", "recaptcha"].includes(provider)) return provider;
  return "invalid";
}

function getSignupBotProtectionConfig() {
  const explicitProvider = normalizeSignupBotProtectionProvider(
    process.env.SIGNUP_BOT_PROTECTION_PROVIDER,
  );

  if (explicitProvider === "none") return { provider: "none" };
  if (explicitProvider === "invalid") {
    return { provider: "invalid", error: "Invalid SIGNUP_BOT_PROTECTION_PROVIDER" };
  }

  const hasTurnstileSecret = Boolean(process.env.SIGNUP_TURNSTILE_SECRET);
  const hasRecaptchaSecret = Boolean(process.env.SIGNUP_RECAPTCHA_SECRET);
  let provider = explicitProvider;

  if (!provider) {
    if (hasTurnstileSecret && hasRecaptchaSecret) {
      return {
        provider: "invalid",
        error:
          "Both signup bot protection secrets are configured; set SIGNUP_BOT_PROTECTION_PROVIDER",
      };
    }
    if (hasTurnstileSecret) provider = "turnstile";
    if (hasRecaptchaSecret) provider = "recaptcha";
  }

  if (!provider) return { provider: "none" };

  const secret =
    provider === "turnstile"
      ? process.env.SIGNUP_TURNSTILE_SECRET
      : process.env.SIGNUP_RECAPTCHA_SECRET;

  if (!secret) {
    return {
      provider: "invalid",
      error: `Missing secret for signup ${provider} bot protection`,
    };
  }

  return { provider, secret };
}

function getSignupBotProtectionToken(body = {}) {
  return String(body.botProtectionToken || body.turnstileToken || body.recaptchaToken || "").trim();
}

async function verifySignupBotProtection(req) {
  const config = getSignupBotProtectionConfig();
  if (config.provider === "none") return;
  if (config.provider === "invalid") {
    throw createHttpError(config.error || "Signup bot protection is misconfigured", 500);
  }

  const token = getSignupBotProtectionToken(req.body);
  if (!token) throw createHttpError(SIGNUP_CHALLENGE_MESSAGE, 403);

  const body = new URLSearchParams({
    secret: config.secret,
    response: token,
  });
  if (req.ip) body.set("remoteip", req.ip);

  const endpoint =
    config.provider === "turnstile" ? TURNSTILE_SITEVERIFY_URL : RECAPTCHA_SITEVERIFY_URL;
  let verifyRes;
  let verifyData;
  try {
    verifyRes = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    verifyData = await verifyRes.json().catch(() => ({}));
  } catch {
    throw createHttpError(SIGNUP_CHALLENGE_MESSAGE, 403);
  }

  if (!verifyRes.ok || !verifyData?.success) {
    throw createHttpError(SIGNUP_CHALLENGE_MESSAGE, 403);
  }
}

// Precomputed bcrypt hash of a random high-entropy string. Used as a constant-
// time dummy comparison target when a login attempt references a non-existent
// user, so that timing does not reveal user existence. The plaintext is not
// stored and is not recoverable from this hash.
const DUMMY_BCRYPT_HASH = "$2a$10$CwTycUXWue0Thq9StjUM0uJ8hV7FNHZi8jN2xq9YhU7C2c4SaB2Vu";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function validateEmail(email) {
  if (!email || typeof email !== "string") return "Email is required";
  // Length check BEFORE regex so unbounded inputs can't drive backtracking cost.
  if (email.length > 255) return "Email too long";
  if (!EMAIL_RE.test(email)) return "Invalid email format";
  return null;
}
function validatePassword(pw) {
  if (!pw || typeof pw !== "string") return "Password is required";
  if (pw.length < 8) return "Password must be at least 8 characters";
  if (pw.length > 128) return "Password too long";
  return null;
}

async function withUserCreationLock(work) {
  const client = await db.connect();

  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [FIRST_USER_ADMIN_LOCK_KEY]);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Best-effort rollback only.
    }
    throw error;
  } finally {
    client.release();
  }
}

async function nextRegisteredUserRole(client) {
  const result = await client.query("SELECT EXISTS(SELECT 1 FROM users) AS has_users");
  return result.rows[0]?.has_users ? "user" : "admin";
}

async function findExistingUserByEmail(email) {
  const result = await db.query("SELECT id FROM users WHERE email=$1 LIMIT 1", [email]);
  return result.rows[0] || null;
}

function isDuplicateUserError(error) {
  return (
    error?.code === "23505" ||
    /duplicate key value/i.test(String(error?.message || "")) ||
    /unique constraint/i.test(String(error?.message || ""))
  );
}

// ─── Public routes ────────────────────────────────────────────────

// First-run claim check: true until the first user registers (who becomes the
// platform admin). The login/signup pages use it to render "Claim this server"
// instead of a generic signup. Deliberately exposes only a boolean — user
// count or emails would aid enumeration.
router.get("/bootstrap-status", async (req, res) => {
  try {
    const { rows } = await db.query("SELECT 1 FROM users LIMIT 1");
    res.json({ needsFirstAdmin: rows.length === 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/signup", signupBurstLimiter, signupDailyLimiter, async (req, res) => {
  const { email, password } = req.body;
  const normalizedEmail = normalizeEmail(email);
  const emailErr = validateEmail(normalizedEmail);
  if (emailErr) return res.status(400).json({ error: emailErr });
  const pwErr = validatePassword(password);
  if (pwErr) return res.status(400).json({ error: pwErr });
  try {
    await verifySignupBotProtection(req);
    const existingUser = await findExistingUserByEmail(normalizedEmail);
    if (existingUser) return res.status(409).json({ error: DUPLICATE_SIGNUP_MESSAGE });

    const hash = await bcrypt.hash(password, 10);
    const user = await withUserCreationLock(async (client) => {
      const role = await nextRegisteredUserRole(client);
      const result = await client.query(
        "INSERT INTO users(email, password_hash, role) VALUES($1, $2, $3) RETURNING id, email, role",
        [normalizedEmail, hash, role],
      );
      return result.rows[0];
    });
    res.json(user);
  } catch (e) {
    if (isDuplicateUserError(e)) {
      return res.status(409).json({ error: DUPLICATE_SIGNUP_MESSAGE });
    }
    const statusCode = e.statusCode || 500;
    if (statusCode >= 500) {
      console.error("Signup failed:", e.message);
      return res.status(500).json({ error: "Could not create account" });
    }
    res.status(statusCode).json({ error: e.message });
  }
});

router.post("/login", authLimiter, async (req, res) => {
  const { email, password } = req.body;
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail || !password)
    return res.status(400).json({ error: "Email and password required" });
  try {
    const result = await db.query("SELECT * FROM users WHERE email=$1", [normalizedEmail]);
    const user = result.rows[0];
    // Always run bcrypt.compare to keep response timing independent of whether
    // the email exists. Without this, a missing user returns ~100ms faster than
    // a wrong password, which lets attackers enumerate registered accounts.
    const hashToCompare = user && user.password_hash ? user.password_hash : DUMMY_BCRYPT_HASH;
    const passwordOk = await bcrypt.compare(password, hashToCompare);
    if (!user) return res.status(401).json({ error: "Invalid email or password" });
    if (!user.password_hash) {
      return res.status(401).json({
        error: `This account uses ${user.provider || "OAuth"} login. Please sign in with ${user.provider || "your OAuth provider"} instead.`,
      });
    }
    if (!passwordOk) return res.status(401).json({ error: "Invalid email or password" });
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "7d", algorithm: "HS256" },
    );
    setAuthCookie(res, token, req);
    res.json({ token });
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

router.post("/oauth-login", authLimiter, async (req, res, next) => {
  if (!isOAuthLoginEnabled()) {
    return res.status(403).json({
      error: "OAuth login is disabled until server-side provider verification is implemented",
    });
  }

  const { email, name, provider, providerId, oauthAccessToken, oauthIdToken } = req.body || {};

  const normalizedProvider = normalizeProvider(provider);
  if (!normalizedProvider) return res.status(400).json({ error: "provider required" });
  if (!oauthAccessToken && !oauthIdToken) {
    return res.status(400).json({ error: "oauthAccessToken or oauthIdToken required" });
  }

  try {
    const verified = await verifyOAuthIdentity({
      provider: normalizedProvider,
      accessToken: oauthAccessToken,
      idToken: oauthIdToken,
      email,
      providerId,
    });
    const normalizedVerifiedEmail = normalizeEmail(verified.email);

    const user = await withUserCreationLock(async (client) => {
      const linkedResult = await client.query(
        "SELECT id, email, role, name, provider, provider_id, password_hash FROM users WHERE provider = $1 AND provider_id = $2",
        [normalizedProvider, verified.providerId],
      );
      const linkedUser = linkedResult.rows[0];
      if (linkedUser && normalizeEmail(linkedUser.email) !== normalizedVerifiedEmail) {
        const error = new Error(
          `This ${normalizedProvider} account is already linked to another Nora user email.`,
        );
        error.statusCode = 409;
        throw error;
      }

      const existingResult = await client.query(
        "SELECT id, email, role, name, provider, provider_id, password_hash FROM users WHERE email = $1",
        [normalizedVerifiedEmail],
      );
      const existingUser = existingResult.rows[0];

      if (existingUser?.password_hash && !existingUser.provider) {
        const error = new Error(
          "This email already uses password login. Sign in with password until account linking exists.",
        );
        error.statusCode = 409;
        throw error;
      }
      if (existingUser?.provider && existingUser.provider !== normalizedProvider) {
        const error = new Error(
          `This account is already linked to ${existingUser.provider} login.`,
        );
        error.statusCode = 409;
        throw error;
      }
      if (
        existingUser?.provider_id &&
        String(existingUser.provider_id) !== String(verified.providerId)
      ) {
        const error = new Error(
          `This ${normalizedProvider} account is linked to a different Nora user.`,
        );
        error.statusCode = 409;
        throw error;
      }

      const role = existingUser?.role || (await nextRegisteredUserRole(client));
      const result = await client.query(
        `INSERT INTO users(email, name, provider, provider_id, role)
         VALUES($1, $2, $3, $4, $5)
         ON CONFLICT (email) DO UPDATE SET
           name = COALESCE(EXCLUDED.name, users.name),
           provider = COALESCE(EXCLUDED.provider, users.provider),
           provider_id = COALESCE(EXCLUDED.provider_id, users.provider_id)
         RETURNING id, email, role, name`,
        [
          normalizedVerifiedEmail,
          verified.name || name || null,
          normalizedProvider,
          verified.providerId,
          role,
        ],
      );
      return result.rows[0];
    });

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "7d", algorithm: "HS256" },
    );
    setAuthCookie(res, token, req);
    res.json({ token, user });
  } catch (e) {
    if (/Unsupported OAuth provider/i.test(e.message)) {
      return res.status(400).json({ error: e.message });
    }
    if (e.statusCode === 409) {
      return res.status(409).json({ error: e.message });
    }
    if (
      /verification failed|audience mismatch|email is not verified|email is missing or unverified|did not match|required/i.test(
        e.message,
      )
    ) {
      return res.status(401).json({ error: e.message });
    }
    next(e);
  }
});

// ─── Protected routes (require authenticateToken) ─────────────────

router.patch("/password", authenticateToken, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword)
      return res.status(400).json({ error: "Both passwords required" });
    const pwErr = validatePassword(newPassword);
    if (pwErr) return res.status(400).json({ error: pwErr });
    const user = (await db.query("SELECT * FROM users WHERE id = $1", [req.user.id])).rows[0];
    if (!user) return res.status(404).json({ error: "User not found" });
    if (!user.password_hash)
      return res.status(400).json({ error: "OAuth user — no password to change" });
    const ok = await bcrypt.compare(currentPassword, user.password_hash);
    if (!ok) return res.status(401).json({ error: "Current password is incorrect" });
    const hash = await bcrypt.hash(newPassword, 10);
    await db.query("UPDATE users SET password_hash = $1 WHERE id = $2", [hash, req.user.id]);
    res.json({ success: true });
  } catch (e) {
    next(e);
  }
});

router.get("/me", authenticateToken, async (req, res, next) => {
  try {
    const [result, languageSettings] = await Promise.all([
      db.query(
        "SELECT id, email, name, role, provider, avatar, preferred_locale, created_at FROM users WHERE id = $1",
        [req.user.id],
      ),
      getLanguageSettings(),
    ]);
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: "User not found" });
    const preferredLocale = user.preferred_locale || null;
    const defaultLocale = languageSettings.defaultLocale;
    res.json({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      provider: user.provider,
      avatar: user.avatar,
      preferredLocale,
      defaultLocale,
      effectiveLocale: resolvePreferredLocale(preferredLocale, defaultLocale),
      created_at: user.created_at,
    });
  } catch (e) {
    next(e);
  }
});

router.patch("/profile", authenticateToken, async (req, res) => {
  try {
    const body = req.body || {};
    const { name, avatar } = body;
    const updates = [];
    const values = [];
    let idx = 1;

    if (name !== undefined) {
      if (typeof name !== "string" || name.trim().length < 1 || name.trim().length > 100) {
        return res.status(400).json({ error: "Name must be 1-100 characters" });
      }
      updates.push(`name = $${idx++}`);
      values.push(name.trim());
    }

    if (avatar !== undefined) {
      if (avatar === null) {
        // Allow removing avatar
        updates.push(`avatar = $${idx++}`);
        values.push(null);
      } else if (typeof avatar === "string" && avatar.startsWith("data:image/")) {
        // Max ~500KB base64 (roughly 375KB image)
        if (avatar.length > 500000) {
          return res.status(400).json({ error: "Image too large. Max 500KB." });
        }
        updates.push(`avatar = $${idx++}`);
        values.push(avatar);
      } else {
        return res.status(400).json({ error: "Invalid avatar format" });
      }
    }

    if (Object.prototype.hasOwnProperty.call(body, "preferredLocale")) {
      if (body.preferredLocale === null) {
        updates.push(`preferred_locale = $${idx++}`);
        values.push(null);
      } else {
        updates.push(`preferred_locale = $${idx++}`);
        values.push(parseRequiredLocale(body.preferredLocale, "preferredLocale"));
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    values.push(req.user.id);
    const result = await db.query(
      `UPDATE users SET ${updates.join(", ")} WHERE id = $${idx} RETURNING name, avatar, preferred_locale`,
      values,
    );
    const updated = result.rows[0] || {};
    const languageSettings = await getLanguageSettings();
    const preferredLocale = updated.preferred_locale || null;
    res.json({
      name: updated.name,
      avatar: updated.avatar,
      preferredLocale,
      defaultLocale: languageSettings.defaultLocale,
      effectiveLocale: resolvePreferredLocale(preferredLocale, languageSettings.defaultLocale),
    });
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

// POST /auth/session-upgrade — upgrade a Bearer token into an HttpOnly cookie.
//
// Legacy bridge endpoint for older marketing auth flows that produced a
// backend-issued JWT server-side, then needed to upgrade it into the browser's
// HttpOnly session cookie. The token is re-verified here — a forged Bearer gets
// rejected.
//
// Path avoids /auth/session to remain compatible with older deployments that
// routed that path through the marketing app.
router.post("/session-upgrade", authenticateToken, (req, res) => {
  const authHeader = req.headers["authorization"] || "";
  const [, token] = authHeader.split(" ");
  if (!token) return res.status(400).json({ error: "Bearer token required" });
  setAuthCookie(res, token, req);
  res.json({ success: true });
});

// POST /auth/logout — clear the session cookie. No auth required so that a
// page holding a stale/invalid cookie can still clean itself up.
router.post("/logout", (req, res) => {
  clearAuthCookie(res, req);
  res.json({ success: true });
});

module.exports = router;
