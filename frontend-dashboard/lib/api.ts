function hasHeader(headers, name) {
  const needle = String(name || "").toLowerCase();
  return Object.keys(headers || {}).some((key) => key.toLowerCase() === needle);
}

type FetchHeaders = Record<string, string>;
type FetchOptions = RequestInit & {
  headers?: FetchHeaders;
  body?: BodyInit | null;
};

function currentMarketingPath(path: string) {
  if (typeof window === "undefined") return path;
  const match = window.location.pathname.match(/^\/app\/(es|fr|zh-Hans|zh-Hant)(?=\/|$)/);
  return match ? `/${match[1]}${path}` : path;
}

// Session auth primarily rides on the HttpOnly `nora_auth` cookie that the
// backend sets at /auth/login. credentials:"include" makes the browser attach
// the cookie on every API call. The Authorization header is still sent when
// a legacy localStorage token exists, so sessions from before the cookie
// migration keep working until they expire or the user logs in again.
// CodeQL flags the fetch() below as request forgery, and the concern is real
// even though every current caller passes a relative /api/... path: the legacy
// Authorization header is attached unconditionally, so an absolute URL reaching
// this function would hand a bearer token to another origin. Resolving against
// the current origin and returning a path-only URL makes the request
// same-origin by construction and rejects anything that tries to leave.
function sameOriginPath(url: string): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "http://nora.invalid";
  const resolved = new URL(url, origin);
  if (resolved.origin !== origin) {
    throw new Error(`Refusing to send an authenticated request to ${resolved.origin}`);
  }
  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}

export async function fetchWithAuth(url: string, options: FetchOptions = {}) {
  const legacyToken = typeof window !== "undefined" ? localStorage.getItem("token") : null;
  const headers: FetchHeaders = {
    ...options.headers,
  };
  if (legacyToken && !hasHeader(headers, "authorization")) {
    headers["Authorization"] = `Bearer ${legacyToken}`;
  }

  if (
    options.body != null &&
    typeof options.body === "string" &&
    !hasHeader(headers, "content-type")
  ) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(sameOriginPath(url), {
    ...options,
    headers,
    credentials: "include",
  });

  if (res.status === 401 && typeof window !== "undefined") {
    localStorage.removeItem("token");
    window.location.href = currentMarketingPath("/login");
    throw new Error("Unauthorized");
  }

  return res;
}

// Clear both the HttpOnly cookie (server-side) and any legacy localStorage
// token (client-side), then send the user back to login. Callers that want to
// redirect somewhere specific can do so after awaiting this.
export async function logout() {
  if (typeof window === "undefined") return;
  try {
    await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "include",
    });
  } catch {
    // best-effort; still clear the local token and redirect
  }
  localStorage.removeItem("token");
}
