import crypto from "crypto";
import WebSocket from "ws";
import { CLIENT_AGENT, FetchLike, RuntimeProxyInfo } from "./colabClient";

export const GPU_QUERY_PY = [
  "import subprocess",
  'r = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.used,memory.total", "--format=csv,noheader,nounits"], capture_output=True, text=True)',
  'if r.returncode == 0 and r.stdout.strip():',
  '    print("VRAM_INFO:" + r.stdout.strip().splitlines()[0])',
  "else:",
  '    print("VRAM_INFO:NONE")',
].join("\n");

export interface VramMetrics {
  status: "ok";
  gpuName: string;
  vramUsedGb: number;
  vramTotalGb: number;
  vramPct: number;
}

export interface VramBusy {
  status: "busy";
}

export interface VramUnavailable {
  status: "unavailable";
  reason?: string;
}

export type VramQueryResult = VramMetrics | VramBusy | VramUnavailable;

export interface JupyterKernelInfo {
  id: string;
  name?: string;
  execution_state?: string;
}

export interface WebSocketLike {
  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: WebSocket.RawData) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "close", listener: () => void): this;
  send(data: string): void;
  close(): void;
}

export type WebSocketFactory = (
  url: string,
  headers: Record<string, string>
) => WebSocketLike;

export interface QueryVramOptions {
  timeoutMs?: number;
  fetchFn?: FetchLike;
  wsFactory?: WebSocketFactory;
}

export function parseVramOutput(stdout: string): VramMetrics | undefined {
  const match = stdout.match(
    /VRAM_INFO:([^,\n]+),\s*([0-9.]+),\s*([0-9.]+)/
  );
  if (!match) return undefined;

  const gpuName = match[1].trim();
  const usedMb = Number(match[2]);
  const totalMb = Number(match[3]);
  if (!Number.isFinite(usedMb) || !Number.isFinite(totalMb) || totalMb <= 0) {
    return undefined;
  }

  const usedGb = usedMb / 1024;
  const totalGb = totalMb / 1024;
  const pct = Math.round((usedGb / totalGb) * 100);

  return {
    status: "ok",
    gpuName,
    vramUsedGb: Math.round(usedGb * 10) / 10,
    vramTotalGb: Math.round(totalGb * 10) / 10,
    vramPct: Math.min(100, Math.max(0, pct)),
  };
}

function toWebSocketUrl(baseHttpUrl: string, pathAndQuery: string): string {
  const url = new URL(pathAndQuery, baseHttpUrl.replace(/\/+$/, "") + "/");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function buildProxyHeaders(token: string): Record<string, string> {
  return {
    "X-Colab-Runtime-Proxy-Token": token,
    "X-Colab-Client-Agent": CLIENT_AGENT,
    Accept: "application/json",
  };
}

async function fetchJsonWithTimeout<T>(
  fetchFn: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveOrStartKernel(
  proxy: RuntimeProxyInfo,
  fetchFn: FetchLike,
  timeoutMs: number
): Promise<{ kernelId: string } | { busy: true }> {
  const baseUrl = proxy.url.replace(/\/+$/, "");
  const headers = buildProxyHeaders(proxy.token);

  const kernels = await fetchJsonWithTimeout<JupyterKernelInfo[]>(
    fetchFn,
    `${baseUrl}/api/kernels`,
    { method: "GET", headers },
    timeoutMs
  );

  if (Array.isArray(kernels) && kernels.length > 0) {
    const idleKernel = kernels.find(
      (k) =>
        k.id &&
        k.execution_state !== "busy" &&
        k.execution_state !== "dead" &&
        k.execution_state !== "restarting"
    );
    if (idleKernel) {
      return { kernelId: idleKernel.id };
    }
    if (kernels.some((k) => k.execution_state === "busy")) {
      return { busy: true };
    }
  }

  const created = await fetchJsonWithTimeout<JupyterKernelInfo>(
    fetchFn,
    `${baseUrl}/api/kernels`,
    {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "python3" }),
    },
    timeoutMs
  );

  if (!created?.id) {
    throw new Error("Jupyter server did not return a kernel ID.");
  }
  return { kernelId: created.id };
}

function executeOnKernelWs(
  proxy: RuntimeProxyInfo,
  kernelId: string,
  code: string,
  timeoutMs: number,
  wsFactory: WebSocketFactory
): Promise<string> {
  const sessionId = crypto.randomUUID();
  const msgId = crypto.randomUUID();
  const wsUrl = toWebSocketUrl(
    proxy.url,
    `api/kernels/${encodeURIComponent(kernelId)}/channels?session_id=${encodeURIComponent(sessionId)}&colab-runtime-proxy-token=${encodeURIComponent(proxy.token)}`
  );

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let stdout = "";
    const ws = wsFactory(wsUrl, buildProxyHeaders(proxy.token));

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // ignore close errors
      }
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => reject(new Error("VRAM_TIMEOUT")));
    }, timeoutMs);

    ws.on("open", () => {
      const payload = {
        header: {
          msg_id: msgId,
          username: CLIENT_AGENT,
          session: sessionId,
          date: new Date().toISOString(),
          msg_type: "execute_request",
          version: "5.3",
        },
        parent_header: {},
        metadata: {},
        content: {
          code,
          silent: true,
          store_history: false,
          user_expressions: {},
          allow_stdin: false,
          stop_on_error: true,
        },
        channel: "shell",
      };
      ws.send(JSON.stringify(payload));
    });

    ws.on("message", (rawData) => {
      if (settled) return;
      let msg: {
        msg_type?: string;
        header?: { msg_type?: string };
        parent_header?: { msg_id?: string };
        content?: {
          name?: string;
          text?: string;
          execution_state?: string;
          status?: string;
        };
      };
      try {
        const text =
          typeof rawData === "string"
            ? rawData
            : Buffer.isBuffer(rawData)
              ? rawData.toString("utf8")
              : Array.isArray(rawData)
                ? Buffer.concat(rawData).toString("utf8")
                : Buffer.from(rawData).toString("utf8");
        msg = JSON.parse(text);
      } catch {
        return;
      }

      const msgType = msg.header?.msg_type ?? msg.msg_type;
      if (
        msgType === "status" &&
        (msg.content?.execution_state === "dead" ||
          msg.content?.execution_state === "restarting")
      ) {
        finish(() => reject(new Error("Kernel restarted or died.")));
        return;
      }

      if (msg.parent_header?.msg_id !== msgId) {
        return;
      }

      if (msgType === "stream" && msg.content?.name === "stdout" && msg.content.text) {
        stdout += msg.content.text;
        if (stdout.includes("VRAM_INFO:")) {
          const lineEnd = stdout.indexOf("\n", stdout.indexOf("VRAM_INFO:"));
          if (lineEnd !== -1) {
            finish(() => resolve(stdout));
            return;
          }
        }
      }

      if (
        (msgType === "status" && msg.content?.execution_state === "idle") ||
        msgType === "execute_reply"
      ) {
        finish(() => resolve(stdout));
      }
    });

    ws.on("error", (err) => {
      finish(() => reject(err));
    });

    ws.on("close", () => {
      finish(() => resolve(stdout));
    });
  });
}

export async function queryGpuVram(
  proxy: RuntimeProxyInfo,
  options: QueryVramOptions = {}
): Promise<VramQueryResult> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const fetchFn: FetchLike =
    options.fetchFn ?? ((input, init) => fetch(input, init));
  const wsFactory: WebSocketFactory =
    options.wsFactory ?? ((url, headers) => new WebSocket(url, { headers }));

  try {
    const kernel = await resolveOrStartKernel(proxy, fetchFn, timeoutMs);
    if ("busy" in kernel) {
      return { status: "busy" };
    }

    const stdout = await executeOnKernelWs(
      proxy,
      kernel.kernelId,
      GPU_QUERY_PY,
      timeoutMs,
      wsFactory
    );
    const parsed = parseVramOutput(stdout);
    if (!parsed) {
      return { status: "unavailable", reason: "No NVIDIA GPU metrics returned." };
    }
    return parsed;
  } catch (err) {
    if (err instanceof Error && err.message === "VRAM_TIMEOUT") {
      return { status: "busy" };
    }
    return {
      status: "unavailable",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
