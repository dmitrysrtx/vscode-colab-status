import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  AuthManager,
  AuthNotConfiguredError,
  buildAuthorizationUrl,
  extractAuthCodeFromInput,
  generatePkcePair,
  parseOAuthClientJson,
  resolveAdcPaths,
  resolveOAuthClientConfig,
  SecretStore,
} from "../src/authCore";

class MemorySecretStore implements SecretStore {
  private readonly map = new Map<string, string>();
  async get(key: string): Promise<string | undefined> {
    return this.map.get(key);
  }
  async store(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

test("resolveAdcPaths handles Linux and Windows conventions", () => {
  const linuxPaths = resolveAdcPaths({}, "linux", "/home/alice");
  assert.deepEqual(linuxPaths, [
    "/home/alice/.config/gcloud/application_default_credentials.json",
  ]);

  const winPaths = resolveAdcPaths(
    { APPDATA: "C:\\Users\\Alice\\AppData\\Roaming" },
    "win32",
    "C:\\Users\\Alice"
  );
  assert.equal(
    winPaths[0],
    path.join(
      "C:\\Users\\Alice\\AppData\\Roaming",
      "gcloud",
      "application_default_credentials.json"
    )
  );
});

test("parseOAuthClientJson supports installed wrapper and flat JSON", () => {
  const wrapped = parseOAuthClientJson({
    installed: {
      client_id: "id-1",
      client_secret: "sec-1",
    },
  });
  assert.deepEqual(wrapped, {
    clientId: "id-1",
    clientSecret: "sec-1",
    authUri: undefined,
    tokenUri: undefined,
  });

  const flat = parseOAuthClientJson({ clientId: "id-2" });
  assert.equal(flat?.clientId, "id-2");
  assert.equal(flat?.clientSecret, undefined);
});

test("buildAuthorizationUrl includes PKCE S256 and offline consent params", () => {
  const pkce = generatePkcePair();
  const url = new URL(
    buildAuthorizationUrl({
      clientId: "cid",
      redirectUri: "http://127.0.0.1:4321/callback",
      scopes: ["openid", "https://www.googleapis.com/auth/userinfo.email"],
      codeChallenge: pkce.codeChallenge,
      state: pkce.state,
    })
  );

  assert.equal(url.searchParams.get("client_id"), "cid");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.equal(url.searchParams.get("state"), pkce.state);
});

test("AuthManager auto mode refreshes expired OAuth token and persists it", async () => {
  const store = new MemorySecretStore();
  const manager = new AuthManager(
    store,
    () => ({ authMode: "auto" }),
    {
      fetchFn: async (url) => {
        if (url.includes("tokeninfo")) {
          return new Response(JSON.stringify({ email: "dev@example.com" }), {
            status: 200,
          });
        }
        return new Response(
          JSON.stringify({ access_token: "fresh-access", expires_in: 3600 }),
          { status: 200 }
        );
      },
      env: {},
      homeDir: "/nonexistent",
    }
  );

  await manager.saveOAuthSession({
    accessToken: "stale-access",
    refreshToken: "refresh-1",
    expiresAt: Date.now() - 10_000,
    clientId: "cid",
    clientSecret: "csec",
  });

  const token = await manager.getAccessToken();
  assert.equal(token, "fresh-access");
  assert.deepEqual(manager.getActiveAuthInfo(), {
    provider: "oauth2",
    email: "dev@example.com",
  });

  const stored = await manager.getStoredOAuthSession();
  assert.equal(stored?.accessToken, "fresh-access");
  assert.equal(stored?.email, "dev@example.com");
});

test("AuthManager auto mode falls back to gcloud ADC credentials", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "colab-adc-test-"));
  const adcFile = path.join(tmpDir, "application_default_credentials.json");
  fs.writeFileSync(
    adcFile,
    JSON.stringify({
      type: "authorized_user",
      client_id: "adc-cid",
      client_secret: "adc-sec",
      refresh_token: "adc-refresh",
    })
  );

  try {
    const store = new MemorySecretStore();
    const manager = new AuthManager(store, () => ({ authMode: "auto" }), {
      env: { GOOGLE_APPLICATION_CREDENTIALS: adcFile },
      fetchFn: async (url) => {
        if (url.includes("tokeninfo")) {
          return new Response(JSON.stringify({ email: "adc@example.com" }), {
            status: 200,
          });
        }
        return new Response(
          JSON.stringify({ access_token: "adc-access", expires_in: 3600 }),
          { status: 200 }
        );
      },
    });

    const token = await manager.getAccessToken();
    assert.equal(token, "adc-access");
    assert.deepEqual(manager.getActiveAuthInfo(), {
      provider: "adc",
      email: "adc@example.com",
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("AuthManager throws AuthNotConfiguredError when no credentials exist", async () => {
  const manager = new AuthManager(
    new MemorySecretStore(),
    () => ({ authMode: "auto" }),
    { env: {}, homeDir: "/nonexistent-home-path-xyz" }
  );

  await assert.rejects(() => manager.getAccessToken(), AuthNotConfiguredError);
});

test("extractAuthCodeFromInput parses full redirect URL, query string, and raw code", () => {
  assert.equal(
    extractAuthCodeFromInput(
      "http://127.0.0.1:41234/callback?state=st1&code=4%2F0Axyz123&scope=openid",
      "st1"
    ),
    "4/0Axyz123"
  );
  assert.equal(
    extractAuthCodeFromInput("code=4%2F0Araw&state=st2", "st2"),
    "4/0Araw"
  );
  assert.equal(extractAuthCodeFromInput("  4/0Adirect  ", "st3"), "4/0Adirect");
  assert.throws(
    () =>
      extractAuthCodeFromInput(
        "http://127.0.0.1:41234/callback?state=wrong&code=abc",
        "expected"
      ),
    /state mismatch/i
  );
  assert.throws(
    () =>
      extractAuthCodeFromInput(
        "http://127.0.0.1:41234/callback?error=access_denied",
        "expected"
      ),
    /access_denied/
  );
});

test("resolveOAuthClientConfig prefers explicit settings over built-in defaults", () => {
  const builtIn = { clientId: "builtin-id", clientSecret: "builtin-sec" };

  assert.deepEqual(
    resolveOAuthClientConfig({ authMode: "auto" }, "/nonexistent-home-xyz", builtIn),
    builtIn
  );

  assert.deepEqual(
    resolveOAuthClientConfig(
      {
        authMode: "auto",
        oauthClientId: "custom-id",
        oauthClientSecret: "custom-sec",
      },
      "/nonexistent-home-xyz",
      builtIn
    ),
    { clientId: "custom-id", clientSecret: "custom-sec" }
  );
});
