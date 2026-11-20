# Roadmap & TODO

Planned features and improvements for **Google Colab GPU Status** (`dmitrysrtx.colab-gpu-status`).

---

## v0.3.0 — Live Telemetry & Kernel Controls

- [ ] **Live GPU / System metrics while kernel is `Busy`**
  - Probe `runtimeProxyInfo.url` on a live GPU runtime to check which non-blocking channel is available (`GET /api/metrics/v1`, `POST /api/terminals` + WebSocket, or a lightweight secondary kernel).
  - Surface **VRAM**, **GPU Utilization %**, **System RAM**, and **Disk** usage even during active training runs.
- [ ] **Restart Kernel action** (`POST {proxyUrl}/api/kernels/{id}/restart`)
  - Add `[$(debug-restart) Restart Kernel]` to the active tooltip and Command Palette so stuck GPU VRAM can be freed without terminating the VM.
- [ ] **Smart Guardrails & Notifications**
  - Configurable low Compute Units alert threshold (e.g. warn when balance drops below `5.00 CU`).
  - Idle GPU reminder (notify with a one-click **Stop VM** button if a GPU runtime stays idle for > N minutes).

---

## v0.4.0 — Multi-Runtime & Workspace Integration

- [ ] **Multi-runtime switcher**
  - Let users pick which active runtime is pinned to the status bar when 2+ sessions are running.
- [ ] **File sync via Jupyter Contents API** (`{proxyUrl}/api/contents/...`)
  - Commands to upload the active editor file / folder to the Colab VM or download outputs/checkpoints.
- [ ] **Google Drive quick-mount**
  - One-click `drive.mount('/content/drive')` helper command for active sessions.
- [ ] **Optional Telemetry History Panel (Webview)**
  - Sparkline / chart of VRAM & GPU load over the last 10–30 minutes.

---

## Marketplace, Docs & Growth

- [ ] **Animated demo GIF in `README.md`**
  - Record a 6–10s GIF of runtime launch + VRAM/Compute Units tooltip, store in `media/demo.gif` (excluded from `.vsix`), and embed via `raw.githubusercontent.com` URL.
- [ ] **Shields.io badges in `README.md`**
  - Live version, VS Code Marketplace installs, and Open VSX downloads badges.
- [ ] **Verified Publisher badge (VS Code Marketplace)**
  - After 6+ months on the Marketplace and with an owned domain (6+ months old), add the DNS TXT record in Publisher Management.
