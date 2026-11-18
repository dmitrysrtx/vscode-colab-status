const vscode = require("vscode");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

function getConfig() {
  return vscode.workspace.getConfiguration("colabStatus");
}

function resolveColabBin() {
  const configured = (getConfig().get("colabPath") || "").trim();
  if (configured) return configured;

  const localBin = path.join(os.homedir(), ".local", "bin", "colab");
  if (fs.existsSync(localBin)) return localBin;

  return "colab";
}

function resolvePythonBin() {
  const configured = (getConfig().get("pythonPath") || "").trim();
  return configured || "python3";
}

function getPollIntervalMs() {
  const sec = Number(getConfig().get("pollIntervalSeconds") || 15);
  return Math.max(5, sec) * 1000;
}

function buildTooltip(data) {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = true;
  md.supportHtml = false;

  if (data.state === "active") {
    const gpu = data.gpu_name || data.hardware || "GPU";
    const sid = data.session_id || "—";
    const vram =
      data.vram_used_gb !== undefined
        ? `${data.vram_used_gb} / ${data.vram_total_gb} GB (${data.vram_pct}%)`
        : "N/A";

    md.appendMarkdown(`**Google Colab (${data.hardware || "GPU"})**\n\n`);
    md.appendMarkdown(`Session: \`${sid}\` · ${gpu}\n\n`);
    md.appendMarkdown(`VRAM: \`${vram}\`\n\n`);
    md.appendMarkdown(`---\n\n`);
    md.appendMarkdown(
      `[$(refresh) Refresh](command:colabStatus.refresh) \u00a0|\u00a0 [$(debug-stop) Stop VM (Down)](command:colabStatus.stopSession)`
    );
  } else if (data.state === "provisioning" || data.state === "stopping") {
    md.appendMarkdown(`**Google Colab**\n\n${data.tooltip || "Working..."}`);
  } else {
    md.appendMarkdown(`**Google Colab: Disconnected**\n\n`);
    md.appendMarkdown(`${data.tooltip || "No active session."}\n\n`);
    md.appendMarkdown(`---\n\n`);
    md.appendMarkdown(
      "**GPU:** " +
        [
          `[$(play) T4 (15G)](command:colabStatus.provision?%22T4%22)`,
          `[$(play) L4 (24G)](command:colabStatus.provision?%22L4%22)`,
          `[$(play) A100 (40/80G)](command:colabStatus.provision?%22A100%22)`,
          `[$(play) H100 (80G)](command:colabStatus.provision?%22H100%22)`,
          `[$(play) G4 (96G)](command:colabStatus.provision?%22G4%22)`,
        ].join(" \u00a0|\u00a0 ") +
        "\n\n"
    );
    md.appendMarkdown(
      "**TPU / CPU:** " +
        [
          `[$(play) TPU v5e-1 (16G)](command:colabStatus.provision?%22TPU:V5E1%22)`,
          `[$(play) TPU v6e-1 (32G)](command:colabStatus.provision?%22TPU:V6E1%22)`,
          `[$(play) CPU](command:colabStatus.provision?%22CPU%22)`,
          `[$(refresh) Check](command:colabStatus.refresh)`,
        ].join(" \u00a0|\u00a0 ")
    );
  }
  return md;
}

function activate(context) {
  const scriptPath = path.join(context.extensionPath, "scripts", "colab_status.py");

  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  item.command = "colabStatus.clickStatus";
  item.text = "$(sync~spin) Colab: Checking...";
  item.show();

  let currentState = "unknown";
  let busy = false;

  function applyStatus(data) {
    currentState = data.state || "disconnected";
    item.text = data.text || "$(error) Colab: Disconnected";
    item.tooltip = buildTooltip(data);
    if (currentState === "disconnected") {
      item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
      item.color = undefined;
    } else if (currentState === "active") {
      item.backgroundColor = undefined;
      item.color = undefined;
    } else {
      item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      item.color = undefined;
    }
  }

  function refresh() {
    if (busy) return;
    if (!fs.existsSync(scriptPath)) {
      applyStatus({
        state: "disconnected",
        text: "$(error) Colab: Script missing",
        tooltip: `Bundled script not found at ${scriptPath}`,
      });
      return;
    }

    busy = true;
    const env = { ...process.env, COLAB_BIN: resolveColabBin() };
    execFile(resolvePythonBin(), [scriptPath, "--json"], { timeout: 30000, env }, (err, stdout) => {
      busy = false;
      if (err || !stdout) {
        applyStatus({
          state: "disconnected",
          text: "$(error) Colab: Disconnected",
          tooltip: err ? err.message : "Failed to query Colab status",
        });
        return;
      }
      try {
        applyStatus(JSON.parse(stdout.trim()));
      } catch (parseErr) {
        applyStatus({
          state: "disconnected",
          text: "$(error) Colab: Parse error",
          tooltip: String(parseErr),
        });
      }
    });
  }

  function provision(spec = "T4") {
    if (busy) return;
    const raw = typeof spec === "string" && spec.trim() ? spec.trim().toUpperCase() : "T4";
    busy = true;

    let args;
    let label = raw;
    if (raw === "CPU") {
      args = ["new"];
    } else if (raw.startsWith("TPU:")) {
      const tpuName = raw.slice(4);
      label = `TPU ${tpuName}`;
      args = ["new", "--tpu", tpuName];
    } else {
      args = ["new", "--gpu", raw];
    }

    applyStatus({
      state: "provisioning",
      text: `$(sync~spin) Colab: Provisioning ${label}...`,
      tooltip: `Provisioning Google Colab ${label} runtime...`,
    });

    execFile(resolveColabBin(), args, { timeout: 120000 }, (err, stdout, stderr) => {
      busy = false;
      if (err) {
        vscode.window.showErrorMessage(`Colab ${label} provisioning failed: ${stderr || err.message}`);
      }
      refresh();
    });
  }

  function stopSession() {
    if (busy) return;
    busy = true;
    applyStatus({
      state: "stopping",
      text: "$(sync~spin) Colab: Stopping...",
      tooltip: "Stopping active Google Colab session...",
    });

    execFile(resolveColabBin(), ["stop"], { timeout: 60000 }, (err, stdout, stderr) => {
      busy = false;
      if (err) {
        vscode.window.showErrorMessage(`Colab stop failed: ${stderr || err.message}`);
      }
      refresh();
    });
  }

  const clickCmd = vscode.commands.registerCommand("colabStatus.clickStatus", () => {
    if (currentState === "disconnected") {
      provision();
    } else {
      item.text = "$(sync~spin) Colab: Refreshing...";
      refresh();
    }
  });

  const refreshCmd = vscode.commands.registerCommand("colabStatus.refresh", () => {
    item.text = "$(sync~spin) Colab: Refreshing...";
    refresh();
  });
  const provCmd = vscode.commands.registerCommand("colabStatus.provision", (gpu) => provision(gpu || "T4"));
  const stopCmd = vscode.commands.registerCommand("colabStatus.stopSession", stopSession);

  let timer = setInterval(refresh, getPollIntervalMs());
  const cfgListener = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("colabStatus.pollIntervalSeconds")) {
      clearInterval(timer);
      timer = setInterval(refresh, getPollIntervalMs());
    }
  });

  context.subscriptions.push(item, clickCmd, refreshCmd, provCmd, stopCmd, cfgListener, {
    dispose: () => clearInterval(timer),
  });

  refresh();
}

function deactivate() {}

module.exports = { activate, deactivate };
