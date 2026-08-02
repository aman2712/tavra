import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  DEFAULT_PRAVA_MCP_URL,
  type PravaCommerceToolName,
  type PravaCommerceTransport,
} from "./prava-commerce.js";

const execFileAsync = promisify(execFile);
const MCP_PROTOCOL_VERSION = "2025-06-18";
const AUTH_RETRY_SAFE_TOOLS = new Set<PravaCommerceToolName>([
  "ping",
  "list_agents",
  "shop_list_addresses",
  "shop_search",
  "shop_product",
  "get_payment_status",
]);

export interface StoredPravaOAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  tokenType: "Bearer";
  expiresAt: string;
  scopes: string[];
  clientId: string;
  tokenEndpoint: string;
  resource: string;
}

export interface PravaOAuthTokenStore {
  load(): Promise<StoredPravaOAuthTokens | null>;
  save(tokens: StoredPravaOAuthTokens): Promise<void>;
}

export class MacOsKeychainPravaTokenStore implements PravaOAuthTokenStore {
  constructor(
    private readonly service = "space.tavra.prava-mcp",
    private readonly account = "commerce-oauth",
  ) {}

  async load(): Promise<StoredPravaOAuthTokens | null> {
    if (process.platform !== "darwin") {
      throw new Error("The default Prava token store requires macOS Keychain");
    }
    try {
      const { stdout } = await execFileAsync("security", [
        "find-generic-password",
        "-a",
        this.account,
        "-s",
        this.service,
        "-w",
      ]);
      return parseStoredTokens(JSON.parse(stdout.trim()));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/could not be found|item not found|SecKeychainSearchCopyNext/i.test(message)) {
        return null;
      }
      throw new Error("Unable to read Prava OAuth credentials from macOS Keychain");
    }
  }

  async save(tokens: StoredPravaOAuthTokens): Promise<void> {
    if (process.platform !== "darwin") {
      throw new Error("The default Prava token store requires macOS Keychain");
    }
    const value = JSON.stringify(parseStoredTokens(tokens));
    await execFileAsync("security", [
      "add-generic-password",
      "-a",
      this.account,
      "-s",
      this.service,
      "-w",
      value,
      "-U",
    ]);
  }
}

export interface PravaStreamableHttpTransportOptions {
  tokenStore: PravaOAuthTokenStore;
  endpoint?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  clientName?: string;
  clientVersion?: string;
}

type JsonRpcResponse = {
  jsonrpc?: unknown;
  id?: unknown;
  result?: unknown;
  error?: unknown;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sanitizePravaErrorText(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b(?:pk|sk)_(?:test|live)_[A-Za-z0-9_-]+\b/g, "[redacted-key]")
    .replace(/\b\d{12,19}\b/g, "[redacted-card]")
    .replace(
      /\b(?:dynamic[_ -]?cvv|cvv|security code)\s*[:=]?\s*\d{3,4}\b/gi,
      "[redacted-security-code]",
    )
    .trim()
    .slice(0, 500);
}

class PravaMcpRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${sanitizePravaErrorText(message)}`);
    this.name = "PravaMcpRequestError";
  }
}

function parseStoredTokens(value: unknown): StoredPravaOAuthTokens {
  const parsed = record(value);
  if (!parsed) throw new Error("Stored Prava OAuth credentials are invalid");
  const accessToken =
    typeof parsed.accessToken === "string" ? parsed.accessToken.trim() : "";
  const refreshToken =
    typeof parsed.refreshToken === "string" && parsed.refreshToken.trim()
      ? parsed.refreshToken.trim()
      : null;
  const expiresAt =
    typeof parsed.expiresAt === "string" ? parsed.expiresAt.trim() : "";
  const clientId = typeof parsed.clientId === "string" ? parsed.clientId.trim() : "";
  const tokenEndpoint =
    typeof parsed.tokenEndpoint === "string" ? parsed.tokenEndpoint.trim() : "";
  const resource = typeof parsed.resource === "string" ? parsed.resource.trim() : "";
  const scopes = Array.isArray(parsed.scopes)
    ? parsed.scopes.filter(
        (scope): scope is string => typeof scope === "string" && Boolean(scope.trim()),
      )
    : [];
  if (
    !accessToken ||
    !clientId ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    !isTrustedHttpsUrl(tokenEndpoint) ||
    !isTrustedHttpsUrl(resource)
  ) {
    throw new Error("Stored Prava OAuth credentials are incomplete");
  }
  return {
    accessToken,
    refreshToken,
    tokenType: "Bearer",
    expiresAt: new Date(Date.parse(expiresAt)).toISOString(),
    scopes: [...new Set(scopes.map((scope) => scope.trim()))],
    clientId,
    tokenEndpoint,
    resource,
  };
}

function isTrustedHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function validateEndpoint(value: string): string {
  if (!isTrustedHttpsUrl(value)) {
    throw new Error("Prava MCP endpoint must be an HTTPS URL without embedded credentials");
  }
  return new URL(value).toString();
}

function normalizedAudiencePath(pathname: string): string {
  const normalized = pathname.replace(/\/+$/, "");
  return normalized || "/";
}

function assertTokenAudience(
  tokens: StoredPravaOAuthTokens,
  endpointValue: string,
): void {
  const resource = new URL(tokens.resource);
  const endpoint = new URL(endpointValue);
  const resourcePath = normalizedAudiencePath(resource.pathname);
  const endpointPath = normalizedAudiencePath(endpoint.pathname);
  const pathMatches =
    resourcePath === "/" ||
    endpointPath === resourcePath ||
    endpointPath.startsWith(`${resourcePath}/`);
  if (
    resource.origin !== endpoint.origin ||
    resource.search ||
    resource.hash ||
    !pathMatches
  ) {
    throw new Error(
      "Stored Prava OAuth credentials target a different MCP resource; run npm run prava:link-commerce again",
    );
  }
}

function parseScopes(value: unknown, fallback: string[]): string[] {
  if (typeof value === "string") {
    return [...new Set(value.split(/\s+/).filter(Boolean))];
  }
  return fallback;
}

function rpcErrorMessage(value: unknown): string {
  const parsed = record(value);
  const message = parsed && typeof parsed.message === "string" ? parsed.message.trim() : "";
  const code = parsed && (typeof parsed.code === "string" || typeof parsed.code === "number")
    ? String(parsed.code)
    : "unknown";
  return message
    ? `Prava MCP error ${code}: ${sanitizePravaErrorText(message)}`
    : `Prava MCP error ${code}`;
}

async function httpError(response: Response): Promise<PravaMcpRequestError> {
  const fallbackCode = `HTTP_${response.status}`;
  const payload = record(await response.clone().json().catch(() => null));
  const source = record(payload?.error) ?? payload;
  const rawCode = source?.code;
  const code =
    typeof rawCode === "string" && rawCode.trim()
      ? rawCode.trim()
      : typeof rawCode === "number" && Number.isFinite(rawCode)
        ? String(rawCode)
        : fallbackCode;
  const structuredMessage =
    typeof source?.message === "string" ? source.message.trim() : "";
  const textMessage = structuredMessage
    ? ""
    : sanitizePravaErrorText(await response.text().catch(() => ""));
  const message =
    structuredMessage ||
    textMessage ||
    `Prava MCP request failed with HTTP ${response.status}`;
  return new PravaMcpRequestError(code, message);
}

async function parseMcpResponse(response: Response): Promise<JsonRpcResponse | null> {
  if (response.status === 202 || response.status === 204) return null;
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("application/json")) {
    return (await response.json()) as JsonRpcResponse;
  }
  if (contentType.includes("text/event-stream")) {
    const text = await response.text();
    const dataPayloads = text
      .split(/\r?\n\r?\n/)
      .flatMap((event) =>
        event
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim()),
      )
      .filter((payload) => payload && payload !== "[DONE]");
    const last = dataPayloads.at(-1);
    if (!last) throw new Error("Prava MCP returned an empty event stream");
    return JSON.parse(last) as JsonRpcResponse;
  }
  const body = await response.text();
  if (!body.trim()) return null;
  try {
    return JSON.parse(body) as JsonRpcResponse;
  } catch {
    throw new Error("Prava MCP returned an unsupported response format");
  }
}

function unwrapToolResult(value: unknown): unknown {
  const result = record(value);
  if (!result) return value;
  if (result.isError === true) {
    const content = Array.isArray(result.content) ? result.content : [];
    const first = content.map(record).find((item) => item?.type === "text");
    const message = first && typeof first.text === "string" ? first.text.trim() : "";
    throw new Error(message || "Prava MCP tool call failed");
  }
  if (result.structuredContent !== undefined) return result.structuredContent;
  const content = Array.isArray(result.content) ? result.content : [];
  for (const block of content) {
    const parsed = record(block);
    if (parsed?.type !== "text" || typeof parsed.text !== "string") continue;
    try {
      return JSON.parse(parsed.text);
    } catch {
      continue;
    }
  }
  throw new Error("Prava MCP tool omitted structured JSON output");
}

class PravaMcpUnauthorizedError extends Error {
  constructor(readonly rejectedAccessToken: string) {
    super("Prava MCP request failed with HTTP 401");
    this.name = "PravaMcpUnauthorizedError";
  }
}

export class PravaStreamableHttpTransport implements PravaCommerceTransport {
  private readonly endpoint: string;
  private readonly request: typeof fetch;
  private readonly now: () => Date;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private tokens: StoredPravaOAuthTokens | null = null;
  private sessionId: string | null = null;
  private initialized = false;
  private nextId = 1;
  private initializePromise: Promise<void> | null = null;
  private refreshPromise: Promise<void> | null = null;

  constructor(private readonly options: PravaStreamableHttpTransportOptions) {
    this.endpoint = validateEndpoint(options.endpoint ?? DEFAULT_PRAVA_MCP_URL);
    this.request = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.clientName = options.clientName ?? "tavra";
    this.clientVersion = options.clientVersion ?? "0.1.0";
  }

  async getGrantedScopes(): Promise<ReadonlySet<string>> {
    const tokens = await this.loadTokens();
    return new Set(tokens.scopes);
  }

  async callTool(
    name: PravaCommerceToolName,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    // Refresh before checking the session. A proactive refresh invalidates the
    // previous MCP session, so initialization must happen after this step.
    await this.loadTokens();
    await this.initialize();
    try {
      const response = await this.rpc("tools/call", { name, arguments: args });
      return unwrapToolResult(response);
    } catch (error) {
      if (!(error instanceof PravaMcpUnauthorizedError)) throw error;
      await this.refreshTokens(error.rejectedAccessToken);
      if (!AUTH_RETRY_SAFE_TOOLS.has(name)) {
        throw new PravaMcpRequestError(
          "PRAVA_AUTH_RETRY_BLOCKED",
          `Prava authorization expired during ${name}. Tavra refreshed authorization but did not retry this mutating request.`,
        );
      }
      await this.initialize();
      const response = await this.rpc("tools/call", { name, arguments: args });
      return unwrapToolResult(response);
    }
  }

  private async loadTokens(): Promise<StoredPravaOAuthTokens> {
    if (!this.tokens) {
      this.tokens = await this.options.tokenStore.load();
    }
    if (!this.tokens) {
      throw new Error("Prava commerce is not linked. Run npm run prava:link-commerce");
    }
    assertTokenAudience(this.tokens, this.endpoint);
    const expiresSoon =
      Date.parse(this.tokens.expiresAt) <= this.now().getTime() + 30_000;
    if (expiresSoon) await this.refreshTokens();
    return this.tokens as StoredPravaOAuthTokens;
  }

  private async refreshTokens(rejectedAccessToken?: string): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    if (
      rejectedAccessToken &&
      this.tokens &&
      this.tokens.accessToken !== rejectedAccessToken
    ) {
      return;
    }
    const operation = this.performTokenRefresh();
    this.refreshPromise = operation;
    try {
      await operation;
    } finally {
      if (this.refreshPromise === operation) this.refreshPromise = null;
    }
  }

  private async performTokenRefresh(): Promise<void> {
    if (!this.tokens) {
      this.tokens = await this.options.tokenStore.load();
    }
    const current = this.tokens;
    if (!current?.refreshToken) {
      throw new Error("Prava OAuth access expired. Run npm run prava:link-commerce again");
    }
    assertTokenAudience(current, this.endpoint);
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: current.refreshToken,
      client_id: current.clientId,
      resource: current.resource,
    });
    const response = await this.request(current.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok) {
      throw new Error("Prava OAuth refresh failed; commerce remains disabled");
    }
    const payload = record(await response.json());
    const accessToken =
      payload && typeof payload.access_token === "string"
        ? payload.access_token.trim()
        : "";
    const expiresIn =
      payload && typeof payload.expires_in === "number" && payload.expires_in > 0
        ? payload.expires_in
        : null;
    if (!accessToken || !expiresIn) {
      throw new Error("Prava OAuth refresh returned an invalid token response");
    }
    this.tokens = {
      ...current,
      accessToken,
      refreshToken:
        payload && typeof payload.refresh_token === "string" && payload.refresh_token.trim()
          ? payload.refresh_token.trim()
          : current.refreshToken,
      expiresAt: new Date(this.now().getTime() + expiresIn * 1000).toISOString(),
      scopes: parseScopes(payload?.scope, current.scopes),
    };
    await this.options.tokenStore.save(this.tokens);
    this.sessionId = null;
    this.initialized = false;
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initializePromise) return this.initializePromise;
    const operation = (async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await this.initializeSession();
          return;
        } catch (error) {
          if (!(error instanceof PravaMcpUnauthorizedError) || attempt > 0) {
            throw error;
          }
          await this.refreshTokens(error.rejectedAccessToken);
        }
      }
    })();
    this.initializePromise = operation;
    try {
      await operation;
    } finally {
      if (this.initializePromise === operation) this.initializePromise = null;
    }
  }

  private async initializeSession(): Promise<void> {
    const result = record(
      await this.rpc("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: this.clientName,
          version: this.clientVersion,
        },
      }),
    );
    if (!result || typeof result.protocolVersion !== "string") {
      throw new Error("Prava MCP initialization returned an invalid response");
    }
    await this.rpc("notifications/initialized", {}, true);
    this.initialized = true;
  }

  private async rpc(
    method: string,
    params: Record<string, unknown>,
    notification = false,
  ): Promise<unknown> {
    const tokens = await this.loadTokens();
    const id = notification ? undefined : this.nextId++;
    const response = await this.request(this.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.accessToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": MCP_PROTOCOL_VERSION,
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        ...(notification ? {} : { id }),
        method,
        params,
      }),
    });
    if (response.status === 401) {
      throw new PravaMcpUnauthorizedError(tokens.accessToken);
    }
    if (!response.ok) {
      throw await httpError(response);
    }
    const returnedSessionId = response.headers.get("mcp-session-id")?.trim();
    if (returnedSessionId) this.sessionId = returnedSessionId;
    const payload = await parseMcpResponse(response);
    if (notification) return null;
    if (!payload || payload.jsonrpc !== "2.0" || payload.id !== id) {
      throw new Error("Prava MCP returned a mismatched JSON-RPC response");
    }
    if (payload.error !== undefined) throw new Error(rpcErrorMessage(payload.error));
    return payload.result;
  }
}
