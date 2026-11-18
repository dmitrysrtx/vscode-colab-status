"""Query active Google Colab session and GPU VRAM usage via colab-cli."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Dict, Optional


def _resolve_colab_bin() -> Optional[str]:
    env_bin = os.environ.get("COLAB_BIN", "").strip()
    if env_bin:
        if Path(env_bin).exists():
            return env_bin
        found = shutil.which(env_bin)
        if found:
            return found

    local_bin = Path.home() / ".local/bin/colab"
    if local_bin.exists():
        return str(local_bin)

    return shutil.which("colab")


GPU_QUERY_PY = """\
import subprocess
r = subprocess.run(
    ["nvidia-smi", "--query-gpu=name,memory.used,memory.total", "--format=csv,noheader,nounits"],
    capture_output=True, text=True
)
if r.returncode == 0 and r.stdout.strip():
    print("VRAM_INFO:" + r.stdout.strip().splitlines()[0])
else:
    print("VRAM_INFO:NONE")
"""


def _run(cmd: list[str], timeout: float = 20.0) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def _parse_session(sessions_out: str) -> Optional[Dict[str, str]]:
    for line in sessions_out.splitlines():
        m = re.search(r"\[([a-f0-9]+)\].*?Hardware:\s*([A-Za-z0-9_-]+)", line)
        if m:
            return {"session_id": m.group(1), "hardware": m.group(2)}
    return None


def get_colab_status(check_vram: bool = True) -> Dict[str, Any]:
    """Return structured status dict for CLI or VS Code Status Bar."""
    colab_bin = _resolve_colab_bin()
    if not colab_bin:
        return {
            "state": "disconnected",
            "text": "$(error) Colab: CLI missing",
            "tooltip": "colab CLI not found in PATH or ~/.local/bin/colab",
        }

    try:
        sess_res = _run([colab_bin, "sessions"], timeout=15.0)
    except subprocess.TimeoutExpired:
        return {
            "state": "disconnected",
            "text": "$(error) Colab: Timeout",
            "tooltip": "Timed out querying colab sessions",
        }

    if sess_res.returncode != 0:
        return {
            "state": "disconnected",
            "text": "$(error) Colab: Disconnected",
            "tooltip": (sess_res.stderr or sess_res.stdout).strip() or "Not connected",
        }

    sess = _parse_session(sess_res.stdout)
    if sess is None:
        return {
            "state": "disconnected",
            "text": "$(error) Colab: Disconnected",
            "tooltip": "No active Colab session. Click to provision T4 GPU.",
        }

    hw = sess["hardware"]
    sid = sess["session_id"]

    if not check_vram or "CPU" in hw.upper() or "TPU" in hw.upper() or "V5E" in hw.upper() or "V6E" in hw.upper():
        return {
            "state": "active",
            "session_id": sid,
            "hardware": hw,
            "text": f"$(vm-active) Colab {hw}",
            "tooltip": f"Session: {sid} | Hardware: {hw}",
        }

    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as tf:
        tf.write(GPU_QUERY_PY)
        tf_path = tf.name

    try:
        exec_res = _run([colab_bin, "exec", "--timeout", "15", "-f", tf_path], timeout=25.0)
    except subprocess.TimeoutExpired:
        return {
            "state": "active",
            "session_id": sid,
            "hardware": hw,
            "text": f"$(pulse) Colab {hw} | Busy",
            "tooltip": f"Session: {sid} | Hardware: {hw} | Kernel is busy running a task",
        }
    finally:
        Path(tf_path).unlink(missing_ok=True)

    m = re.search(r"VRAM_INFO:([^,\n]+),\s*([0-9.]+),\s*([0-9.]+)", exec_res.stdout)
    if not m:
        return {
            "state": "active",
            "session_id": sid,
            "hardware": hw,
            "text": f"$(vm-active) Colab {hw} | VRAM: N/A",
            "tooltip": f"Session: {sid} | Hardware: {hw}",
        }

    gpu_name = m.group(1).strip()
    used_gb = float(m.group(2)) / 1024.0
    total_gb = float(m.group(3)) / 1024.0
    pct = int(round((used_gb / max(total_gb, 1e-6)) * 100))

    return {
        "state": "active",
        "session_id": sid,
        "hardware": hw,
        "gpu_name": gpu_name,
        "vram_used_gb": round(used_gb, 1),
        "vram_total_gb": round(total_gb, 1),
        "vram_pct": pct,
        "text": f"$(vm-active) Colab {hw} | VRAM: {used_gb:.1f} / {total_gb:.1f} GB ({pct}%)",
        "tooltip": f"Session: {sid} | {gpu_name} | Click to refresh",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Check Google Colab GPU & VRAM status.")
    parser.add_argument("--json", action="store_true", help="Output JSON for status bar integration.")
    parser.add_argument("--no-vram", action="store_true", help="Skip nvidia-smi exec query.")
    args = parser.parse_args()

    status = get_colab_status(check_vram=not args.no_vram)
    if args.json:
        print(json.dumps(status))
    else:
        print(status["text"])


if __name__ == "__main__":
    main()
