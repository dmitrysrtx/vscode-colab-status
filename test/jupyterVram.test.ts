import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";
import {
  parseVramOutput,
  queryGpuVram,
  WebSocketLike,
} from "../src/jupyterVram";

class MockWebSocket extends EventEmitter implements WebSocketLike {
  sent: string[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(data);
    const parsed = JSON.parse(data);
    const msgId = parsed.header.msg_id;
    setImmediate(() => {
      this.emit(
        "message",
        JSON.stringify({
          header: { msg_type: "stream" },
          parent_header: { msg_id: msgId },
          content: {
            name: "stdout",
            text: "VRAM_INFO:Tesla T4, 3072, 15360\n",
          },
        })
      );
      this.emit(
        "message",
        JSON.stringify({
          header: { msg_type: "status" },
          parent_header: { msg_id: msgId },
          content: { execution_state: "idle" },
        })
      );
    });
  }

  close(): void {
    this.closed = true;
  }
}

test("parseVramOutput parses nvidia-smi output into GB and percentage", () => {
  const metrics = parseVramOutput("VRAM_INFO:NVIDIA A100-SXM4-40GB, 10240, 40960\n");
  assert.deepEqual(metrics, {
    status: "ok",
    gpuName: "NVIDIA A100-SXM4-40GB",
    vramUsedGb: 10,
    vramTotalGb: 40,
    vramPct: 25,
  });

  assert.equal(parseVramOutput("VRAM_INFO:NONE\n"), undefined);
});

test("queryGpuVram returns busy immediately when all kernels are busy", async () => {
  let wsOpened = false;
  const result = await queryGpuVram(
    {
      url: "https://rt.prod.colab.dev",
      token: "proxy-tok",
      tokenExpiresInSeconds: 3600,
    },
    {
      fetchFn: async () =>
        new Response(
          JSON.stringify([{ id: "k-1", name: "python3", execution_state: "busy" }]),
          { status: 200 }
        ),
      wsFactory: () => {
        wsOpened = true;
        return new MockWebSocket();
      },
    }
  );

  assert.deepEqual(result, { status: "busy" });
  assert.equal(wsOpened, false);
});

test("queryGpuVram executes nvidia-smi on idle kernel via WebSocket", async () => {
  let capturedUrl = "";
  let capturedHeaders: Record<string, string> = {};
  const mockWs = new MockWebSocket();

  const result = await queryGpuVram(
    {
      url: "https://rt.prod.colab.dev",
      token: "proxy-tok",
      tokenExpiresInSeconds: 3600,
    },
    {
      fetchFn: async () =>
        new Response(
          JSON.stringify([{ id: "k-idle", name: "python3", execution_state: "idle" }]),
          { status: 200 }
        ),
      wsFactory: (url, headers) => {
        capturedUrl = url;
        capturedHeaders = headers;
        setImmediate(() => mockWs.emit("open"));
        return mockWs;
      },
    }
  );

  assert.deepEqual(result, {
    status: "ok",
    gpuName: "Tesla T4",
    vramUsedGb: 3,
    vramTotalGb: 15,
    vramPct: 20,
  });
  assert.match(capturedUrl, /^wss:\/\/rt\.prod\.colab\.dev\/api\/kernels\/k-idle\/channels\?/);
  assert.match(capturedUrl, /colab-runtime-proxy-token=proxy-tok/);
  assert.equal(capturedHeaders["X-Colab-Runtime-Proxy-Token"], "proxy-tok");
  assert.equal(mockWs.closed, true);
});
