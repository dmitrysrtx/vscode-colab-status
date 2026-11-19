# Changelog

All notable changes to **Google Colab GPU Status** are documented in this file.

## [0.2.1] - 2026-11-19

### Changed
- Dedicated production Google OAuth 2.0 Desktop client credentials configured for one-click sign-in.

## [0.2.0] - 2026-11-19

### Added
- Full native TypeScript rewrite bundled with `esbuild` — removed external `python3` and `colab` CLI dependencies.
- Native Colab backend client (`assignments`, 2-step XSRF `assign` / `unassign`, `ccu-info`, High-RAM machine shape support, and `Open in Browser` URL builder).
- Native Jupyter REST + WebSocket VRAM monitoring (`nvidia-smi`) with fast busy-kernel detection.
- Compute Units (CU) balance and hourly burn rate display in the status bar tooltip.
- Dual authentication: native Google OAuth 2.0 (PKCE + VS Code `SecretStorage`) and automatic `gcloud` Application Default Credentials (ADC).
- QuickPick runtime launcher (GPU T4/L4/A100/H100/G4, TPU v5e-1/v6e-1, CPU, Standard & High-RAM) and multi-session management.
- Restricted `MarkdownString.isTrusted` to an explicit `enabledCommands` allowlist.
- Built-in Getting Started walkthrough, build-time OAuth client defaults via `esbuild`, unit test suite, and GitHub Actions workflow for VS Code Marketplace & Open VSX releases.

## [0.1.0] - 2026-11-19

### Added
- Initial prototype displaying Google Colab GPU status and VRAM via external `colab` CLI and bundled Python helper script.
