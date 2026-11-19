import * as vscode from "vscode";
import {
  AuthConfigInput,
  AuthManager,
  AuthMode,
  AuthNotConfiguredError,
  buildAuthorizationUrl,
  DEFAULT_OAUTH_SCOPES,
  exchangeAuthorizationCode,
  extractAuthCodeFromInput,
  fetchTokenEmail,
  generatePkcePair,
  OAuthClientConfig,
  resolveOAuthClientConfig,
  startLoopbackCallbackServer,
} from "./authCore";
import {
  Assignment,
  AssignOptions,
  buildColabBrowserUrl,
  CcuInfo,
  ColabAuthError,
  ColabClient,
  hardwareDisplayLabel,
  isGpuAssignment,
  parseRuntimeSpec,
} from "./colabClient";
import { queryGpuVram, VramQueryResult } from "./jupyterVram";
import {
  ALLOWED_TOOLTIP_COMMANDS,
  ExtensionStatusState,
  formatStatusPresentation,
} from "./ui";

interface RuntimeQuickPickItem extends vscode.QuickPickItem {
  options: AssignOptions;
}

const RUNTIME_PRESETS: readonly RuntimeQuickPickItem[] = [
  {
    label: "$(vm) T4 GPU (15 GB VRAM)",
    description: "Standard RAM",
    options: { variant: "GPU", accelerator: "T4", highMem: false },
  },
  {
    label: "$(vm) T4 GPU (15 GB VRAM) — High-RAM",
    description: "Colab Pro / Pro+",
    options: { variant: "GPU", accelerator: "T4", highMem: true },
  },
  {
    label: "$(vm) L4 GPU (24 GB VRAM)",
    description: "Colab Pro / Pro+",
    options: { variant: "GPU", accelerator: "L4", highMem: false },
  },
  {
    label: "$(vm) A100 GPU (40/80 GB VRAM)",
    description: "Standard RAM · Pro / Pro+",
    options: { variant: "GPU", accelerator: "A100", highMem: false },
  },
  {
    label: "$(vm) A100 GPU (40/80 GB VRAM) — High-RAM",
    description: "Colab Pro / Pro+",
    options: { variant: "GPU", accelerator: "A100", highMem: true },
  },
  {
    label: "$(vm) H100 GPU (80 GB VRAM)",
    description: "Colab Pro / Pro+",
    options: { variant: "GPU", accelerator: "H100", highMem: false },
  },
  {
    label: "$(vm) G4 GPU (96 GB VRAM)",
    description: "Colab Pro / Pro+",
    options: { variant: "GPU", accelerator: "G4", highMem: false },
  },
  {
    label: "$(chip) TPU v5e-1 (16 GB HBM)",
    description: "TPU runtime",
    options: { variant: "TPU", accelerator: "V5E1", highMem: false },
  },
  {
    label: "$(chip) TPU v6e-1 (32 GB HBM)",
    description: "TPU runtime",
    options: { variant: "TPU", accelerator: "V6E1", highMem: false },
  },
  {
    label: "$(server) CPU Runtime",
    description: "Standard RAM",
    options: { variant: "DEFAULT", accelerator: "NONE", highMem: false },
  },
  {
    label: "$(server) CPU Runtime — High-RAM",
    description: "Colab Pro / Pro+",
    options: { variant: "DEFAULT", accelerator: "NONE", highMem: true },
  },
];

function getWorkspaceConfig() {
  return vscode.workspace.getConfiguration("colabStatus");
}

function readAuthConfig(): AuthConfigInput {
  const cfg = getWorkspaceConfig();
  const mode = cfg.get<string>("authMode", "auto");
  const authMode: AuthMode =
    mode === "oauth2" || mode === "adc" ? mode : "auto";
  const scopes = cfg.get<string[]>("oauthScopes");
  return {
    authMode,
    oauthClientId: cfg.get<string>("oauthClientId", ""),
    oauthClientSecret: cfg.get<string>("oauthClientSecret", ""),
    oauthConfigPath: cfg.get<string>("oauthConfigPath", ""),
    oauthScopes:
      Array.isArray(scopes) && scopes.length > 0
        ? scopes
        : [...DEFAULT_OAUTH_SCOPES],
  };
}

function getPollIntervalMs(): number {
  const sec = Number(getWorkspaceConfig().get<number>("pollIntervalSeconds", 15));
  return Math.max(5, Number.isFinite(sec) ? sec : 15) * 1000;
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Google Colab GPU Status");

  const authManager = new AuthManager(context.secrets, readAuthConfig);
  const colabClient = new ColabClient({
    getAccessToken: () => authManager.getAccessToken(),
  });

  const item = vscode.window.createStatusBarItem(
    "dmitrysrtx.colabGpuStatus",
    vscode.StatusBarAlignment.Left,
    100
  );
  item.name = "Google Colab GPU Status";
  item.command = "colabStatus.clickStatus";
  item.text = "$(sync~spin) Colab: Checking...";
  item.show();

  let currentState: ExtensionStatusState = { kind: "disconnected" };
  let activeAssignments: Assignment[] = [];
  let busy = false;
  let lastRenderedKey = "";

  function applyState(state: ExtensionStatusState): void {
    const prevKind = currentState.kind;
    currentState = state;
    const view = formatStatusPresentation(state);
    const renderKey = `${view.background}\0${view.text}\0${view.tooltipMarkdown}`;

    if (prevKind !== state.kind) {
      output.appendLine(`[state] ${prevKind} -> ${state.kind} (${view.text})`);
    }

    if (renderKey === lastRenderedKey) {
      return;
    }
    lastRenderedKey = renderKey;

    item.text = view.text;

    const md = new vscode.MarkdownString(view.tooltipMarkdown, true);
    md.isTrusted = { enabledCommands: [...ALLOWED_TOOLTIP_COMMANDS] };
    md.supportHtml = false;
    item.tooltip = md;

    if (view.background === "error") {
      item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
    } else if (view.background === "warning") {
      item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    } else {
      item.backgroundColor = undefined;
    }
    item.color = undefined;
  }

  async function fetchOptionalCcu(): Promise<CcuInfo | undefined> {
    if (!getWorkspaceConfig().get<boolean>("showComputeUnits", true)) {
      return undefined;
    }
    try {
      return await colabClient.getCcuInfo();
    } catch (err) {
      output.appendLine(
        `[ccu-info] skipped: ${err instanceof Error ? err.message : String(err)}`
      );
      return undefined;
    }
  }

  async function refresh(showSpinner = false): Promise<void> {
    if (busy) return;
    busy = true;
    if (showSpinner) {
      lastRenderedKey = "";
      item.text = "$(sync~spin) Colab: Refreshing...";
    }

    try {
      const [assignments, ccuInfo] = await Promise.all([
        colabClient.listAssignments(),
        fetchOptionalCcu(),
      ]);

      activeAssignments = assignments;
      const auth = authManager.getActiveAuthInfo();

      if (assignments.length === 0) {
        applyState({ kind: "disconnected", ccuInfo, auth });
        return;
      }

      const primary = assignments[0];
      let vram: VramQueryResult | undefined;
      if (
        getWorkspaceConfig().get<boolean>("queryVram", true) &&
        isGpuAssignment(primary)
      ) {
        vram = await queryGpuVram(primary.runtimeProxyInfo, { timeoutMs: 15_000 });
      }

      applyState({ kind: "active", assignments, vram, ccuInfo, auth });
    } catch (err) {
      activeAssignments = [];
      if (err instanceof AuthNotConfiguredError) {
        applyState({ kind: "unauthenticated", message: err.message });
      } else if (err instanceof ColabAuthError) {
        authManager.invalidateCachedTokens();
        applyState({ kind: "unauthenticated", message: err.message });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        output.appendLine(`[refresh] error: ${message}`);
        applyState({
          kind: "error",
          message,
          auth: authManager.getActiveAuthInfo(),
        });
      }
    } finally {
      busy = false;
    }
  }

  async function provisionRuntime(options: AssignOptions): Promise<void> {
    if (busy) return;
    busy = true;
    const hwLabel = hardwareDisplayLabel(options.accelerator, options.variant);
    const label = options.highMem ? `${hwLabel} (High-RAM)` : hwLabel;
    applyState({ kind: "provisioning", label });

    try {
      await colabClient.assign(options);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      output.appendLine(`[provision] failed: ${msg}`);
      void vscode.window.showErrorMessage(`Colab ${label} provisioning failed: ${msg}`);
    } finally {
      busy = false;
    }

    await refresh();
  }

  async function pickAndProvision(specArg?: string): Promise<void> {
    if (typeof specArg === "string" && specArg.trim()) {
      await provisionRuntime(parseRuntimeSpec(specArg));
      return;
    }

    const picked = await vscode.window.showQuickPick(RUNTIME_PRESETS, {
      placeHolder: "Select a Google Colab runtime to start",
      title: "Start Google Colab Runtime",
    });
    if (!picked) return;
    await provisionRuntime(picked.options);
  }

  async function stopSession(endpointArg?: string): Promise<void> {
    if (busy) return;

    let targets: string[] = [];
    if (typeof endpointArg === "string" && endpointArg.trim()) {
      targets = [endpointArg.trim()];
    } else if (activeAssignments.length === 1) {
      targets = [activeAssignments[0].endpoint];
    } else if (activeAssignments.length > 1) {
      const picks: Array<vscode.QuickPickItem & { endpoints: string[] }> = [
        ...activeAssignments.map((a) => ({
          label: `$(debug-stop) Stop ${hardwareDisplayLabel(a.accelerator, a.variant)}`,
          description: a.endpoint,
          endpoints: [a.endpoint],
        })),
        {
          label: "$(trash) Stop All Active Sessions",
          description: `${activeAssignments.length} runtimes`,
          endpoints: activeAssignments.map((a) => a.endpoint),
        },
      ];
      const selected = await vscode.window.showQuickPick(picks, {
        placeHolder: "Choose which Colab runtime to stop",
        title: "Stop Google Colab Runtime",
      });
      if (!selected) return;
      targets = selected.endpoints;
    } else {
      void vscode.window.showInformationMessage("No active Google Colab sessions to stop.");
      return;
    }

    busy = true;
    applyState({ kind: "stopping", endpoint: targets[0] });
    try {
      for (const ep of targets) {
        await colabClient.unassign(ep);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      output.appendLine(`[stop] failed: ${msg}`);
      void vscode.window.showErrorMessage(`Colab stop failed: ${msg}`);
    } finally {
      busy = false;
    }

    await refresh();
  }

  async function openInBrowser(endpointArg?: string): Promise<void> {
    const endpoint =
      (typeof endpointArg === "string" && endpointArg.trim()) ||
      activeAssignments[0]?.endpoint;
    if (!endpoint) {
      void vscode.window.showInformationMessage(
        "No active Google Colab session to open."
      );
      return;
    }
    const url = buildColabBrowserUrl(endpoint);
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  async function promptForOAuthClientConfig(): Promise<OAuthClientConfig | undefined> {
    const choice = await vscode.window.showQuickPick(
      [
        {
          label: "$(key) Enter Google OAuth Client ID & Secret",
          description: "Paste credentials from Google Cloud Console (Desktop app)",
          action: "manual",
        },
        {
          label: "$(file-code) Select OAuth Client JSON File...",
          description: "Pick downloaded client_secret_*.json from Google Cloud",
          action: "file",
        },
        {
          label: "$(gear) Open Extension Settings",
          description: "Configure colabStatus settings manually",
          action: "settings",
        },
      ],
      {
        title: "Google OAuth 2.0 Setup (One-Time)",
        placeHolder: "Choose how to provide your Google OAuth Desktop Client credentials",
      }
    );
    if (!choice) return undefined;

    if (choice.action === "settings") {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "colabStatus"
      );
      return undefined;
    }

    const cfg = getWorkspaceConfig();
    if (choice.action === "file") {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { JSON: ["json"] },
        openLabel: "Use OAuth Client JSON",
      });
      if (!picked || picked.length === 0) return undefined;
      const jsonPath = picked[0].fsPath;
      await cfg.update("oauthConfigPath", jsonPath, vscode.ConfigurationTarget.Global);
      return resolveOAuthClientConfig({ ...readAuthConfig(), oauthConfigPath: jsonPath });
    }

    const clientId = await vscode.window.showInputBox({
      title: "Google OAuth Setup (1/2) — Client ID",
      prompt: "Paste your Google OAuth 2.0 Desktop Client ID",
      placeHolder: "1234567890-abcdefg.apps.googleusercontent.com",
      ignoreFocusOut: true,
      validateInput: (v) =>
        v.trim().length > 0 ? undefined : "Client ID cannot be empty",
    });
    if (!clientId) return undefined;

    const clientSecret = await vscode.window.showInputBox({
      title: "Google OAuth Setup (2/2) — Client Secret",
      prompt: "Paste your Client Secret (press Enter to leave empty if not required)",
      placeHolder: "GOCSPX-...",
      password: true,
      ignoreFocusOut: true,
    });
    if (clientSecret === undefined) return undefined;

    await cfg.update("oauthClientId", clientId.trim(), vscode.ConfigurationTarget.Global);
    await cfg.update(
      "oauthClientSecret",
      clientSecret.trim(),
      vscode.ConfigurationTarget.Global
    );
    return {
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim() || undefined,
    };
  }

  async function waitForAuthCode(
    loopback: Awaited<ReturnType<typeof startLoopbackCallbackServer>>,
    expectedState: string
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const inputBox = vscode.window.createInputBox();
      inputBox.title = "Google Colab Sign In";
      inputBox.prompt =
        "Complete sign-in in your browser. On a remote cluster, copy the redirected localhost URL (or code) from your browser address bar and paste it here:";
      inputBox.placeholder =
        "http://127.0.0.1:.../callback?code=...  or authorization code";
      inputBox.ignoreFocusOut = true;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        inputBox.dispose();
        loopback.close();
        fn();
      };

      loopback
        .waitForCode()
        .then((code) => finish(() => resolve(code)))
        .catch((err) => {
          // Only fail if the user hasn't already submitted via InputBox
          if (!settled) {
            finish(() => reject(err));
          }
        });

      inputBox.onDidAccept(() => {
        try {
          const code = extractAuthCodeFromInput(inputBox.value, expectedState);
          finish(() => resolve(code));
        } catch (err) {
          inputBox.validationMessage =
            err instanceof Error ? err.message : String(err);
        }
      });

      inputBox.onDidChangeValue(() => {
        if (inputBox.validationMessage) {
          inputBox.validationMessage = undefined;
        }
      });

      inputBox.onDidHide(() => {
        if (!settled) {
          finish(() => reject(new Error("OAuth sign-in cancelled.")));
        }
      });

      inputBox.show();
    });
  }

  async function signInWithGoogle(): Promise<void> {
    const authCfg = readAuthConfig();
    let clientConfig: OAuthClientConfig | undefined;
    try {
      clientConfig = resolveOAuthClientConfig(authCfg);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(msg);
      return;
    }

    if (!clientConfig) {
      try {
        clientConfig = await promptForOAuthClientConfig();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(msg);
        return;
      }
      if (!clientConfig) return;
    }

    const scopes =
      authCfg.oauthScopes && authCfg.oauthScopes.length > 0
        ? authCfg.oauthScopes
        : [...DEFAULT_OAUTH_SCOPES];
    const pkce = generatePkcePair();
    const loopback = await startLoopbackCallbackServer(pkce.state);

    const authUrl = buildAuthorizationUrl({
      clientId: clientConfig.clientId,
      redirectUri: loopback.redirectUri,
      scopes,
      codeChallenge: pkce.codeChallenge,
      state: pkce.state,
      authUri: clientConfig.authUri,
    });

    await vscode.env.openExternal(vscode.Uri.parse(authUrl));

    try {
      const code = await waitForAuthCode(loopback, pkce.state);

      const exchanged = await exchangeAuthorizationCode({
        clientId: clientConfig.clientId,
        clientSecret: clientConfig.clientSecret,
        code,
        redirectUri: loopback.redirectUri,
        codeVerifier: pkce.codeVerifier,
        tokenUri: clientConfig.tokenUri,
      });

      const email = await fetchTokenEmail(exchanged.accessToken);
      await authManager.saveOAuthSession({
        accessToken: exchanged.accessToken,
        refreshToken: exchanged.refreshToken,
        expiresAt: exchanged.expiresAt,
        clientId: clientConfig.clientId,
        clientSecret: clientConfig.clientSecret,
        email,
        scopes: exchanged.scopes,
      });

      void vscode.window.showInformationMessage(
        email
          ? `Signed in to Google Colab as ${email}.`
          : "Signed in to Google Colab."
      );
      await refresh(true);
    } catch (err) {
      loopback.close();
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("cancelled")) {
        void vscode.window.showErrorMessage(`Google sign-in failed: ${msg}`);
      }
    }
  }

  async function signOut(): Promise<void> {
    await authManager.signOut();
    void vscode.window.showInformationMessage("Signed out of Google Colab.");
    await refresh();
  }

  async function handleStatusClick(): Promise<void> {
    if (currentState.kind === "unauthenticated") {
      const choice = await vscode.window.showQuickPick(
        [
          {
            label: "$(sign-in) Sign in with Google OAuth",
            description: "Native browser sign-in stored in VS Code SecretStorage",
            action: "signIn",
          },
          {
            label: "$(terminal) Copy gcloud ADC Login Command",
            description: "Use existing gcloud CLI credentials without OAuth client setup",
            action: "adc",
          },
          {
            label: "$(gear) Open Extension Settings",
            description: "Configure authMode, OAuth Client ID, or poll interval",
            action: "settings",
          },
          {
            label: "$(refresh) Retry Connection",
            action: "refresh",
          },
        ],
        {
          placeHolder: "Connect Google Colab GPU Status",
          title: "Google Colab Authentication",
        }
      );
      if (!choice) return;
      if (choice.action === "signIn") {
        await signInWithGoogle();
      } else if (choice.action === "adc") {
        const cmd =
          "gcloud auth application-default login --scopes=openid,https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/colaboratory";
        await vscode.env.clipboard.writeText(cmd);
        void vscode.window.showInformationMessage(
          "Copied `gcloud auth application-default login` command to clipboard. Run it in your terminal, then click Refresh."
        );
      } else if (choice.action === "settings") {
        await vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "colabStatus"
        );
      } else if (choice.action === "refresh") {
        await refresh(true);
      }
      return;
    }

    if (currentState.kind === "disconnected") {
      await pickAndProvision();
      return;
    }

    if (currentState.kind === "active") {
      await refresh(true);
      return;
    }

    if (currentState.kind === "error") {
      await refresh(true);
    }
  }

  const disposables: vscode.Disposable[] = [
    output,
    item,
    vscode.commands.registerCommand("colabStatus.clickStatus", handleStatusClick),
    vscode.commands.registerCommand("colabStatus.refresh", () => refresh(true)),
    vscode.commands.registerCommand("colabStatus.provision", (spec?: string) =>
      pickAndProvision(spec)
    ),
    vscode.commands.registerCommand("colabStatus.stopSession", (endpoint?: string) =>
      stopSession(endpoint)
    ),
    vscode.commands.registerCommand("colabStatus.openInBrowser", (endpoint?: string) =>
      openInBrowser(endpoint)
    ),
    vscode.commands.registerCommand("colabStatus.signIn", signInWithGoogle),
    vscode.commands.registerCommand("colabStatus.signOut", signOut),
    vscode.commands.registerCommand("colabStatus.openSettings", () =>
      vscode.commands.executeCommand("workbench.action.openSettings", "colabStatus")
    ),
  ];

  let timer = setInterval(() => void refresh(), getPollIntervalMs());
  const cfgListener = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("colabStatus.pollIntervalSeconds")) {
      clearInterval(timer);
      timer = setInterval(() => void refresh(), getPollIntervalMs());
    }
    if (
      e.affectsConfiguration("colabStatus.authMode") ||
      e.affectsConfiguration("colabStatus.queryVram") ||
      e.affectsConfiguration("colabStatus.showComputeUnits")
    ) {
      authManager.invalidateCachedTokens();
      void refresh();
    }
  });

  disposables.push(cfgListener, { dispose: () => clearInterval(timer) });
  context.subscriptions.push(...disposables);

  void refresh();
}

export function deactivate(): void {}
