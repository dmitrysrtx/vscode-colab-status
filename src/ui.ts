import { ActiveAuthInfo } from "./authCore";
import {
  Assignment,
  CcuInfo,
  hardwareDisplayLabel,
} from "./colabClient";
import { VramQueryResult } from "./jupyterVram";

export const ALLOWED_TOOLTIP_COMMANDS: readonly string[] = [
  "colabStatus.refresh",
  "colabStatus.provision",
  "colabStatus.stopSession",
  "colabStatus.openInBrowser",
  "colabStatus.signIn",
  "colabStatus.signOut",
  "colabStatus.openSettings",
];

export type StatusBackground = "none" | "warning" | "error";

export type ExtensionStatusState =
  | {
      kind: "active";
      assignments: Assignment[];
      vram?: VramQueryResult;
      ccuInfo?: CcuInfo;
      auth?: ActiveAuthInfo;
    }
  | {
      kind: "disconnected";
      message?: string;
      ccuInfo?: CcuInfo;
      auth?: ActiveAuthInfo;
    }
  | {
      kind: "unauthenticated";
      message?: string;
    }
  | {
      kind: "provisioning";
      label: string;
    }
  | {
      kind: "stopping";
      endpoint?: string;
    }
  | {
      kind: "error";
      message: string;
      auth?: ActiveAuthInfo;
    };

export interface StatusBarPresentation {
  text: string;
  background: StatusBackground;
  tooltipMarkdown: string;
}

function escapeInlineCode(value: string): string {
  return value.replace(/[`\r\n]/g, " ");
}

function escapePlainText(value: string): string {
  return value.replace(/[[\]()<>`*_\\]/g, "\\$&");
}

function formatCcuLine(ccu?: CcuInfo): string | undefined {
  if (!ccu) return undefined;
  const bal = ccu.currentBalance.toFixed(2);
  const rate = ccu.consumptionRateHourly.toFixed(2);
  if (ccu.consumptionRateHourly > 0) {
    return `Compute Units: \`${bal} CU\` · \`${rate} CU/hr\``;
  }
  return `Compute Units: \`${bal} CU\``;
}

function formatAuthFooter(auth?: ActiveAuthInfo): string | undefined {
  if (!auth) return undefined;
  const via = auth.provider === "oauth2" ? "Google OAuth" : "gcloud ADC";
  const who = auth.email ? ` (${escapePlainText(auth.email)})` : "";
  if (auth.provider === "oauth2") {
    return `Auth: ${via}${who} \u00a0|\u00a0 [Sign Out](command:colabStatus.signOut)`;
  }
  return `Auth: ${via}${who} \u00a0|\u00a0 [Switch to OAuth](command:colabStatus.signIn)`;
}

function encodeCommandArg(arg: string): string {
  return encodeURIComponent(JSON.stringify(arg));
}

export function formatStatusPresentation(
  state: ExtensionStatusState
): StatusBarPresentation {
  if (state.kind === "provisioning") {
    return {
      text: `$(sync~spin) Colab: Provisioning ${state.label}...`,
      background: "warning",
      tooltipMarkdown: `**Google Colab**\n\nProvisioning ${escapePlainText(state.label)} runtime...`,
    };
  }

  if (state.kind === "stopping") {
    return {
      text: "$(sync~spin) Colab: Stopping...",
      background: "warning",
      tooltipMarkdown: "**Google Colab**\n\nStopping active Google Colab runtime...",
    };
  }

  if (state.kind === "unauthenticated") {
    const detail = state.message
      ? `${escapePlainText(state.message)}\n\n`
      : "Connect your Google account via OAuth or `gcloud auth application-default login`.\n\n";

    return {
      text: "$(account) Colab: Sign In",
      background: "warning",
      tooltipMarkdown:
        `**Google Colab: Not Signed In**\n\n` +
        detail +
        `---\n\n` +
        `[$(sign-in) Sign in with Google](command:colabStatus.signIn) \u00a0|\u00a0 ` +
        `[$(gear) Settings](command:colabStatus.openSettings) \u00a0|\u00a0 ` +
        `[$(refresh) Retry](command:colabStatus.refresh)`,
    };
  }

  if (state.kind === "error") {
    const footer = formatAuthFooter(state.auth);
    const footerBlock = footer ? `\n\n---\n\n${footer}` : "";
    return {
      text: "$(error) Colab: Error",
      background: "error",
      tooltipMarkdown:
        `**Google Colab: Error**\n\n` +
        `${escapePlainText(state.message)}\n\n` +
        `---\n\n` +
        `[$(refresh) Retry](command:colabStatus.refresh) \u00a0|\u00a0 ` +
        `[$(sign-in) Re-authenticate](command:colabStatus.signIn) \u00a0|\u00a0 ` +
        `[$(gear) Settings](command:colabStatus.openSettings)` +
        footerBlock,
    };
  }

  if (state.kind === "disconnected") {
    const ccuLine = formatCcuLine(state.ccuInfo);
    const footer = formatAuthFooter(state.auth);
    const lines: string[] = [
      "**Google Colab: No Active Session**",
      state.message
        ? escapePlainText(state.message)
        : "Click status bar to launch a runtime, or pick a quick preset below.",
    ];
    if (ccuLine) {
      lines.push(ccuLine);
    }
    lines.push("---");
    lines.push(
      "**GPU:** " +
        [
          `[$(play) T4 (15G)](command:colabStatus.provision?${encodeCommandArg("T4")})`,
          `[$(play) L4 (24G)](command:colabStatus.provision?${encodeCommandArg("L4")})`,
          `[$(play) A100 (40/80G)](command:colabStatus.provision?${encodeCommandArg("A100")})`,
          `[$(play) H100 (80G)](command:colabStatus.provision?${encodeCommandArg("H100")})`,
          `[$(play) G4 (96G)](command:colabStatus.provision?${encodeCommandArg("G4")})`,
        ].join(" \u00a0|\u00a0 ")
    );
    lines.push(
      "**TPU / CPU:** " +
        [
          `[$(play) TPU v5e-1](command:colabStatus.provision?${encodeCommandArg("TPU:V5E1")})`,
          `[$(play) TPU v6e-1](command:colabStatus.provision?${encodeCommandArg("TPU:V6E1")})`,
          `[$(play) CPU](command:colabStatus.provision?${encodeCommandArg("CPU")})`,
          `[$(list-selection) More / High-RAM...](command:colabStatus.provision)`,
          `[$(refresh) Check](command:colabStatus.refresh)`,
        ].join(" \u00a0|\u00a0 ")
    );
    if (footer) {
      lines.push("---");
      lines.push(footer);
    }

    return {
      text: "$(debug-disconnect) Colab: Disconnected",
      background: "error",
      tooltipMarkdown: lines.join("\n\n"),
    };
  }

  // Active state
  const primary = state.assignments[0];
  const hw = hardwareDisplayLabel(primary.accelerator, primary.variant);
  const extraCount =
    state.assignments.length > 1 ? ` (+${state.assignments.length - 1})` : "";
  const shapeLabel =
    primary.machineShape === "HIGH_RAM" ? "High-RAM" : "Standard";

  let statusText: string;
  let vramDetail: string | undefined;

  if (state.vram?.status === "ok") {
    statusText = `$(vm-active) Colab ${hw}${extraCount} | VRAM: ${state.vram.vramUsedGb.toFixed(1)} / ${state.vram.vramTotalGb.toFixed(1)} GB (${state.vram.vramPct}%)`;
    vramDetail = `VRAM: \`${state.vram.vramUsedGb.toFixed(1)} / ${state.vram.vramTotalGb.toFixed(1)} GB (${state.vram.vramPct}%)\``;
  } else if (state.vram?.status === "busy") {
    statusText = `$(pulse) Colab ${hw}${extraCount} | Busy`;
    vramDetail = "VRAM: `Kernel busy`";
  } else if (state.vram?.status === "unavailable") {
    statusText = `$(vm-active) Colab ${hw}${extraCount} | VRAM: N/A`;
    vramDetail = "VRAM: `N/A`";
  } else {
    statusText = `$(vm-active) Colab ${hw}${extraCount}`;
  }

  const lines: string[] = [
    `**Google Colab (${escapePlainText(hw)} · ${shapeLabel})**`,
  ];

  const gpuSubtitle =
    state.vram?.status === "ok"
      ? ` · ${escapePlainText(state.vram.gpuName)}`
      : "";
  lines.push(`Endpoint: \`${escapeInlineCode(primary.endpoint)}\`${gpuSubtitle}`);

  if (vramDetail) {
    lines.push(vramDetail);
  }

  const ccuLine = formatCcuLine(state.ccuInfo);
  if (ccuLine) {
    lines.push(ccuLine);
  }

  if (state.assignments.length > 1) {
    const others = state.assignments
      .slice(1)
      .map((a) => {
        const label = hardwareDisplayLabel(a.accelerator, a.variant);
        const stopArg = encodeCommandArg(a.endpoint);
        const openArg = encodeCommandArg(a.endpoint);
        return (
          `• **${escapePlainText(label)}** (\`${escapeInlineCode(a.endpoint)}\`) ` +
          `[Open](command:colabStatus.openInBrowser?${openArg}) · ` +
          `[Stop](command:colabStatus.stopSession?${stopArg})`
        );
      })
      .join("\n");
    lines.push(`**Other active runtimes:**\n${others}`);
  }

  lines.push("---");
  const primaryArg = encodeCommandArg(primary.endpoint);
  lines.push(
    [
      `[$(refresh) Refresh](command:colabStatus.refresh)`,
      `[$(globe) Open in Browser](command:colabStatus.openInBrowser?${primaryArg})`,
      `[$(debug-stop) Stop VM](command:colabStatus.stopSession?${primaryArg})`,
    ].join(" \u00a0|\u00a0 ")
  );

  const footer = formatAuthFooter(state.auth);
  if (footer) {
    lines.push("---");
    lines.push(footer);
  }

  return {
    text: statusText,
    background: "none",
    tooltipMarkdown: lines.join("\n\n"),
  };
}
