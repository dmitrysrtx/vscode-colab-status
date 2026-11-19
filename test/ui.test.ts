import test from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWED_TOOLTIP_COMMANDS,
  formatStatusPresentation,
} from "../src/ui";

test("formatStatusPresentation renders active GPU with VRAM and Compute Units", () => {
  const view = formatStatusPresentation({
    kind: "active",
    assignments: [
      {
        endpoint: "m-s-abc",
        accelerator: "A100",
        variant: "GPU",
        machineShape: "HIGH_RAM",
        runtimeProxyInfo: {
          url: "https://abc.prod.colab.dev",
          token: "tok",
          tokenExpiresInSeconds: 3600,
        },
      },
    ],
    vram: {
      status: "ok",
      gpuName: "NVIDIA A100-SXM4-40GB",
      vramUsedGb: 12.4,
      vramTotalGb: 40.0,
      vramPct: 31,
    },
    ccuInfo: {
      currentBalance: 42.5,
      consumptionRateHourly: 11.77,
      assignmentsCount: 1,
    },
    auth: { provider: "oauth2", email: "user@example.com" },
  });

  assert.equal(
    view.text,
    "$(vm-active) Colab A100 | VRAM: 12.4 / 40.0 GB (31%)"
  );
  assert.equal(view.background, "none");
  assert.match(view.tooltipMarkdown, /A100 · High-RAM/);
  assert.match(view.tooltipMarkdown, /Compute Units: `42\.50 CU` · `11\.77 CU\/hr`/);
  assert.match(view.tooltipMarkdown, /command:colabStatus\.openInBrowser/);
  assert.match(view.tooltipMarkdown, /command:colabStatus\.stopSession/);
  assert.match(view.tooltipMarkdown, /Sign Out/);
});

test("formatStatusPresentation renders disconnected state with Compute Units and quick presets", () => {
  const view = formatStatusPresentation({
    kind: "disconnected",
    ccuInfo: {
      currentBalance: 88.25,
      consumptionRateHourly: 0,
      assignmentsCount: 0,
    },
    auth: { provider: "adc", email: "ml@example.com" },
  });

  assert.equal(view.text, "$(debug-disconnect) Colab: Disconnected");
  assert.equal(view.background, "error");
  assert.match(view.tooltipMarkdown, /Compute Units: `88\.25 CU`/);
  assert.match(view.tooltipMarkdown, /T4 \(15G\)/);
  assert.match(view.tooltipMarkdown, /TPU v5e-1/);
  assert.match(view.tooltipMarkdown, /gcloud ADC/);
  assert.match(view.tooltipMarkdown, /Switch to OAuth/);
});

test("formatStatusPresentation renders unauthenticated state", () => {
  const view = formatStatusPresentation({
    kind: "unauthenticated",
  });

  assert.equal(view.text, "$(account) Colab: Sign In");
  assert.equal(view.background, "warning");
  assert.match(view.tooltipMarkdown, /command:colabStatus\.signIn/);
  assert.ok(ALLOWED_TOOLTIP_COMMANDS.includes("colabStatus.signIn"));
});
