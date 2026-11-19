# Google Colab GPU Status

Monitor your **Google Colab** GPU/TPU/CPU runtimes, live **NVIDIA VRAM** usage, and **Compute Units (CU)** directly from the status bar in **VS Code**, **Google Antigravity IDE**, **Cursor**, **Windsurf**, and **VSCodium** — with one-click runtime provisioning, browser launch, and stop controls.

100% native TypeScript extension: **no Python and no external `colab` CLI required**.

---

## Key Features

- **Live Hardware & VRAM Telemetry** — see active hardware (`T4`, `L4`, `A100`, `H100`, `G4`, `TPU v5e-1`, `TPU v6e-1`, `CPU`), machine shape (`Standard` / `High-RAM`), and live GPU memory usage (`used / total GB` and `%`) queried natively via the Colab runtime Jupyter proxy.
- **Busy-Kernel Awareness** — detects when a notebook/training kernel is `busy` without blocking or polluting your execution history (`silent: true`).
- **Compute Units (CU) Balance & Burn Rate** — displays remaining Colab Compute Units and hourly burn rate (`CU/hr`) in the status bar tooltip so you never accidentally leave an expensive GPU running.
- **One-Click Runtime Controls** — hover over or click the status bar item to start a GPU/TPU/CPU runtime (including High-RAM presets), open the active VM in your browser, refresh immediately, or stop one/all active sessions.
- **Dual Native Authentication** — sign in via built-in **Google OAuth 2.0 (PKCE)** stored in VS Code `SecretStorage`, or automatically pick up existing **`gcloud` Application Default Credentials (ADC)**.
- **Works Locally & on Remote Clusters** — supports automatic localhost callback on desktop editors and seamless URL/code paste fallback on Remote SSH, Coder, and container workspaces.

---

## Quick Start

1. **Install** the extension from VS Code Marketplace or Open VSX.
2. **Sign In** by clicking **`Colab: Sign In`** in the bottom-left status bar (or running **`Colab Status: Sign In with Google`** from the Command Palette):
   - **Google OAuth 2.0:** approve access in your browser. On a remote cluster/SSH session, copy the redirected `http://127.0.0.1:.../callback?code=...` URL (or code) from your browser address bar and paste it into the input prompt already open in your editor.
   - **Or `gcloud` ADC (zero-config):** if you already use Google Cloud CLI, authenticate once in your terminal and the extension detects it automatically in `auto` mode:
     ```bash
     gcloud auth application-default login \
       --scopes=openid,https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/colaboratory
     ```
3. **Monitor & Control:**
   - Hover over the status bar indicator to view full GPU model, VRAM, Compute Units balance, and one-click action links.
   - Click the status bar when disconnected to open the QuickPick runtime launcher (GPU / TPU / CPU + High-RAM).
   - Click **Open in Browser** to attach the Google Colab web UI directly to your active runtime, or **Stop VM** to terminate it.

---

## Commands

Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and search for **`Colab Status`**:

| Command | Description |
| :--- | :--- |
| `Colab Status: Start Runtime...` | Pick and provision a GPU, TPU, or CPU runtime (Standard or High-RAM). |
| `Colab Status: Refresh Status` | Immediately poll active runtimes, VRAM, and Compute Units. |
| `Colab Status: Open Active Session in Browser` | Open the active Colab runtime directly in your browser. |
| `Colab Status: Stop Session` | Stop the active runtime (or choose which runtime / stop all when multiple are running). |
| `Colab Status: Sign In with Google` | Sign in via Google OAuth 2.0 (stored encrypted in `SecretStorage`). |
| `Colab Status: Sign Out` | Remove the stored Google OAuth session from `SecretStorage`. |
| `Colab Status: Open Settings` | Open `colabStatus` extension settings. |

---

## Settings

| Setting | Default | Description |
| :--- | :--- | :--- |
| `colabStatus.authMode` | `"auto"` | `"auto"` (use stored OAuth session if signed in, else fall back to `gcloud` ADC), `"oauth2"`, or `"adc"`. |
| `colabStatus.pollIntervalSeconds` | `15` | Status polling interval in seconds (minimum `5`). |
| `colabStatus.queryVram` | `true` | Query live GPU VRAM via `nvidia-smi` over the runtime Jupyter WebSocket. |
| `colabStatus.showComputeUnits` | `true` | Show Compute Units balance and hourly burn rate in the tooltip. |
| `colabStatus.oauthClientId` | `""` | *(Optional)* Override with your own Google OAuth 2.0 Desktop Client ID. |
| `colabStatus.oauthClientSecret` | `""` | *(Optional)* Client Secret for a custom Google OAuth Desktop Client. |
| `colabStatus.oauthConfigPath` | `""` | *(Optional)* Absolute path (or `~/...`) to a custom Google OAuth client JSON file. |
| `colabStatus.oauthScopes` | `["openid", "...userinfo.email"]` | OAuth 2.0 scopes requested during Google Sign In. |

---

## FAQ & Troubleshooting

- **Why is there no "Sign Out" link when using `gcloud ADC`?**
  `gcloud` credentials live in your system's `~/.config/gcloud/application_default_credentials.json` and may be shared with other CLI tools, so the extension intentionally never deletes or revokes them. Use **Switch to OAuth** in the tooltip to sign in with a separate OAuth session, or run `gcloud auth application-default revoke` in your terminal to revoke ADC.
- **What does `Colab A100 | Busy` mean?**
  Your Colab kernel is currently executing code (e.g. a training loop). The extension skips `nvidia-smi` until the kernel becomes idle so it does not queue behind your job.
- **How does Sign In work on Remote SSH / Coder / containers?**
  Your local browser handles the Google sign-in screen. If `127.0.0.1` port forwarding is unavailable, simply copy the redirected `http://127.0.0.1:.../callback?code=...` URL from your browser address bar and paste it into the input box shown in the editor.

---

## Contributing & Releases

```bash
npm install
npm run typecheck
npm test
npm run build
npm run package
```

Releases are automated via [`.github/workflows/release.yml`](.github/workflows/release.yml) on `v*` tags (or manual dispatch):

- `COLAB_OAUTH_CLIENT_ID` / `COLAB_OAUTH_CLIENT_SECRET` — optional build-time Desktop OAuth client defaults injected by `esbuild` so Marketplace/Open VSX builds offer one-click Google sign-in out of the box.
- `VSCE_PAT` — publishes `.vsix` to the Visual Studio Marketplace.
- `OVSX_PAT` — publishes `.vsix` to Open VSX Registry (Antigravity, Cursor, Windsurf, VSCodium).
