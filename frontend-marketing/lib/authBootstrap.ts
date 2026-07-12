export type PlatformMode = "selfhosted" | "paas";
export type BotProtectionProvider = "none" | "turnstile" | "recaptcha";

export type SignupBotProtectionConfig = {
  enabled: boolean;
  provider: BotProtectionProvider | null;
  siteKey: string | null;
  configured: boolean;
  configurationError: string | null;
};

export type AuthBootstrapStatus = {
  needsFirstAdmin: boolean;
  oauthLoginEnabled: boolean;
  platformMode: PlatformMode;
  signupBotProtection: SignupBotProtectionConfig;
};

function parsePlatformMode(value: unknown): PlatformMode {
  if (value === "selfhosted" || value === "paas") return value;
  throw new Error("Platform mode metadata is invalid");
}

export function parseAuthBootstrapStatus(value: unknown): AuthBootstrapStatus {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid bootstrap status response");
  }

  const raw = value as Record<string, unknown>;
  if (typeof raw.needsFirstAdmin !== "boolean") {
    throw new Error("First-admin metadata is invalid");
  }
  if (typeof raw.oauthLoginEnabled !== "boolean") {
    throw new Error("OAuth metadata is invalid");
  }

  const protection = raw.signupBotProtection;
  if (!protection || typeof protection !== "object") {
    throw new Error("Signup protection metadata is missing");
  }

  const rawProtection = protection as Record<string, unknown>;
  const rawProvider = rawProtection.provider;
  const provider =
    rawProvider === "none" || rawProvider === "turnstile" || rawProvider === "recaptcha"
      ? rawProvider
      : null;

  return {
    needsFirstAdmin: raw.needsFirstAdmin,
    oauthLoginEnabled: raw.oauthLoginEnabled,
    platformMode: parsePlatformMode(raw.platformMode),
    signupBotProtection: {
      enabled: rawProtection.enabled === true,
      provider,
      siteKey:
        typeof rawProtection.siteKey === "string" && rawProtection.siteKey.trim()
          ? rawProtection.siteKey.trim()
          : null,
      configured: rawProtection.configured === true,
      configurationError:
        typeof rawProtection.configurationError === "string" &&
        rawProtection.configurationError.trim()
          ? rawProtection.configurationError.trim()
          : null,
    },
  };
}

export async function fetchAuthBootstrapStatus(
  signal?: AbortSignal,
): Promise<AuthBootstrapStatus> {
  const response = await fetch("/api/auth/bootstrap-status", {
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) {
    throw new Error(`Bootstrap status failed with ${response.status}`);
  }
  return parseAuthBootstrapStatus(await response.json());
}
