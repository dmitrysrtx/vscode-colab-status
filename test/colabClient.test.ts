import test from "node:test";
import assert from "node:assert/strict";
import {
  buildColabBrowserUrl,
  ColabApiError,
  ColabAuthError,
  ColabClient,
  parseRuntimeSpec,
  resolveAssignShape,
  stripXssiPrefix,
  TooManyAssignmentsError,
  uuidToWebSafeBase64,
} from "../src/colabClient";

function mockResponse(
  body: string,
  status = 200,
  statusText = "OK"
): Response {
  return new Response(body, { status, statusText });
}

test("stripXssiPrefix removes Colab XSSI header", () => {
  assert.equal(stripXssiPrefix(")]}'\n{\"ok\":true}"), "{\"ok\":true}");
  assert.equal(stripXssiPrefix("{\"ok\":true}"), "{\"ok\":true}");
});

test("uuidToWebSafeBase64 produces 44-char web-safe notebook hash", () => {
  const nbh = uuidToWebSafeBase64("12345678-1234-1234-1234-1234567890ab");
  assert.equal(nbh.length, 44);
  assert.equal(nbh, "12345678_1234_1234_1234_1234567890ab........");
});

test("resolveAssignShape ignores highMem for single-shape accelerators", () => {
  assert.equal(resolveAssignShape("T4", true), "HIGH_RAM");
  assert.equal(resolveAssignShape("A100", true), "HIGH_RAM");
  assert.equal(resolveAssignShape("L4", true), undefined);
  assert.equal(resolveAssignShape("V5E1", true), undefined);
  assert.equal(resolveAssignShape("V6E1", true), undefined);
  assert.equal(resolveAssignShape("T4", false), undefined);
});

test("parseRuntimeSpec parses GPU, TPU, CPU, and High-RAM suffix", () => {
  assert.deepEqual(parseRuntimeSpec("T4"), {
    variant: "GPU",
    accelerator: "T4",
    highMem: false,
  });
  assert.deepEqual(parseRuntimeSpec("A100:HM"), {
    variant: "GPU",
    accelerator: "A100",
    highMem: true,
  });
  assert.deepEqual(parseRuntimeSpec("TPU:V5E1"), {
    variant: "TPU",
    accelerator: "V5E1",
    highMem: false,
  });
  assert.deepEqual(parseRuntimeSpec("CPU"), {
    variant: "DEFAULT",
    accelerator: "NONE",
    highMem: false,
  });
});

test("buildColabBrowserUrl formats dbu query and datalabBackendUrl fragment", () => {
  const url = buildColabBrowserUrl("m-s-abc123");
  assert.equal(
    url,
    "https://colab.research.google.com/notebooks/empty.ipynb?dbu=%2Ftun%2Fm%2Fm-s-abc123#datalabBackendUrl=https://colab.research.google.com/tun/m/m-s-abc123"
  );
});

test("ColabClient.listAssignments parses XSSI response", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = new ColabClient({
    getAccessToken: async () => "test-token",
    fetchFn: async (url, init) => {
      calls.push({ url, init });
      return mockResponse(
        ")]}'\n" +
          JSON.stringify({
            assignments: [
              {
                endpoint: "m-s-123",
                accelerator: "T4",
                variant: 1,
                machineShape: 1,
                runtimeProxyInfo: {
                  token: "proxy-tok",
                  tokenExpiresInSeconds: 3600,
                  url: "https://abc.prod.colab.dev",
                },
              },
            ],
          })
      );
    },
  });

  const list = await client.listAssignments();
  assert.equal(list.length, 1);
  assert.equal(list[0].endpoint, "m-s-123");
  assert.equal(list[0].accelerator, "T4");
  assert.equal(list[0].variant, "GPU");
  assert.equal(list[0].machineShape, "HIGH_RAM");
  assert.equal(list[0].runtimeProxyInfo.url, "https://abc.prod.colab.dev");
  assert.match(calls[0].url, /\/tun\/m\/assignments\?authuser=0$/);
  assert.equal(
    (calls[0].init?.headers as Record<string, string>).Authorization,
    "Bearer test-token"
  );
});

test("ColabClient.getCcuInfo parses Compute Units balance and rate", async () => {
  const client = new ColabClient({
    getAccessToken: async () => "test-token",
    fetchFn: async () =>
      mockResponse(
        ")]}'\n" +
          JSON.stringify({
            currentBalance: 42.5,
            consumptionRateHourly: 1.96,
            assignmentsCount: 1,
          })
      ),
  });

  const ccu = await client.getCcuInfo();
  assert.deepEqual(ccu, {
    currentBalance: 42.5,
    consumptionRateHourly: 1.96,
    assignmentsCount: 1,
  });
});

test("ColabClient.assign executes 2-step XSRF GET+POST with shape=hm", async () => {
  const calls: Array<{ method?: string; url: string; headers?: Record<string, string> }> = [];
  const client = new ColabClient({
    getAccessToken: async () => "tok",
    fetchFn: async (url, init) => {
      calls.push({
        method: init?.method,
        url,
        headers: init?.headers as Record<string, string>,
      });
      if (init?.method === "GET") {
        return mockResponse(")]}'\n" + JSON.stringify({ token: "xsrf-123" }));
      }
      return mockResponse(
        ")]}'\n" +
          JSON.stringify({
            endpoint: "m-s-new",
            accelerator: "A100",
            variant: 1,
            runtimeProxyInfo: {
              token: "ptok",
              tokenExpiresInSeconds: 3600,
              url: "https://new.prod.colab.dev",
            },
          })
      );
    },
  });

  const assigned = await client.assign({
    variant: "GPU",
    accelerator: "A100",
    highMem: true,
    notebookHash: "12345678-1234-1234-1234-1234567890ab",
  });

  assert.equal(assigned.endpoint, "m-s-new");
  assert.equal(assigned.machineShape, "HIGH_RAM");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[1].method, "POST");
  assert.match(calls[1].url, /accelerator=A100/);
  assert.match(calls[1].url, /shape=hm/);
  assert.equal(calls[1].headers?.["X-Goog-Colab-Token"], "xsrf-123");
});

test("ColabClient.assign throws TooManyAssignmentsError on HTTP 412", async () => {
  const client = new ColabClient({
    getAccessToken: async () => "tok",
    fetchFn: async (_url, init) => {
      if (init?.method === "GET") {
        return mockResponse(")]}'\n" + JSON.stringify({ token: "xsrf" }));
      }
      return mockResponse("precondition failed", 412, "Precondition Failed");
    },
  });

  await assert.rejects(
    () => client.assign({ variant: "GPU", accelerator: "T4" }),
    TooManyAssignmentsError
  );
});

test("ColabClient.listAssignments throws ColabAuthError on HTTP 401", async () => {
  const client = new ColabClient({
    getAccessToken: async () => "expired",
    fetchFn: async () => mockResponse("Unauthorized", 401, "Unauthorized"),
  });

  await assert.rejects(() => client.listAssignments(), ColabAuthError);
});

test("ColabClient.unassign performs 2-step XSRF GET+POST", async () => {
  const methods: string[] = [];
  let postToken = "";
  const client = new ColabClient({
    getAccessToken: async () => "tok",
    fetchFn: async (_url, init) => {
      methods.push(init?.method ?? "GET");
      if (init?.method === "GET") {
        return mockResponse(")]}'\n" + JSON.stringify({ token: "unassign-xsrf" }));
      }
      postToken = (init?.headers as Record<string, string>)["X-Goog-Colab-Token"];
      return mockResponse("");
    },
  });

  await client.unassign("m-s-123");
  assert.deepEqual(methods, ["GET", "POST"]);
  assert.equal(postToken, "unassign-xsrf");
});

test("ColabClient.assign wraps HTTP 400 accelerator rejection", async () => {
  const client = new ColabClient({
    getAccessToken: async () => "tok",
    fetchFn: async (_url, init) => {
      if (init?.method === "GET") {
        return mockResponse(")]}'\n" + JSON.stringify({ token: "xsrf" }));
      }
      return mockResponse("Bad Request", 400, "Bad Request");
    },
  });

  await assert.rejects(
    () => client.assign({ variant: "GPU", accelerator: "H100" }),
    (err: unknown) => {
      assert.ok(err instanceof ColabApiError);
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /H100/);
      return true;
    }
  );
});
