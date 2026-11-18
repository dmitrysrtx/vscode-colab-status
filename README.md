# Google Colab GPU Status (VS Code Extension)

Displays live Google Colab GPU/TPU/CPU session status and VRAM usage in the VS Code status bar, with one-click runtime provisioning and stop controls.

## Features

- Live status bar indicator for active Google Colab sessions (`T4`, `L4`, `A100`, `H100`, `G4`, `TPU v5e-1`, `TPU v6e-1`, `CPU`).
- GPU VRAM usage (`used / total GB` and percentage) queried via `nvidia-smi`.
- One-click provisioning, refresh, and stop controls directly from the status bar tooltip.

## Requirements

- `python3`
- `colab` CLI installed and authenticated (e.g. in `PATH` or `~/.local/bin/colab`).

## Settings

- `colabStatus.colabPath`: Custom path to the `colab` CLI executable (auto-detected from `PATH` or `~/.local/bin/colab` if empty).
- `colabStatus.pythonPath`: Python executable used to run the bundled status script (default: `python3`).
- `colabStatus.pollIntervalSeconds`: Polling interval in seconds (default: `15`, minimum: `5`).

## Local Installation / Packaging

```bash
npm install -g @vscode/vsce
vsce package
code --install-extension colab-gpu-status-0.1.0.vsix
```
