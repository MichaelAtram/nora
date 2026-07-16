// @ts-nocheck
const jwt = require("jsonwebtoken");
const { readAuthCookie } = require("../authCookie");

// Session and API-key authentication

/**
 * Extract the preferred cookie session or a Bearer credential from a request.
 *
 * @param {Object} req - Express request.
 * @returns {string|null} Presented token, with the HttpOnly cookie taking precedence.
 */
function extractSessionToken(req) {
  // Cookie first — it's the preferred transport (HttpOnly, not JS-reachable).
  // Authorization header is still accepted for API clients, the embed flows,
  // and any legacy browser session that hasn't migrated yet.
  const cookieToken = readAuthCookie(req);
  if (cookieToken) return cookieToken;
  const authHeader = req.headers["authorization"] || "";
  const [scheme, token] = authHeader.split(" ");
  if (scheme === "Bearer" && token) return token;
  return null;
}

function tryDecodeSession(token) {
  if (!token) return null;
  try {
    return jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
  } catch {
    return null;
  }
}

/**
 * Authenticate an HS256 session or workspace API key and attach its actor,
 * key metadata, scopes, and workspace binding for downstream authorization.
 *
 * @param {Object} req - Express request to authenticate.
 * @param {Object} res - Express response used for authentication failures.
 * @param {Function} next - Continuation invoked for valid credentials.
 * @returns {Promise} Resolves after authentication or an error response.
 */
async function authenticateToken(req, res, next) {
  const sessionToken = extractSessionToken(req);
  if (sessionToken && !sessionToken.startsWith("nora_")) {
    const decoded = tryDecodeSession(sessionToken);
    if (decoded) {
      req.user = decoded;
      return next();
    }
  }

  // Bearer token starting with nora_ → API key flow.
  const candidate = sessionToken && sessionToken.startsWith("nora_") ? sessionToken : null;
  const xApiKey = req.headers["x-api-key"] || req.headers["x-nora-api-key"] || "";
  const rawKey = candidate || (typeof xApiKey === "string" ? xApiKey.trim() : "");
  if (rawKey) {
    try {
      const { verifyApiKey } = require("../apiKeys");
      const verified = await verifyApiKey(rawKey);
      if (verified) {
        req.user = verified.user
          ? {
              id: verified.user.id,
              email: verified.user.email,
              role: verified.user.role || "user",
              name: verified.user.name,
              authMethod: "api_key",
            }
          : { id: null, email: null, role: "user", authMethod: "api_key" };
        req.apiKey = verified.key;
        req.apiKeyWorkspace = verified.workspace;
        return next();
      }
    } catch (error) {
      console.error("API key verification failed:", error.message);
    }
    return res.status(401).json({ error: "Invalid or expired API key" });
  }

  return res.status(401).json({ error: "Authentication required" });
}

// Authorization guards

/**
 * Require the authenticated actor's platform role to be `admin`. This does not
 * exclude API keys; combine it with `requireSession` for session-only surfaces.
 *
 * @param {Object} req - Authenticated Express request.
 * @param {Object} res - Express response.
 * @param {Function} next - Continuation invoked for platform admins.
 * @returns {void}
 */
function requireAdmin(req, res, next) {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

/**
 * Build a route guard that enforces one scope for API keys while allowing
 * session-authenticated requests to continue to their role guards.
 *
 * @param {string} requiredScope - Scope required from API-key callers.
 * @returns {Function} Express authorization middleware.
 */
function requireScope(requiredScope) {
  return (req, res, next) => {
    if (!req.apiKey) return next();
    const scopes = Array.isArray(req.apiKey.scopes) ? req.apiKey.scopes : [];
    if (!scopes.includes(requiredScope)) {
      return res.status(403).json({
        error: `API key is missing the "${requiredScope}" scope`,
        code: "missing_scope",
      });
    }
    next();
  };
}

/**
 * Build a method-aware API-key guard; a null read or write scope makes that
 * method class session-only while session callers continue normally.
 *
 * @param {string|null} readScope - Scope for GET, HEAD, and OPTIONS requests.
 * @param {string|null} writeScope - Scope for all mutating methods.
 * @returns {Function} Express authorization middleware.
 */
function scopeByMethod(readScope, writeScope) {
  return (req, res, next) => {
    if (!req.apiKey) return next();
    const isRead = ["GET", "HEAD", "OPTIONS"].includes(req.method);
    const required = isRead ? readScope : writeScope;
    if (!required) {
      return res.status(403).json({
        error: "This endpoint requires session authentication",
        code: "session_required",
      });
    }
    const scopes = Array.isArray(req.apiKey.scopes) ? req.apiKey.scopes : [];
    if (!scopes.includes(required)) {
      return res.status(403).json({
        error: `API key is missing the "${required}" scope`,
        code: "missing_scope",
      });
    }
    next();
  };
}

/**
 * Reject API-key-authenticated requests from a session-only route.
 *
 * @param {Object} req - Authenticated Express request.
 * @param {Object} res - Express response.
 * @param {Function} next - Continuation invoked for session callers.
 * @returns {void}
 */
function requireSession(req, res, next) {
  if (req.apiKey) {
    return res.status(403).json({
      error: "This endpoint requires session authentication",
      code: "session_required",
    });
  }
  next();
}

module.exports = {
  authenticateToken,
  requireAdmin,
  requireScope,
  requireSession,
  scopeByMethod,
};
