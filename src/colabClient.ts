import crypto from "crypto";

export const COLAB_DOMAIN = "https://colab.research.google.com";
export const TUN_PREFIX = "/tun/m";
export const XSSI_PREFIX = ")]}'\n";
export const CLIENT_AGENT = "vscode-colab-gpu-status";

export type Accelerator =
  | "NONE"
  | "T4"
  | "L4"
  | "G4"
  | "A100"
  | "H100"
  | "V5E1"
  | "V6E1";

export type Variant = "DEFAULT" | "GPU" | "TPU";
export type MachineShape = "STANDARD" | "HIGH_RAM";

export const GPU_ACCELERATORS: readonly Accelerator[] = [
  "T4",
  "L4",
  "A100",
  "H100",
  "G4",
];

export const TPU_ACCELERATORS: readonly Accelerator[] = ["V5E1", "V6E1"];

/**
 * Accelerators that only offer a single machine shape; `/tun/m/assign` ignores
 * `shape=hm` for these.
 */
export const HIGH_MEM_ONLY_ACCELERATORS: ReadonlySet<Accelerator> = new Set([
  "L4",
  "V5E1",
  "V6E1",
]);

export interface RuntimeProxyInfo {
  token: string;
  tokenExpiresInSeconds: number;
  url: string;
}

export interface Assignment {
  endpoint: string;
  accelerator: Accelerator;
  variant: Variant;
  machineShape: MachineShape;
  runtimeProxyInfo: RuntimeProxyInfo;
}

export interface CcuInfo {
  currentBalance: number;
  consumptionRateHourly: number;
  assignmentsCount: number;
}

export interface AssignOptions {
  variant: Variant;
  accelerator: Accelerator;
  highMem?: boolean;
  notebookHash?: string;
}

export class ColabApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly responseBody?: string
  ) {
    super(message);
    this.name = "ColabApiError";
  }
}

export class ColabAuthError extends ColabApiError {
  constructor(message: string, statusCode = 401, responseBody?: string) {
    super(message, statusCode, responseBody);
    this.name = "ColabAuthError";
  }
}

export class TooManyAssignmentsError extends ColabApiError {
  constructor(message: string, responseBody?: string) {
    super(message, 412, responseBody);
    this.name = "TooManyAssignmentsError";
  }
}

export function stripXssiPrefix(body: string): string {
  return body.startsWith(XSSI_PREFIX) ? body.slice(XSSI_PREFIX.length) : body;
}

/**
 * Matches google-colab-cli's 44-character web-safe notebook hash encoding.
 */
export function uuidToWebSafeBase64(uuidVal: string): string {
  const transformed = uuidVal.replace(/-/g, "_");
  const padLen = Math.max(0, 44 - transformed.length);
  return transformed + ".".repeat(padLen);
}

export function resolveAssignShape(
  accelerator: Accelerator,
  highMem = false
): MachineShape | undefined {
  if (!highMem) return undefined;
  if (HIGH_MEM_ONLY_ACCELERATORS.has(accelerator)) return undefined;
  return "HIGH_RAM";
}

export function parseVariant(raw: unknown): Variant {
  if (raw === 1 || raw === "GPU") return "GPU";
  if (raw === 2 || raw === "TPU") return "TPU";
  return "DEFAULT";
}

export function parseMachineShape(raw: unknown): MachineShape {
  if (raw === 1 || raw === "HIGH_RAM" || raw === "SHAPE_HIGHMEM") {
    return "HIGH_RAM";
  }
  return "STANDARD";
}

const VALID_ACCELERATORS: ReadonlySet<string> = new Set([
  "NONE",
  "T4",
  "L4",
  "G4",
  "A100",
  "H100",
  "V5E1",
  "V6E1",
]);

export function parseAccelerator(raw: unknown): Accelerator {
  if (typeof raw === "string") {
    const upper = raw.trim().toUpperCase();
    if (VALID_ACCELERATORS.has(upper)) {
      return upper as Accelerator;
    }
  }
  return "NONE";
}

export function hardwareDisplayLabel(
  accelerator: Accelerator,
  variant: Variant
): string {
  if (accelerator === "NONE") {
    return variant === "TPU" ? "TPU" : "CPU";
  }
  if (accelerator === "V5E1") return "TPU v5e-1";
  if (accelerator === "V6E1") return "TPU v6e-1";
  return accelerator;
}

export function isGpuAssignment(assignment: Assignment): boolean {
  if (assignment.variant === "GPU") return true;
  return GPU_ACCELERATORS.includes(assignment.accelerator);
}

export function parseRuntimeSpec(spec: string): AssignOptions {
  const raw = spec.trim().toUpperCase();
  if (!raw || raw === "CPU" || raw === "NONE") {
    return { variant: "DEFAULT", accelerator: "NONE", highMem: false };
  }

  let highMem = false;
  let core = raw;
  if (core.endsWith(":HM") || core.endsWith("+HM")) {
    highMem = true;
    core = core.slice(0, -3);
  }

  if (core.startsWith("TPU:")) {
    const tpu = parseAccelerator(core.slice(4));
    return {
      variant: "TPU",
      accelerator: TPU_ACCELERATORS.includes(tpu) ? tpu : "V5E1",
      highMem,
    };
  }

  const acc = parseAccelerator(core);
  if (TPU_ACCELERATORS.includes(acc)) {
    return { variant: "TPU", accelerator: acc, highMem };
  }
  if (GPU_ACCELERATORS.includes(acc)) {
    return { variant: "GPU", accelerator: acc, highMem };
  }
  return { variant: "DEFAULT", accelerator: "NONE", highMem };
}

export function buildColabBrowserUrl(
  endpoint: string,
  host = COLAB_DOMAIN
): string {
  const cleanHost = host.replace(/\/+$/, "");
  const backendPath = `${TUN_PREFIX}/${endpoint}`;
  const dbu = encodeURIComponent(backendPath);
  return `${cleanHost}/notebooks/empty.ipynb?dbu=${dbu}#datalabBackendUrl=${cleanHost}${backendPath}`;
}

export type FetchLike = (
  input: string,
  init?: RequestInit
) => Promise<Response>;

export interface ColabClientOptions {
  getAccessToken: () => Promise<string>;
  fetchFn?: FetchLike;
  domain?: string;
  requestTimeoutMs?: number;
  assignRetries?: number;
  assignRetryBackoffMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
}

interface RawProxyInfo {
  token?: string;
  tokenExpiresInSeconds?: number;
  url?: string;
}

interface RawAssignment {
  endpoint?: string;
  accelerator?: unknown;
  variant?: unknown;
  machineShape?: unknown;
  runtimeProxyInfo?: RawProxyInfo;
}

interface RawGetAssignment {
  token?: string;
  endpoint?: string;
  runtimeProxyInfo?: RawProxyInfo;
  accelerator?: unknown;
  variant?: unknown;
  machineShape?: unknown;
}

export class ColabClient {
  private readonly domain: string;
  private readonly fetchFn: FetchLike;
  private readonly getAccessToken: () => Promise<string>;
  private readonly requestTimeoutMs: number;
  private readonly assignRetries: number;
  private readonly assignRetryBackoffMs: number;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(options: ColabClientOptions) {
    this.getAccessToken = options.getAccessToken;
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
    this.domain = (options.domain ?? COLAB_DOMAIN).replace(/\/+$/, "");
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.assignRetries = options.assignRetries ?? 2;
    this.assignRetryBackoffMs = options.assignRetryBackoffMs ?? 5_000;
    this.sleepFn =
      options.sleepFn ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private async requestJson<T>(
    path: string,
    options: {
      method?: "GET" | "POST";
      query?: Record<string, string>;
      headers?: Record<string, string>;
      timeoutMs?: number;
    } = {}
  ): Promise<T | undefined> {
    const token = await this.getAccessToken();
    const url = new URL(`${this.domain}${path}`);
    url.searchParams.set("authuser", "0");
    if (options.query) {
      for (const [k, v] of Object.entries(options.query)) {
        url.searchParams.set(k, v);
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? this.requestTimeoutMs
    );

    try {
      const response = await this.fetchFn(url.toString(), {
        method: options.method ?? "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "X-Colab-Client-Agent": CLIENT_AGENT,
          ...(options.headers ?? {}),
        },
        signal: controller.signal,
      });

      const rawText = await response.text();
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new ColabAuthError(
            `Google Colab authentication failed (HTTP ${response.status}). Please sign in again or check OAuth/ADC scopes.`,
            response.status,
            rawText
          );
        }
        if (response.status === 412) {
          throw new TooManyAssignmentsError(
            "Colab refused allocation (HTTP 412): too many active sessions or temporary capacity limit.",
            rawText
          );
        }
        throw new ColabApiError(
          `Colab API request failed (${options.method ?? "GET"} ${path}: HTTP ${response.status} ${response.statusText})`,
          response.status,
          rawText
        );
      }

      const cleaned = stripXssiPrefix(rawText).trim();
      if (!cleaned) return undefined;
      return JSON.parse(cleaned) as T;
    } catch (err) {
      if (err instanceof ColabApiError) {
        throw err;
      }
      if (err instanceof Error && err.name === "AbortError") {
        throw new ColabApiError(
          `Colab API request timed out (${options.method ?? "GET"} ${path})`
        );
      }
      throw new ColabApiError(
        `Colab API request error: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private normalizeAssignment(
    raw: RawAssignment,
    fallback?: { variant: Variant; accelerator: Accelerator; shape: MachineShape }
  ): Assignment {
    if (!raw.endpoint || !raw.runtimeProxyInfo?.url || !raw.runtimeProxyInfo?.token) {
      throw new ColabApiError("Malformed assignment payload from Colab API.");
    }
    return {
      endpoint: raw.endpoint,
      accelerator:
        raw.accelerator !== undefined
          ? parseAccelerator(raw.accelerator)
          : (fallback?.accelerator ?? "NONE"),
      variant:
        raw.variant !== undefined
          ? parseVariant(raw.variant)
          : (fallback?.variant ?? "DEFAULT"),
      machineShape:
        raw.machineShape !== undefined
          ? parseMachineShape(raw.machineShape)
          : (fallback?.shape ?? "STANDARD"),
      runtimeProxyInfo: {
        url: raw.runtimeProxyInfo.url,
        token: raw.runtimeProxyInfo.token,
        tokenExpiresInSeconds:
          typeof raw.runtimeProxyInfo.tokenExpiresInSeconds === "number"
            ? raw.runtimeProxyInfo.tokenExpiresInSeconds
            : 3600,
      },
    };
  }

  async listAssignments(): Promise<Assignment[]> {
    const data = await this.requestJson<{ assignments?: RawAssignment[] }>(
      `${TUN_PREFIX}/assignments`
    );
    if (!data?.assignments || !Array.isArray(data.assignments)) {
      return [];
    }
    return data.assignments
      .filter((a) => Boolean(a.endpoint && a.runtimeProxyInfo?.url))
      .map((a) => this.normalizeAssignment(a));
  }

  async getCcuInfo(): Promise<CcuInfo> {
    const data = await this.requestJson<{
      currentBalance?: number;
      consumptionRateHourly?: number;
      assignmentsCount?: number;
    }>(`${TUN_PREFIX}/ccu-info`);

    return {
      currentBalance:
        typeof data?.currentBalance === "number" ? data.currentBalance : 0,
      consumptionRateHourly:
        typeof data?.consumptionRateHourly === "number"
          ? data.consumptionRateHourly
          : 0,
      assignmentsCount:
        typeof data?.assignmentsCount === "number" ? data.assignmentsCount : 0,
    };
  }

  async assign(options: AssignOptions): Promise<Assignment> {
    const notebookHash = options.notebookHash ?? crypto.randomUUID();
    const shape = resolveAssignShape(options.accelerator, options.highMem);
    const query: Record<string, string> = {
      nbh: uuidToWebSafeBase64(notebookHash),
    };
    if (options.variant !== "DEFAULT") {
      query.variant = options.variant;
    } else {
      query.variant = "DEFAULT";
    }
    if (options.accelerator && options.accelerator !== "NONE") {
      query.accelerator = options.accelerator;
    }
    if (shape === "HIGH_RAM") {
      query.shape = "hm";
    }

    const fallback = {
      variant: options.variant,
      accelerator: options.accelerator,
      shape: shape ?? "STANDARD",
    };

    let getResp = await this.requestJson<RawGetAssignment>(
      `${TUN_PREFIX}/assign`,
      { method: "GET", query, timeoutMs: 60_000 }
    );
    if (!getResp) {
      throw new ColabApiError("Empty response from Colab assign GET step.");
    }
    if (getResp.endpoint && getResp.runtimeProxyInfo) {
      return this.normalizeAssignment(getResp, fallback);
    }
    if (!getResp.token) {
      throw new ColabApiError("Colab assign GET step did not return an XSRF token.");
    }

    let xsrfToken: string = getResp.token;

    for (let attempt = 0; attempt <= this.assignRetries; attempt++) {
      try {
        const postResp = await this.requestJson<RawAssignment>(
          `${TUN_PREFIX}/assign`,
          {
            method: "POST",
            query,
            headers: { "X-Goog-Colab-Token": xsrfToken },
            timeoutMs: 120_000,
          }
        );
        if (!postResp) {
          throw new ColabApiError("Empty response from Colab assign POST step.");
        }
        return this.normalizeAssignment(postResp, fallback);
      } catch (err) {
        if (err instanceof TooManyAssignmentsError || err instanceof ColabAuthError) {
          throw err;
        }
        if (
          err instanceof ColabApiError &&
          err.statusCode === 400 &&
          options.accelerator !== "NONE"
        ) {
          throw new ColabApiError(
            `Colab rejected accelerator '${options.accelerator}' (HTTP 400). Your account may not have entitlement or quota for this hardware.`,
            400,
            err.responseBody
          );
        }
        const retryable =
          err instanceof ColabApiError &&
          (err.statusCode === 502 ||
            err.statusCode === 503 ||
            err.statusCode === 504 ||
            err.statusCode === undefined);

        if (!retryable || attempt >= this.assignRetries) {
          throw err;
        }

        await this.sleepFn(this.assignRetryBackoffMs * Math.pow(2, attempt));
        const reconciled = await this.requestJson<RawGetAssignment>(
          `${TUN_PREFIX}/assign`,
          { method: "GET", query, timeoutMs: 60_000 }
        );
        if (reconciled?.endpoint && reconciled.runtimeProxyInfo) {
          return this.normalizeAssignment(reconciled, fallback);
        }
        if (reconciled?.token) {
          xsrfToken = reconciled.token;
        }
      }
    }

    throw new ColabApiError("Colab runtime provisioning failed after retries.");
  }

  async unassign(endpoint: string): Promise<void> {
    const path = `${TUN_PREFIX}/unassign/${encodeURIComponent(endpoint)}`;
    const getResp = await this.requestJson<{ token?: string }>(path, {
      method: "GET",
    });
    if (!getResp?.token) {
      throw new ColabApiError("Colab unassign GET step did not return an XSRF token.");
    }
    await this.requestJson<unknown>(path, {
      method: "POST",
      headers: { "X-Goog-Colab-Token": getResp.token },
    });
  }
}
