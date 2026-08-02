import assert from "node:assert/strict";
import test from "node:test";

import {
  PravaStreamableHttpTransport,
  type PravaOAuthTokenStore,
  type StoredPravaOAuthTokens,
} from "../src/prava-mcp.js";

const now = new Date("2026-08-02T12:00:00.000Z");
const endpoint = "https://mcp.pay.prava.space/mcp";
const tokenEndpoint = "https://auth.prava.space/token";

function storedTokens(accessToken = "access-old"): StoredPravaOAuthTokens {
  return {
    accessToken,
    refreshToken: "refresh-token",
    tokenType: "Bearer",
    expiresAt: "2026-08-02T13:00:00.000Z",
    scopes: ["payments:read", "payments:write", "checkout:run"],
    clientId: "tavra-client",
    tokenEndpoint,
    resource: endpoint,
  };
}

function memoryTokenStore(initial = storedTokens()) {
  let tokens = structuredClone(initial);
  let saves = 0;
  const store: PravaOAuthTokenStore = {
    async load() {
      return structuredClone(tokens);
    },
    async save(next) {
      tokens = structuredClone(next);
      saves += 1;
    },
  };
  return {
    store,
    get saves() {
      return saves;
    },
    get tokens() {
      return structuredClone(tokens);
    },
  };
}

interface FetchCall {
  target: "mcp" | "token";
  rpcMethod: string | null;
  authorization: string | null;
  sessionId: string | null;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function rpcBody(init?: RequestInit): Record<string, unknown> {
  const body = init?.body;
  assert.equal(typeof body, "string");
  return JSON.parse(body as string) as Record<string, unknown>;
}

function rpcResponse(
  id: unknown,
  result: unknown,
  sessionId?: string,
): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id, result }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
    },
  );
}

function refreshResponse(): Response {
  return new Response(
    JSON.stringify({
      access_token: "access-new",
      refresh_token: "refresh-new",
      expires_in: 3600,
      scope: "payments:read payments:write checkout:run",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

test("a tools/call 401 refreshes OAuth, creates a new MCP session, then retries once", async () => {
  const tokenStore = memoryTokenStore();
  const calls: FetchCall[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = requestUrl(input);
    if (url === tokenEndpoint) {
      calls.push({
        target: "token",
        rpcMethod: null,
        authorization: null,
        sessionId: null,
      });
      return refreshResponse();
    }
    assert.equal(url, endpoint);
    const body = rpcBody(init);
    const headers = new Headers(init?.headers);
    const authorization = headers.get("authorization");
    const sessionId = headers.get("mcp-session-id");
    const method = String(body.method);
    calls.push({
      target: "mcp",
      rpcMethod: method,
      authorization,
      sessionId,
    });
    if (method === "initialize") {
      return rpcResponse(
        body.id,
        { protocolVersion: "2025-06-18", capabilities: {} },
        authorization === "Bearer access-old" ? "session-old" : "session-new",
      );
    }
    if (method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    assert.equal(method, "tools/call");
    if (authorization === "Bearer access-old") {
      return new Response(null, { status: 401 });
    }
    return rpcResponse(body.id, {
      structuredContent: { pong: true },
      content: [],
    });
  };
  const transport = new PravaStreamableHttpTransport({
    tokenStore: tokenStore.store,
    endpoint,
    fetch: request,
    now: () => now,
  });

  assert.deepEqual(await transport.callTool("ping", {}), { pong: true });
  assert.equal(tokenStore.saves, 1);
  assert.equal(tokenStore.tokens.accessToken, "access-new");
  assert.deepEqual(
    calls.map((call) => call.rpcMethod ?? "oauth_refresh"),
    [
      "initialize",
      "notifications/initialized",
      "tools/call",
      "oauth_refresh",
      "initialize",
      "notifications/initialized",
      "tools/call",
    ],
  );
  assert.equal(calls[4]?.sessionId, null);
  assert.equal(calls[5]?.sessionId, "session-new");
  assert.equal(calls[6]?.sessionId, "session-new");
  assert.equal(calls[6]?.authorization, "Bearer access-new");
});

test("does not retry a mutating tool after a tools/call 401", async () => {
  const tokenStore = memoryTokenStore();
  const calls: FetchCall[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = requestUrl(input);
    if (url === tokenEndpoint) {
      calls.push({
        target: "token",
        rpcMethod: null,
        authorization: null,
        sessionId: null,
      });
      return refreshResponse();
    }
    const body = rpcBody(init);
    const headers = new Headers(init?.headers);
    const method = String(body.method);
    calls.push({
      target: "mcp",
      rpcMethod: method,
      authorization: headers.get("authorization"),
      sessionId: headers.get("mcp-session-id"),
    });
    if (method === "initialize") {
      return rpcResponse(
        body.id,
        { protocolVersion: "2025-06-18", capabilities: {} },
        "session-old",
      );
    }
    if (method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    assert.equal(method, "tools/call");
    return new Response(null, { status: 401 });
  };
  const transport = new PravaStreamableHttpTransport({
    tokenStore: tokenStore.store,
    endpoint,
    fetch: request,
    now: () => now,
  });

  await assert.rejects(
    () => transport.callTool("create_payment_session", { quote_id: "quote-1" }),
    /PRAVA_AUTH_RETRY_BLOCKED.*did not retry/i,
  );
  assert.equal(tokenStore.saves, 1);
  assert.equal(
    calls.filter((call) => call.rpcMethod === "tools/call").length,
    1,
  );
  assert.deepEqual(
    calls.map((call) => call.rpcMethod ?? "oauth_refresh"),
    [
      "initialize",
      "notifications/initialized",
      "tools/call",
      "oauth_refresh",
    ],
  );
});

test("surfaces MCP HTTP error code and message while redacting secrets", async () => {
  const transport = new PravaStreamableHttpTransport({
    tokenStore: memoryTokenStore().store,
    endpoint,
    now: () => now,
    fetch: async (input, init) => {
      assert.equal(requestUrl(input), endpoint);
      const body = rpcBody(init);
      if (body.method === "initialize") {
        return rpcResponse(
          body.id,
          { protocolVersion: "2025-06-18", capabilities: {} },
          "session-errors",
        );
      }
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      return Response.json(
        {
          error: {
            code: "RATE_LIMITED",
            message: "Wait before polling; Bearer secret-access-token",
          },
        },
        { status: 429 },
      );
    },
  });

  await assert.rejects(
    () => transport.callTool("get_payment_status", { session_id: "pays-1" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /RATE_LIMITED: Wait before polling/);
      assert.match(error.message, /Bearer \[redacted\]/);
      assert.doesNotMatch(error.message, /secret-access-token/);
      return true;
    },
  );
});

test("a 401 during initialized notification restarts the handshake without deadlock", async () => {
  const tokenStore = memoryTokenStore();
  const calls: FetchCall[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = requestUrl(input);
    if (url === tokenEndpoint) {
      calls.push({
        target: "token",
        rpcMethod: null,
        authorization: null,
        sessionId: null,
      });
      return refreshResponse();
    }
    const body = rpcBody(init);
    const headers = new Headers(init?.headers);
    const authorization = headers.get("authorization");
    const sessionId = headers.get("mcp-session-id");
    const method = String(body.method);
    calls.push({
      target: "mcp",
      rpcMethod: method,
      authorization,
      sessionId,
    });
    if (method === "initialize") {
      return rpcResponse(
        body.id,
        { protocolVersion: "2025-06-18", capabilities: {} },
        authorization === "Bearer access-old" ? "session-old" : "session-new",
      );
    }
    if (
      method === "notifications/initialized" &&
      authorization === "Bearer access-old"
    ) {
      return new Response(null, { status: 401 });
    }
    if (method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    return rpcResponse(body.id, {
      structuredContent: { pong: true },
      content: [],
    });
  };
  const transport = new PravaStreamableHttpTransport({
    tokenStore: tokenStore.store,
    endpoint,
    fetch: request,
    now: () => now,
  });
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error("MCP initialization deadlocked")),
      1_000,
    );
  });
  try {
    assert.deepEqual(
      await Promise.race([transport.callTool("ping", {}), timeout]),
      { pong: true },
    );
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
  assert.equal(tokenStore.saves, 1);
  assert.deepEqual(
    calls.map((call) => call.rpcMethod ?? "oauth_refresh"),
    [
      "initialize",
      "notifications/initialized",
      "oauth_refresh",
      "initialize",
      "notifications/initialized",
      "tools/call",
    ],
  );
  assert.equal(calls[3]?.sessionId, null);
  assert.equal(calls[4]?.sessionId, "session-new");
});

test("a proactive OAuth refresh happens before MCP session validation", async () => {
  const tokenStore = memoryTokenStore();
  let currentTime = now;
  const calls: FetchCall[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = requestUrl(input);
    if (url === tokenEndpoint) {
      calls.push({
        target: "token",
        rpcMethod: null,
        authorization: null,
        sessionId: null,
      });
      return refreshResponse();
    }
    const body = rpcBody(init);
    const headers = new Headers(init?.headers);
    const authorization = headers.get("authorization");
    const sessionId = headers.get("mcp-session-id");
    const method = String(body.method);
    calls.push({
      target: "mcp",
      rpcMethod: method,
      authorization,
      sessionId,
    });
    if (method === "initialize") {
      return rpcResponse(
        body.id,
        { protocolVersion: "2025-06-18", capabilities: {} },
        authorization === "Bearer access-old" ? "session-old" : "session-new",
      );
    }
    if (method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    if (authorization === "Bearer access-old") {
      assert.equal(sessionId, "session-old");
    } else {
      assert.equal(sessionId, "session-new");
    }
    return rpcResponse(body.id, {
      structuredContent: { token: authorization },
      content: [],
    });
  };
  const transport = new PravaStreamableHttpTransport({
    tokenStore: tokenStore.store,
    endpoint,
    fetch: request,
    now: () => currentTime,
  });

  assert.deepEqual(await transport.callTool("ping", {}), {
    token: "Bearer access-old",
  });
  currentTime = new Date("2026-08-02T12:59:45.000Z");
  assert.deepEqual(await transport.callTool("ping", {}), {
    token: "Bearer access-new",
  });
  assert.deepEqual(
    calls.map((call) => call.rpcMethod ?? "oauth_refresh"),
    [
      "initialize",
      "notifications/initialized",
      "tools/call",
      "oauth_refresh",
      "initialize",
      "notifications/initialized",
      "tools/call",
    ],
  );
  assert.equal(calls[4]?.sessionId, null);
  assert.equal(calls[6]?.sessionId, "session-new");
});

test("refuses to send a stored bearer token to a different MCP origin", async () => {
  let fetchCalls = 0;
  const transport = new PravaStreamableHttpTransport({
    tokenStore: memoryTokenStore({
      ...storedTokens(),
      resource: "https://mcp.pay.prava.space/mcp",
    }).store,
    endpoint: "https://merchant-attacker.example/mcp",
    fetch: async () => {
      fetchCalls += 1;
      throw new Error("Bearer token must not be sent");
    },
    now: () => now,
  });

  await assert.rejects(
    () => transport.callTool("ping", {}),
    /different MCP resource/i,
  );
  assert.equal(fetchCalls, 0);
});

test("refuses a stored token for another protected path on the same origin", async () => {
  let fetchCalls = 0;
  const transport = new PravaStreamableHttpTransport({
    tokenStore: memoryTokenStore({
      ...storedTokens(),
      resource: "https://mcp.pay.prava.space/other-resource",
    }).store,
    endpoint,
    fetch: async () => {
      fetchCalls += 1;
      throw new Error("Bearer token must not be sent");
    },
    now: () => now,
  });

  await assert.rejects(
    () => transport.callTool("ping", {}),
    /different MCP resource/i,
  );
  assert.equal(fetchCalls, 0);
});
