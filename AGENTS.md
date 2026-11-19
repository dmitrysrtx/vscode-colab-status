# AGENTS.md

Project guidance for AI coding agents working on **Google Colab GPU Status** (`dmitrysrtx.colab-gpu-status`).

## Overview

A 100% native TypeScript VS Code / Open VSX extension (bundled with `esbuild` to `dist/extension.js`) that displays active Google Colab GPU/TPU/CPU sessions, live NVIDIA VRAM metrics, and Compute Units (CU) balance in the status bar, with one-click provisioning, browser launch, and stop controls.

No Python runtime and no external `colab` CLI dependency are used.

## Architecture

Keep pure logic decoupled from the `vscode` runtime API so unit tests run directly on Node.js (`node --test`) without an Extension Host:

- `src/colabClient.ts` — Pure HTTP client for Colab Tunnel API (`https://colab.research.google.com/tun/m/...`): `listAssignments`, 2-step XSRF `assign` (GPU/TPU/CPU + `shape=hm`), 2-step XSRF `unassign`, `getCcuInfo`, and `buildColabBrowserUrl`. Must not import `vscode`.
- `src/jupyterVram.ts` — Native Jupyter Server REST (`GET/POST /api/kernels`) + WebSocket (`ws`) client against `runtimeProxyInfo` (`X-Colab-Runtime-Proxy-Token`). Queries `nvidia-smi` with `silent: true, store_history: false`, and returns `busy` immediately when all existing kernels report `execution_state === "busy"`. Must not import `vscode`.
- `src/authCore.ts` — Dual native authentication (`auto` | `oauth2` | `adc`): PKCE OAuth 2.0 loopback + remote copy-paste code parser, `gcloud` ADC loader (`application_default_credentials.json`), token refresh, and `SecretStore` abstraction. Must not import `vscode`.
- `src/ui.ts` — Pure status bar & Markdown tooltip formatter, including Compute Units display and `ALLOWED_TOOLTIP_COMMANDS`. Must not import `vscode`.
- `src/extension.ts` — Thin VS Code integration layer (commands, QuickPick menus, `vscode.SecretStorage`, polling loop, `MarkdownString`, status bar deduplication via `lastRenderedKey`).

## Build, Test, and Verification Commands

```bash
npm ci
npm run typecheck   # tsc --noEmit (strict mode)
npm test            # compiles tsconfig.test.json and runs node --test
npm run build       # esbuild production bundle -> dist/extension.js
npm run package     # typecheck + build + vsce package
```

Always run `npm run typecheck && npm test && npm run build` before committing changes.

## Key Invariants & Security Rules

1. **No secrets in git or `.vsix`:**
   - Never commit OAuth client secrets (`client_secret_*.json` is ignored in `.gitignore` and `.vscodeignore`).
   - Production OAuth Desktop client defaults are injected **only at build time** via `esbuild.mjs` `define` from `COLAB_OAUTH_CLIENT_ID` and `COLAB_OAUTH_CLIENT_SECRET` (configured in GitHub Actions Secrets).
   - User-configured settings (`oauthConfigPath`, `oauthClientId`, `~/.colab-cli-oauth-config.json`) always take precedence over built-in defaults.
2. **Colab Tunnel API quirks:**
   - Strip the XSSI prefix `)]}'\n` from responses on `colab.research.google.com/tun/m/...`.
   - Always include `authuser=0` query param on `colab.research.google.com` requests.
   - `assign` and `unassign` require 2-step XSRF (`GET` to obtain token -> `POST` with `X-Goog-Colab-Token`).
   - Omit `shape=hm` for single-shape accelerators (`L4`, `V5E1`, `V6E1`).
   - Default OAuth scopes are `openid` and `https://www.googleapis.com/auth/userinfo.email` (accepted by `/tun/m/...` without restricted-scope allowlisting).
3. **Authentication safety:**
   - `Sign Out` must only clear this extension's `SecretStorage` key (`colabStatus.oauthSession.v1`). Never delete or revoke the user's system `gcloud` ADC file.
   - Keep remote/headless sign-in working: race the local loopback callback against a live VS Code `InputBox` accepting either a full `http://127.0.0.1:.../callback?code=...` URL or raw authorization code.
4. **Tooltip security:**
   - Never set `md.isTrusted = true`; always restrict `md.isTrusted = { enabledCommands: [...ALLOWED_TOOLTIP_COMMANDS] }` and escape dynamic strings.
5. **Cross-IDE compatibility (VS Code + Open VSX):**
   - Use only standard public VS Code APIs (`engines.vscode: ^1.85.0`) so the same `.vsix` works on VS Code, Google Antigravity IDE, Cursor, Windsurf, and VSCodium.
   - Never change `"publisher": "dmitrysrtx"` or `"name": "colab-gpu-status"` in `package.json`.
   - Keep dev-only files (including `AGENTS.md`, `src/`, `test/`, `.github/`) excluded in `.vscodeignore`.

## Release Workflow

Publishing is automated via `.github/workflows/release.yml` on `v*` tag pushes (or `workflow_dispatch`):

- **VS Code Marketplace:** uses **Trusted Publishing (OIDC)** (`permissions: id-token: write`, `npx @vscode/vsce@latest publish --oidc`). No `VSCE_PAT` required.
- **Open VSX Registry:** uses `OVSX_PAT` repository secret (`ovsx create-namespace dmitrysrtx || true` + `ovsx publish`).
- **GitHub Actions note:** never reference `secrets.*` inside step-level `if:` expressions; pass via `env:` and check inside `run:`.

To cut a new release:
1. Bump `"version"` in `package.json` and sync `package-lock.json` (`npm install --package-lock-only`).
2. Add an entry in `CHANGELOG.md`.
3. Run `npm run typecheck && npm test && npm run build`.
4. Commit, tag, and push:
   ```bash
   git tag vX.Y.Z
   git push origin main vX.Y.Z
   ```
