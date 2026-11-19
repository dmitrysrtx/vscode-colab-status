import crypto from "crypto";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { FetchLike } from "./colabClient";

declare const __DEFAULT_OAUTH_CLIENT_ID__: string | undefined;
declare const __DEFAULT_OAUTH_CLIENT_SECRET__: string | undefined;

export function getBuiltInOAuthClientConfig(): OAuthClientConfig | undefined {
  const clientId =
    typeof __DEFAULT_OAUTH_CLIENT_ID__ === "string"
      ? __DEFAULT_OAUTH_CLIENT_ID__.trim()
      : "";
  if (!clientId) return undefined;
  const clientSecret =
    typeof __DEFAULT_OAUTH_CLIENT_SECRET__ === "string"
      ? __DEFAULT_OAUTH_CLIENT_SECRET__.trim()
      : "";
  return {
    clientId,
    clientSecret: clientSecret || undefined,
  };
}

export const GOOGLE_AUTH_URI = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token";
export const GOOGLE_TOKENINFO_URI = "https://oauth2.googleapis.com/tokeninfo";

export const DEFAULT_OAUTH_SCOPES: readonly string[] = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
];

export const SECRET_STORAGE_KEY = "colabStatus.oauthSession.v1";

export type AuthMode = "auto" | "oauth2" | "adc";

export interface SecretStore {
  get(key: string): Thenable<string | undefined> | Promise<string | undefined>;
  store(key: string, value: string): Thenable<void> | Promise<void>;
  delete(key: string): Thenable<void> | Promise<void>;
}

export interface OAuthClientConfig {
  clientId: string;
  clientSecret?: string;
  authUri?: string;
  tokenUri?: string;
}

export interface StoredOAuthSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  clientId: string;
  clientSecret?: string;
  email?: string;
  scopes?: string[];
}

export interface AdcCredentialsFile {
  type: "authorized_user";
  client_id: string;
  client_secret: string;
  refresh_token: string;
  quota_project_id?: string;
}

export interface AuthConfigInput {
  authMode: AuthMode;
  oauthClientId?: string;
  oauthClientSecret?: string;
  oauthConfigPath?: string;
  oauthScopes?: string[];
}

export interface ActiveAuthInfo {
  provider: "oauth2" | "adc";
  email?: string;
}

export class AuthNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthNotConfiguredError";
  }
}

export function expandHome(filePath: string, homeDir = os.homedir()): string {
  if (filePath === "~") return homeDir;
  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    return path.join(homeDir, filePath.slice(2));
  }
  return filePath;
}

export function resolveAdcPaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDir: string = os.homedir()
): string[] {
  const candidates: string[] = [];

  if (env.GOOGLE_APPLICATION_CREDENTIALS?.trim()) {
    candidates.push(expandHome(env.GOOGLE_APPLICATION_CREDENTIALS.trim(), homeDir));
  }

  if (env.CLOUDSDK_CONFIG?.trim()) {
    candidates.push(
      path.join(
        expandHome(env.CLOUDSDK_CONFIG.trim(), homeDir),
        "application_default_credentials.json"
      )
    );
  }

  if (platform === "win32" && env.APPDATA) {
    candidates.push(
      path.join(env.APPDATA, "gcloud", "application_default_credentials.json")
    );
  } else {
    candidates.push(
      path.join(homeDir, ".config", "gcloud", "application_default_credentials.json")
    );
  }

  return Array.from(new Set(candidates));
}

export function loadAdcCredentials(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDir: string = os.homedir()
): AdcCredentialsFile | undefined {
  for (const candidate of resolveAdcPaths(env, platform, homeDir)) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8")) as Partial<AdcCredentialsFile>;
      if (
        parsed.type === "authorized_user" &&
        typeof parsed.client_id === "string" &&
        typeof parsed.client_secret === "string" &&
        typeof parsed.refresh_token === "string" &&
        parsed.client_id &&
        parsed.refresh_token
      ) {
        return {
          type: "authorized_user",
          client_id: parsed.client_id,
          client_secret: parsed.client_secret,
          refresh_token: parsed.refresh_token,
          quota_project_id: parsed.quota_project_id,
        };
      }
    } catch {
      // ignore unreadable/non-ADC file
    }
  }
  return undefined;
}

export function parseOAuthClientJson(raw: unknown): OAuthClientConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const section = (obj.installed ?? obj.web ?? obj) as Record<string, unknown>;
  const clientId =
    typeof section.client_id === "string"
      ? section.client_id.trim()
      : typeof section.clientId === "string"
        ? section.clientId.trim()
        : "";
  if (!clientId) return undefined;

  const clientSecret =
    typeof section.client_secret === "string"
      ? section.client_secret.trim()
      : typeof section.clientSecret === "string"
        ? section.clientSecret.trim()
        : undefined;

  const authUri =
    typeof section.auth_uri === "string" ? section.auth_uri.trim() : undefined;
  const tokenUri =
    typeof section.token_uri === "string" ? section.token_uri.trim() : undefined;

  return {
    clientId,
    clientSecret: clientSecret || undefined,
    authUri: authUri || undefined,
    tokenUri: tokenUri || undefined,
  };
}

export function resolveOAuthClientConfig(
  config: AuthConfigInput,
  homeDir = os.homedir(),
  builtInDefaults: OAuthClientConfig | undefined = getBuiltInOAuthClientConfig()
): OAuthClientConfig | undefined {
  const configuredPath = config.oauthConfigPath
    ?.trim()
    .replace(/^(['"])(.*)\1$/, "$2")
    .trim();
  if (configuredPath) {
    const resolved = expandHome(configuredPath, homeDir);
    if (!fs.existsSync(resolved)) {
      throw new AuthNotConfiguredError(
        `OAuth client config file not found at: ${resolved}`
      );
    }
    const parsed = parseOAuthClientJson(JSON.parse(fs.readFileSync(resolved, "utf8")));
    if (!parsed) {
      throw new AuthNotConfiguredError(
        `Invalid Google OAuth client JSON in: ${resolved}`
      );
    }
    return parsed;
  }

  const clientId = config.oauthClientId?.trim();
  if (clientId) {
    return {
      clientId,
      clientSecret: config.oauthClientSecret?.trim() || undefined,
    };
  }

  const defaultCliConfig = path.join(homeDir, ".colab-cli-oauth-config.json");
  if (fs.existsSync(defaultCliConfig)) {
    try {
      const parsed = parseOAuthClientJson(
        JSON.parse(fs.readFileSync(defaultCliConfig, "utf8"))
      );
      if (parsed) return parsed;
    } catch {
      // ignore invalid optional default file
    }
  }

  if (builtInDefaults?.clientId) {
    return builtInDefaults;
  }

  return undefined;
}

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
  state: string;
}

export function generatePkcePair(): PkcePair {
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  const state = crypto.randomBytes(16).toString("base64url");
  return { codeVerifier, codeChallenge, state };
}

export function buildAuthorizationUrl(params: {
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  codeChallenge: string;
  state: string;
  authUri?: string;
}): string {
  const url = new URL(params.authUri ?? GOOGLE_AUTH_URI);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", params.scopes.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", params.state);
  return url.toString();
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

export async function exchangeAuthorizationCode(
  params: {
    clientId: string;
    clientSecret?: string;
    code: string;
    redirectUri: string;
    codeVerifier: string;
    tokenUri?: string;
  },
  fetchFn: FetchLike = (input, init) => fetch(input, init)
): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
}> {
  const form = new URLSearchParams({
    client_id: params.clientId,
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier,
    grant_type: "authorization_code",
  });
  if (params.clientSecret) {
    form.set("client_secret", params.clientSecret);
  }

  const res = await fetchFn(params.tokenUri ?? GOOGLE_TOKEN_URI, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });

  const data = (await res.json()) as TokenResponse;
  if (!res.ok || !data.access_token) {
    throw new Error(
      `OAuth token exchange failed: ${data.error_description || data.error || `HTTP ${res.status}`}`
    );
  }

  const expiresInSec = typeof data.expires_in === "number" ? data.expires_in : 3600;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? "",
    expiresAt: Date.now() + expiresInSec * 1000,
    scopes: data.scope ? data.scope.split(/\s+/).filter(Boolean) : [],
  };
}

export async function refreshAccessToken(
  params: {
    clientId: string;
    clientSecret?: string;
    refreshToken: string;
    tokenUri?: string;
  },
  fetchFn: FetchLike = (input, init) => fetch(input, init)
): Promise<{ accessToken: string; expiresAt: number }> {
  const form = new URLSearchParams({
    client_id: params.clientId,
    refresh_token: params.refreshToken,
    grant_type: "refresh_token",
  });
  if (params.clientSecret) {
    form.set("client_secret", params.clientSecret);
  }

  const res = await fetchFn(params.tokenUri ?? GOOGLE_TOKEN_URI, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });

  const data = (await res.json()) as TokenResponse;
  if (!res.ok || !data.access_token) {
    throw new Error(
      `Failed to refresh Google access token: ${data.error_description || data.error || `HTTP ${res.status}`}`
    );
  }

  const expiresInSec = typeof data.expires_in === "number" ? data.expires_in : 3600;
  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + expiresInSec * 1000,
  };
}

export async function fetchTokenEmail(
  accessToken: string,
  fetchFn: FetchLike = (input, init) => fetch(input, init)
): Promise<string | undefined> {
  try {
    const url = `${GOOGLE_TOKENINFO_URI}?access_token=${encodeURIComponent(accessToken)}`;
    const res = await fetchFn(url, { method: "GET" });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { email?: string };
    return typeof data.email === "string" && data.email ? data.email : undefined;
  } catch {
    return undefined;
  }
}

export function extractAuthCodeFromInput(
  rawInput: string,
  expectedState?: string
): string {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    throw new Error("Authorization code or redirect URL is empty.");
  }

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new Error("Invalid redirect URL.");
    }
    const oauthErr = parsed.searchParams.get("error");
    if (oauthErr) {
      throw new Error(`Google OAuth error: ${oauthErr}`);
    }
    const state = parsed.searchParams.get("state");
    if (expectedState && state && state !== expectedState) {
      throw new Error("OAuth state mismatch. Please start Sign In again.");
    }
    const code = parsed.searchParams.get("code")?.trim();
    if (!code) {
      throw new Error("Redirect URL does not contain a `code` parameter.");
    }
    return code;
  }

  if (trimmed.includes("code=")) {
    const qs = trimmed.startsWith("?") ? trimmed.slice(1) : trimmed;
    const params = new URLSearchParams(qs);
    const state = params.get("state");
    if (expectedState && state && state !== expectedState) {
      throw new Error("OAuth state mismatch. Please start Sign In again.");
    }
    const code = params.get("code")?.trim();
    if (code) return code;
  }

  return trimmed;
}

export interface LoopbackCallbackServer {
  redirectUri: string;
  waitForCode: () => Promise<string>;
  close: () => void;
}

export async function startLoopbackCallbackServer(
  expectedState: string,
  timeoutMs = 180_000
): Promise<LoopbackCallbackServer> {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  let settled = false;

  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = http.createServer((req, res) => {
    const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
    if (parsed.pathname !== "/callback") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }

    const error = parsed.searchParams.get("error");
    const state = parsed.searchParams.get("state");
    const code = parsed.searchParams.get("code");

    if (error) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<h2>Authorization cancelled</h2><p>You can close this tab and return to VS Code.</p>"
      );
      if (!settled) {
        settled = true;
        rejectCode(new Error(`Google OAuth error: ${error}`));
      }
      return;
    }

    if (!code || state !== expectedState) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<h2>Invalid authorization callback</h2><p>State mismatch or missing code. Please try signing in again.</p>"
      );
      if (!settled) {
        settled = true;
        rejectCode(new Error("Invalid OAuth callback (state mismatch or missing code)."));
      }
      return;
    }

    const safeCode = code
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><html><body style="font-family:system-ui,sans-serif;max-width:520px;margin:48px auto;padding:0 16px;">` +
        `<h2>Signed in to Google Colab GPU Status</h2>` +
        `<p>Authentication completed automatically. You can close this tab and return to your editor.</p>` +
        `<details style="margin-top:16px;"><summary>Manual code (if needed)</summary>` +
        `<pre id="c" style="background:#f3f4f6;padding:10px;border-radius:6px;overflow:auto;">${safeCode}</pre>` +
        `<button onclick="navigator.clipboard.writeText(document.getElementById('c').textContent)">Copy code</button>` +
        `</details></body></html>`
    );
    if (!settled) {
      settled = true;
      resolveCode(code);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address();
  if (!addr || typeof addr === "string") {
    server.close();
    throw new Error("Failed to bind local OAuth callback port.");
  }

  const redirectUri = `http://127.0.0.1:${addr.port}/callback`;

  const timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      rejectCode(new Error("OAuth sign-in timed out waiting for browser callback."));
    }
    server.close();
  }, timeoutMs);

  const cleanup = () => {
    clearTimeout(timer);
    try {
      server.close();
    } catch {
      // ignore
    }
  };

  return {
    redirectUri,
    waitForCode: async () => {
      try {
        return await codePromise;
      } finally {
        cleanup();
      }
    },
    close: () => {
      if (!settled) {
        settled = true;
        rejectCode(new Error("OAuth sign-in cancelled."));
      }
      cleanup();
    },
  };
}

const EXPIRY_MARGIN_MS = 60_000;

export class AuthManager {
  private cachedAdcToken?: { accessToken: string; expiresAt: number; email?: string };
  private activeAuth?: ActiveAuthInfo;

  constructor(
    private readonly secrets: SecretStore,
    private readonly getConfig: () => AuthConfigInput,
    private readonly options: {
      fetchFn?: FetchLike;
      env?: NodeJS.ProcessEnv;
      platform?: NodeJS.Platform;
      homeDir?: string;
    } = {}
  ) {}

  private get fetchFn(): FetchLike {
    return this.options.fetchFn ?? ((input, init) => fetch(input, init));
  }

  getActiveAuthInfo(): ActiveAuthInfo | undefined {
    return this.activeAuth;
  }

  async getStoredOAuthSession(): Promise<StoredOAuthSession | undefined> {
    const raw = await this.secrets.get(SECRET_STORAGE_KEY);
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as Partial<StoredOAuthSession>;
      if (
        typeof parsed.accessToken === "string" &&
        typeof parsed.clientId === "string" &&
        typeof parsed.expiresAt === "number"
      ) {
        return {
          accessToken: parsed.accessToken,
          refreshToken: typeof parsed.refreshToken === "string" ? parsed.refreshToken : "",
          expiresAt: parsed.expiresAt,
          clientId: parsed.clientId,
          clientSecret: parsed.clientSecret,
          email: parsed.email,
          scopes: parsed.scopes,
        };
      }
    } catch {
      // ignore corrupted secret
    }
    return undefined;
  }

  async saveOAuthSession(session: StoredOAuthSession): Promise<void> {
    await this.secrets.store(SECRET_STORAGE_KEY, JSON.stringify(session));
    this.activeAuth = { provider: "oauth2", email: session.email };
  }

  async signOut(): Promise<void> {
    await this.secrets.delete(SECRET_STORAGE_KEY);
    this.cachedAdcToken = undefined;
    this.activeAuth = undefined;
  }

  invalidateCachedTokens(): void {
    this.cachedAdcToken = undefined;
  }

  private async getOAuthToken(): Promise<string | undefined> {
    const stored = await this.getStoredOAuthSession();
    if (!stored) return undefined;

    if (stored.accessToken && stored.expiresAt - Date.now() > EXPIRY_MARGIN_MS) {
      this.activeAuth = { provider: "oauth2", email: stored.email };
      return stored.accessToken;
    }

    if (!stored.refreshToken) {
      return undefined;
    }

    const refreshed = await refreshAccessToken(
      {
        clientId: stored.clientId,
        clientSecret: stored.clientSecret,
        refreshToken: stored.refreshToken,
      },
      this.fetchFn
    );

    const updated: StoredOAuthSession = {
      ...stored,
      accessToken: refreshed.accessToken,
      expiresAt: refreshed.expiresAt,
    };
    if (!updated.email) {
      updated.email = await fetchTokenEmail(refreshed.accessToken, this.fetchFn);
    }
    await this.saveOAuthSession(updated);
    return updated.accessToken;
  }

  private async getAdcToken(): Promise<string | undefined> {
    if (
      this.cachedAdcToken &&
      this.cachedAdcToken.expiresAt - Date.now() > EXPIRY_MARGIN_MS
    ) {
      this.activeAuth = { provider: "adc", email: this.cachedAdcToken.email };
      return this.cachedAdcToken.accessToken;
    }

    const adc = loadAdcCredentials(
      this.options.env,
      this.options.platform,
      this.options.homeDir
    );
    if (!adc) return undefined;

    const refreshed = await refreshAccessToken(
      {
        clientId: adc.client_id,
        clientSecret: adc.client_secret,
        refreshToken: adc.refresh_token,
      },
      this.fetchFn
    );
    const email = await fetchTokenEmail(refreshed.accessToken, this.fetchFn);
    this.cachedAdcToken = {
      accessToken: refreshed.accessToken,
      expiresAt: refreshed.expiresAt,
      email,
    };
    this.activeAuth = { provider: "adc", email };
    return refreshed.accessToken;
  }

  async getAccessToken(): Promise<string> {
    const mode = this.getConfig().authMode;

    if (mode === "oauth2") {
      const token = await this.getOAuthToken();
      if (token) return token;
      this.activeAuth = undefined;
      throw new AuthNotConfiguredError(
        "Not signed in with Google OAuth. Click to sign in."
      );
    }

    if (mode === "adc") {
      const token = await this.getAdcToken();
      if (token) return token;
      this.activeAuth = undefined;
      throw new AuthNotConfiguredError(
        "No gcloud Application Default Credentials found. Run `gcloud auth application-default login`."
      );
    }

    // auto mode: prefer stored OAuth session, then fall back to gcloud ADC
    const oauthToken = await this.getOAuthToken();
    if (oauthToken) return oauthToken;

    const adcToken = await this.getAdcToken();
    if (adcToken) return adcToken;

    this.activeAuth = undefined;
    throw new AuthNotConfiguredError(
      "Not signed in. Sign in with Google OAuth or configure gcloud ADC."
    );
  }
}
