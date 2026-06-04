export function createOAuthRow() {
  return { key: "", value: "", enabled: true };
}

export function createDefaultOAuth2State() {
  return {
    grantType: "authorization_code",
    authUrl: "",
    tokenUrl: "",
    callbackUrl: "",
    clientId: "",
    clientSecret: "",
    scope: "",
    audience: "",
    resource: "",
    authorizationCode: "",
    accessToken: "",
    refreshToken: "",
    tokenType: "Bearer",
    expiresAt: "",
    username: "",
    password: "",
    usePkce: true,
    codeVerifier: "",
    state: "",
    clientAuthMethod: "basic",
    extraTokenParams: [],
    lastError: "",
    lastWarning: "",
    lastStatus: ""
  };
}

export function createDefaultAuthState() {
  return {
    type: "none",
    token: "",
    username: "",
    password: "",
    jwtToken: "",
    digestRealm: "",
    digestNonce: "",
    digestQop: "auth",
    digestAlgorithm: "SHA-256",
    apiKeyName: "",
    apiKeyValue: "",
    apiKeyIn: "header",
    oauth2: createDefaultOAuth2State()
  };
}

export function normalizeOAuthRows(rows) {
  return Array.isArray(rows)
    ? rows.map((row) => ({
      key: row?.key ?? "",
      value: row?.value ?? "",
      enabled: row?.enabled ?? true
    }))
    : [];
}

export function normalizeAuthState(auth) {
  const fallback = createDefaultAuthState();
  const next = auth && typeof auth === "object" ? auth : fallback;

  return {
    ...fallback,
    ...next,
    oauth2: {
      ...fallback.oauth2,
      ...(next.oauth2 && typeof next.oauth2 === "object" ? next.oauth2 : {}),
      extraTokenParams: normalizeOAuthRows(next.oauth2?.extraTokenParams)
    }
  };
}

export const oauthGrantOptions = [
  { value: "authorization_code", label: "Authorization Code" },
  { value: "client_credentials", label: "Client Credentials" },
  { value: "password", label: "Resource Owner Password" },
  { value: "refresh_token", label: "Refresh Token" }
];

export const oauthClientAuthMethodOptions = [
  { value: "basic", label: "Basic Auth" },
  { value: "body", label: "Request Body" }
];

export const oauthTokenPlacementOptions = [
  { value: "header", label: "Authorization Header" },
  { value: "query", label: "Query Param" }
];

export function getOAuthWarnings(auth) {
  const oauth = normalizeAuthState(auth).oauth2;
  const warnings = [];
  const grant = oauth.grantType;

  if (!oauth.tokenUrl.trim()) {
    warnings.push("Token URL is required.");
  }

  if (["authorization_code", "client_credentials", "password"].includes(grant) && !oauth.clientId.trim()) {
    warnings.push("Client ID is required for this grant type.");
  }

  if (grant === "authorization_code") {
    if (!oauth.authUrl.trim()) warnings.push("Authorization URL is required for authorization code flow.");
    if (!oauth.callbackUrl.trim()) warnings.push("Callback URL is required for authorization code flow.");
    if (!oauth.authorizationCode.trim() && !oauth.accessToken.trim()) warnings.push("Authorization code is missing. Open the auth page and paste the returned code or callback URL.");
  }

  if (grant === "password") {
    if (!oauth.username.trim()) warnings.push("Username is required for password grant.");
    if (!oauth.password.trim()) warnings.push("Password is required for password grant.");
  }

  if (grant === "refresh_token" && !oauth.refreshToken.trim()) {
    warnings.push("Refresh token is required for refresh token grant.");
  }

  if (oauth.expiresAt) {
    const expiresAtMs = Date.parse(oauth.expiresAt);
    if (!Number.isNaN(expiresAtMs) && expiresAtMs <= Date.now()) {
      warnings.push("Stored access token appears to be expired. Refresh or fetch a new token.");
    }
  }

  return warnings;
}

export function getOAuthValidationErrors(auth) {
  const oauth = normalizeAuthState(auth).oauth2;
  const errors = [];

  if (!oauth.tokenUrl.trim()) {
    errors.push("Token URL cannot be empty.");
  }

  if (oauth.grantType === "authorization_code") {
    if (!oauth.authUrl.trim()) errors.push("Authorization URL cannot be empty.");
    if (!oauth.callbackUrl.trim()) errors.push("Redirect URL cannot be empty.");
  }

  if (["authorization_code", "client_credentials", "password"].includes(oauth.grantType) && !oauth.clientId.trim()) {
    errors.push("Client ID is required.");
  }

  if (oauth.grantType === "password") {
    if (!oauth.username.trim()) errors.push("Username is required for password grant.");
    if (!oauth.password.trim()) errors.push("Password is required for password grant.");
  }

  if (oauth.grantType === "refresh_token" && !oauth.refreshToken.trim()) {
    errors.push("Refresh token is required to refresh an access token.");
  }

  return errors;
}

export function extractAuthorizationCode(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  try {
    const parsed = new URL(raw);
    const queryCode = parsed.searchParams.get("code");
    if (queryCode) return queryCode;

    const hash = parsed.hash?.startsWith("#") ? parsed.hash.slice(1) : parsed.hash;
    if (hash) {
      const hashParams = new URLSearchParams(hash);
      const hashCode = hashParams.get("code");
      if (hashCode) return hashCode;
    }
  } catch {
  }

  const directMatch = raw.match(/(?:^|[?&#])code=([^&#\s]+)/i);
  if (directMatch?.[1]) {
    try {
      return decodeURIComponent(directMatch[1]);
    } catch {
      return directMatch[1];
    }
  }

  return raw;
}

export function parseOAuthCallbackInput(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return {
      code: "",
      state: "",
      error: "",
      errorDescription: "",
      callbackUrl: "",
    };
  }

  try {
    const parsed = new URL(raw);
    const query = parsed.searchParams;
    const hash = parsed.hash?.startsWith("#") ? parsed.hash.slice(1) : parsed.hash;
    const hashParams = new URLSearchParams(hash || "");

    const readParam = (name) => query.get(name) || hashParams.get(name) || "";

    return {
      code: readParam("code"),
      state: readParam("state"),
      error: readParam("error"),
      errorDescription: readParam("error_description"),
      callbackUrl: parsed.toString(),
    };
  } catch {
    const queryCode = extractAuthorizationCode(raw);
    const stateMatch = raw.match(/(?:^|[?&#])state=([^&#\s]+)/i);
    const errorMatch = raw.match(/(?:^|[?&#])error=([^&#\s]+)/i);
    const errorDescMatch = raw.match(/(?:^|[?&#])error_description=([^&#\s]+)/i);
    const decodeSafe = (valuePart) => {
      if (!valuePart) return "";
      try {
        return decodeURIComponent(valuePart);
      } catch {
        return valuePart;
      }
    };

    return {
      code: queryCode,
      state: decodeSafe(stateMatch?.[1]),
      error: decodeSafe(errorMatch?.[1]),
      errorDescription: decodeSafe(errorDescMatch?.[1]),
      callbackUrl: "",
    };
  }
}

export function createOAuthFingerprint(oauth) {
  const normalized = normalizeAuthState({ type: "oauth2", oauth2: oauth }).oauth2;
  return JSON.stringify({
    grantType: normalized.grantType,
    authUrl: normalized.authUrl,
    tokenUrl: normalized.tokenUrl,
    callbackUrl: normalized.callbackUrl,
    clientId: normalized.clientId,
    scope: normalized.scope,
    audience: normalized.audience,
    resource: normalized.resource,
    username: normalized.username,
    refreshToken: normalized.refreshToken,
    extraTokenParams: normalized.extraTokenParams
  });
}

export function normalizeEnvInterpolatedValue(value) {
  return String(value ?? "").trim();
}

export function generateOAuthStateToken() {
  return `state_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

export function generatePkceVerifier() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  return Array.from({ length: 64 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

async function sha256Base64Url(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await window.crypto.subtle.digest("SHA-256", bytes);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function buildAuthorizationUrl(oauth, resolveValue) {
  const authUrl = normalizeEnvInterpolatedValue(resolveValue(oauth.authUrl));
  if (!authUrl) {
    throw new Error("Authorization URL is required.");
  }

  const url = new URL(authUrl);
  url.searchParams.set("response_type", "code");

  const clientId = normalizeEnvInterpolatedValue(resolveValue(oauth.clientId));
  const callbackUrl = normalizeEnvInterpolatedValue(resolveValue(oauth.callbackUrl));
  const scope = normalizeEnvInterpolatedValue(resolveValue(oauth.scope));
  const audience = normalizeEnvInterpolatedValue(resolveValue(oauth.audience));
  const resource = normalizeEnvInterpolatedValue(resolveValue(oauth.resource));
  const state = normalizeEnvInterpolatedValue(resolveValue(oauth.state));

  if (clientId) url.searchParams.set("client_id", clientId);
  if (callbackUrl) url.searchParams.set("redirect_uri", callbackUrl);
  if (scope) url.searchParams.set("scope", scope);
  if (audience) url.searchParams.set("audience", audience);
  if (resource) url.searchParams.set("resource", resource);
  if (state) url.searchParams.set("state", state);

  let computedVerifier = oauth.codeVerifier || "";
  if (oauth.usePkce) {
    if (!computedVerifier) {
      computedVerifier = generatePkceVerifier();
    }
    const challenge = await sha256Base64Url(computedVerifier);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
  }

  return {
    url: url.toString(),
    codeVerifier: computedVerifier
  };
}
