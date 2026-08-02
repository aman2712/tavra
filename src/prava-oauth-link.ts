import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

import { REQUIRED_PRAVA_COMMERCE_SCOPES } from "./commerce.js";
import { DEFAULT_PRAVA_MCP_URL } from "./prava-commerce.js";
import type {
  PravaOAuthTokenStore,
  StoredPravaOAuthTokens,
} from "./prava-mcp.js";

interface ProtectedResourceMetadata {
  resource: string;
  authorizationServers: string[];
  scopesSupported: string[];
}

interface AuthorizationServerMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
  scopesSupported: string[];
  codeChallengeMethodsSupported: string[];
}

interface OAuthClientRegistration {
  clientId: string;
}

export interface LinkPravaCommerceOptions {
  tokenStore: PravaOAuthTokenStore;
  endpoint?: string;
  fetch?: typeof fetch;
  openBrowser: (url: string) => Promise<void>;
  callbackTimeoutMs?: number;
  now?: () => Date;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} was not a JSON object`);
  }
  return value as UnknownRecord;
}

function stringValue(record: UnknownRecord, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`OAuth metadata omitted ${key}`);
  }
  return value.trim();
}

function optionalStrings(record: UnknownRecord, key: string): string[] {
  const value = record[key];
  return Array.isArray(value)
    ? value.filter(
        (item): item is string => typeof item === "string" && Boolean(item.trim()),
      )
    : [];
}

function trustedHttps(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is not a URL`);
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) {
    throw new Error(`${label} must use HTTPS without embedded credentials`);
  }
  return url.toString();
}

function wellKnownUrl(issuer: URL, suffix: string): string {
  const issuerPath = issuer.pathname === "/" ? "" : issuer.pathname.replace(/\/$/, "");
  return new URL(`/.well-known/${suffix}${issuerPath}`, issuer.origin).toString();
}

async function jsonOrThrow(response: Response, label: string): Promise<UnknownRecord> {
  if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}`);
  return asRecord(await response.json(), label);
}

async function discoverProtectedResource(
  endpoint: URL,
  request: typeof fetch,
): Promise<ProtectedResourceMetadata> {
  const candidates = [
    wellKnownUrl(endpoint, "oauth-protected-resource"),
    new URL("/.well-known/oauth-protected-resource", endpoint.origin).toString(),
  ];
  let metadata: UnknownRecord | null = null;
  for (const candidate of [...new Set(candidates)]) {
    const response = await request(candidate, { headers: { accept: "application/json" } });
    if (!response.ok) continue;
    metadata = asRecord(await response.json(), "Prava protected-resource metadata");
    break;
  }
  if (!metadata) {
    throw new Error("Prava OAuth protected-resource metadata could not be discovered");
  }
  const resource = trustedHttps(
    stringValue(metadata, "resource"),
    "Prava protected resource",
  );
  const authorizationServers = optionalStrings(metadata, "authorization_servers").map(
    (value) => trustedHttps(value, "Prava authorization server"),
  );
  if (authorizationServers.length === 0) {
    throw new Error("Prava OAuth metadata did not list an authorization server");
  }
  return {
    resource,
    authorizationServers,
    scopesSupported: optionalStrings(metadata, "scopes_supported"),
  };
}

async function discoverAuthorizationServer(
  issuerValue: string,
  request: typeof fetch,
): Promise<AuthorizationServerMetadata> {
  const issuer = new URL(issuerValue);
  const candidates = [
    wellKnownUrl(issuer, "oauth-authorization-server"),
    new URL(".well-known/oauth-authorization-server", `${issuer.toString().replace(/\/$/, "")}/`).toString(),
  ];
  let metadata: UnknownRecord | null = null;
  for (const candidate of [...new Set(candidates)]) {
    const response = await request(candidate, { headers: { accept: "application/json" } });
    if (!response.ok) continue;
    metadata = asRecord(await response.json(), "Prava authorization metadata");
    break;
  }
  if (!metadata) {
    throw new Error("Prava OAuth authorization-server metadata could not be discovered");
  }
  const codeChallengeMethodsSupported = optionalStrings(
    metadata,
    "code_challenge_methods_supported",
  );
  if (!codeChallengeMethodsSupported.includes("S256")) {
    throw new Error("Prava OAuth server did not advertise PKCE S256 support");
  }
  return {
    issuer: trustedHttps(stringValue(metadata, "issuer"), "Prava OAuth issuer"),
    authorizationEndpoint: trustedHttps(
      stringValue(metadata, "authorization_endpoint"),
      "Prava authorization endpoint",
    ),
    tokenEndpoint: trustedHttps(
      stringValue(metadata, "token_endpoint"),
      "Prava token endpoint",
    ),
    registrationEndpoint: trustedHttps(
      stringValue(metadata, "registration_endpoint"),
      "Prava client registration endpoint",
    ),
    scopesSupported: optionalStrings(metadata, "scopes_supported"),
    codeChallengeMethodsSupported,
  };
}

async function registerClient(
  metadata: AuthorizationServerMetadata,
  redirectUri: string,
  request: typeof fetch,
): Promise<OAuthClientRegistration> {
  const response = await request(metadata.registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "Tavra live commerce",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const payload = await jsonOrThrow(response, "Prava dynamic client registration");
  return { clientId: stringValue(payload, "client_id") };
}

function base64Url(value: Buffer): string {
  return value.toString("base64url");
}

function startCallbackServer(timeoutMs: number): Promise<{
  redirectUri: string;
  waitForCode: (expectedState: string) => Promise<string>;
  close: () => Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    let callbackResolve: ((code: string) => void) | null = null;
    let callbackReject: ((error: Error) => void) | null = null;
    let expectedStateValue: string | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const server: Server = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      if (requestUrl.pathname !== "/oauth/callback") {
        response.writeHead(404).end("Not found");
        return;
      }
      const state = requestUrl.searchParams.get("state");
      const error = requestUrl.searchParams.get("error");
      const code = requestUrl.searchParams.get("code");
      if (!callbackResolve || !callbackReject || !expectedStateValue) {
        response.writeHead(409).end("OAuth callback was not expected");
        return;
      }
      if (state !== expectedStateValue) {
        response.writeHead(400).end("OAuth state mismatch");
        callbackReject(new Error("Prava OAuth callback state did not match"));
        return;
      }
      if (error || !code) {
        response.writeHead(400).end("Prava access was not approved");
        callbackReject(new Error(`Prava OAuth authorization failed${error ? `: ${error}` : ""}`));
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        "<!doctype html><title>Tavra linked</title><main style='font-family:system-ui;padding:3rem'><h1>Tavra is linked to Prava</h1><p>You can close this tab and return to the terminal.</p></main>",
      );
      callbackResolve(code);
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not start the local OAuth callback server"));
        return;
      }
      resolve({
        redirectUri: `http://127.0.0.1:${address.port}/oauth/callback`,
        waitForCode(expectedState) {
          expectedStateValue = expectedState;
          return new Promise<string>((resolveCode, rejectCode) => {
            callbackResolve = (code) => {
              if (timeout) clearTimeout(timeout);
              resolveCode(code);
            };
            callbackReject = (error) => {
              if (timeout) clearTimeout(timeout);
              rejectCode(error);
            };
            timeout = setTimeout(() => {
              rejectCode(new Error("Prava OAuth approval timed out"));
            }, timeoutMs);
          });
        },
        close() {
          if (timeout) clearTimeout(timeout);
          return new Promise<void>((resolveClose, rejectClose) => {
            server.close((error) => (error ? rejectClose(error) : resolveClose()));
          });
        },
      });
    });
  });
}

export async function linkPravaCommerce(
  options: LinkPravaCommerceOptions,
): Promise<StoredPravaOAuthTokens> {
  const request = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const endpoint = new URL(trustedHttps(
    options.endpoint ?? DEFAULT_PRAVA_MCP_URL,
    "Prava MCP endpoint",
  ));
  const callback = await startCallbackServer(options.callbackTimeoutMs ?? 300_000);
  try {
    const resource = await discoverProtectedResource(endpoint, request);
    const authorization = await discoverAuthorizationServer(
      resource.authorizationServers[0] as string,
      request,
    );
    const advertisedScopes = new Set([
      ...resource.scopesSupported,
      ...authorization.scopesSupported,
    ]);
    if (
      advertisedScopes.size > 0 &&
      REQUIRED_PRAVA_COMMERCE_SCOPES.some((scope) => !advertisedScopes.has(scope))
    ) {
      throw new Error("Prava OAuth server does not advertise all required commerce scopes");
    }
    const client = await registerClient(authorization, callback.redirectUri, request);
    const verifier = base64Url(randomBytes(48));
    const challenge = base64Url(createHash("sha256").update(verifier).digest());
    const state = base64Url(randomBytes(24));
    const scope = REQUIRED_PRAVA_COMMERCE_SCOPES.join(" ");
    const authorizationUrl = new URL(authorization.authorizationEndpoint);
    authorizationUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: callback.redirectUri,
      scope,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: resource.resource,
    }).toString();
    const codePromise = callback.waitForCode(state);
    await options.openBrowser(authorizationUrl.toString());
    const code = await codePromise;
    const tokenResponse = await request(authorization.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: callback.redirectUri,
        client_id: client.clientId,
        code_verifier: verifier,
        resource: resource.resource,
      }),
    });
    const tokenPayload = await jsonOrThrow(tokenResponse, "Prava token exchange");
    const accessToken = stringValue(tokenPayload, "access_token");
    const tokenType = stringValue(tokenPayload, "token_type").toLowerCase();
    const expiresIn = tokenPayload.expires_in;
    if (tokenType !== "bearer" || typeof expiresIn !== "number" || expiresIn <= 0) {
      throw new Error("Prava token exchange returned an invalid token lifetime or type");
    }
    const grantedScopes = new Set(
      typeof tokenPayload.scope === "string"
        ? tokenPayload.scope.split(/\s+/).filter(Boolean)
        : REQUIRED_PRAVA_COMMERCE_SCOPES,
    );
    const missing = REQUIRED_PRAVA_COMMERCE_SCOPES.filter(
      (required) => !grantedScopes.has(required),
    );
    if (missing.length > 0) {
      throw new Error(`Prava did not grant required scopes: ${missing.join(", ")}`);
    }
    const tokens: StoredPravaOAuthTokens = {
      accessToken,
      refreshToken:
        typeof tokenPayload.refresh_token === "string" && tokenPayload.refresh_token.trim()
          ? tokenPayload.refresh_token.trim()
          : null,
      tokenType: "Bearer",
      expiresAt: new Date(now().getTime() + expiresIn * 1000).toISOString(),
      scopes: [...grantedScopes],
      clientId: client.clientId,
      tokenEndpoint: authorization.tokenEndpoint,
      resource: resource.resource,
    };
    await options.tokenStore.save(tokens);
    return tokens;
  } finally {
    await callback.close();
  }
}
