import "dotenv/config";

import {
  validateIMessageAppIdentity,
  type IMessageAppIdentity,
} from "./imessage-app.js";

export type LinqMode = "live" | "mock";

export interface LinqApiConfig {
  apiKey: string;
  fromNumber: string;
}

export interface OpenAIConfig {
  openAIApiKey: string;
  openAIModel: string;
  openAIRouterModel: string;
}

export interface SensoConfig {
  sensoApiKey: string;
  sensoBaseUrl: string;
  sensoIdentityMapPath: string;
}

export type PravaMode = "sandbox" | "live";

export interface PravaConfig {
  pravaPublishableKey: string;
  pravaSecretKey: string;
  pravaMode: PravaMode;
  pravaBackendUrl: string;
  pravaCheckoutMode: "embedded" | "hosted";
  publicBaseUrl: string;
}

export interface IMessageAppConfig {
  /** Null keeps the ordinary rich-link fallback until the signed extension exists. */
  iMessageAppIdentity: IMessageAppIdentity | null;
}

export interface ServerConfig
  extends LinqApiConfig,
    OpenAIConfig,
    SensoConfig,
    PravaConfig,
    IMessageAppConfig {
  mode: LinqMode;
  port: number;
  webhookSecret: string | null;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseFromNumber(value: string): string {
  if (!/^\+[1-9]\d{7,14}$/.test(value)) {
    throw new Error("LINQ_FROM_NUMBER must be an E.164 phone number");
  }
  return value;
}

export function loadLinqApiConfig(): LinqApiConfig {
  return {
    apiKey: required("LINQ_API_KEY"),
    fromNumber: parseFromNumber(required("LINQ_FROM_NUMBER")),
  };
}

export function loadOpenAIConfig(): OpenAIConfig {
  return {
    openAIApiKey: required("OPENAI_API_KEY"),
    openAIModel: process.env.OPENAI_MODEL?.trim() || "gpt-5-mini",
    openAIRouterModel: process.env.OPENAI_ROUTER_MODEL?.trim() || "gpt-4o-mini",
  };
}

export function loadSensoConfig(): SensoConfig {
  const sensoBaseUrl = process.env.SENSO_BASE_URL?.trim() ||
    "https://apiv2.senso.ai/api/v1/";
  const parsedUrl = new URL(sensoBaseUrl);
  if (parsedUrl.protocol !== "https:") {
    throw new Error("SENSO_BASE_URL must use HTTPS");
  }

  return {
    sensoApiKey: required("SENSO_API_KEY"),
    sensoBaseUrl: parsedUrl.toString(),
    sensoIdentityMapPath:
      process.env.SENSO_IDENTITY_MAP_PATH?.trim() ||
      "senso/demo-config/identity-map.local.json",
  };
}

export function loadPravaConfig(): PravaConfig {
  const mode = process.env.PRAVA_MODE?.trim() || "sandbox";
  if (mode !== "sandbox" && mode !== "live") {
    throw new Error("PRAVA_MODE must be sandbox or live");
  }
  const publishableKey = required("PRAVA_API_KEY");
  const secretKey = required("PRAVA_SECRET_KEY");
  const expectedPublishablePrefix = mode === "sandbox" ? "pk_test_" : "pk_live_";
  const expectedSecretPrefix = mode === "sandbox" ? "sk_test_" : "sk_live_";
  if (!publishableKey.startsWith(expectedPublishablePrefix)) {
    throw new Error(`PRAVA_API_KEY must start with ${expectedPublishablePrefix}`);
  }
  if (!secretKey.startsWith(expectedSecretPrefix)) {
    throw new Error(`PRAVA_SECRET_KEY must start with ${expectedSecretPrefix}`);
  }
  const backendUrl = new URL(required("PRAVA_BACKEND_URL"));
  if (backendUrl.protocol !== "https:") {
    throw new Error("PRAVA_BACKEND_URL must use HTTPS");
  }
  const checkoutMode = process.env.PRAVA_CHECKOUT_MODE?.trim() || "hosted";
  if (checkoutMode !== "embedded" && checkoutMode !== "hosted") {
    throw new Error("PRAVA_CHECKOUT_MODE must be embedded or hosted");
  }
  return {
    pravaPublishableKey: publishableKey,
    pravaSecretKey: secretKey,
    pravaMode: mode,
    pravaBackendUrl: backendUrl.toString(),
    pravaCheckoutMode: checkoutMode,
    publicBaseUrl: loadPublicBaseUrl().toString().replace(/\/$/, ""),
  };
}

export function loadIMessageAppConfig(): IMessageAppConfig {
  const teamId = process.env.TAVRA_MESSAGES_APP_TEAM_ID?.trim() || "";
  if (!teamId) return { iMessageAppIdentity: null };
  const bundleId = required("TAVRA_MESSAGES_APP_BUNDLE_ID");
  const rawAppStoreId = process.env.TAVRA_MESSAGES_APP_STORE_ID?.trim();
  const appStoreId = rawAppStoreId ? Number(rawAppStoreId) : undefined;
  return {
    iMessageAppIdentity: validateIMessageAppIdentity({
      name: process.env.TAVRA_MESSAGES_APP_NAME?.trim() || "Tavra",
      teamId,
      bundleId,
      ...(appStoreId === undefined ? {} : { appStoreId }),
    }),
  };
}

export function loadServerConfig(): ServerConfig {
  const api = loadLinqApiConfig();
  const openAI = loadOpenAIConfig();
  const senso = loadSensoConfig();
  const prava = loadPravaConfig();
  const iMessageApp = loadIMessageAppConfig();
  const modeValue = process.env.LINQ_MODE?.trim() || "live";
  if (modeValue !== "live" && modeValue !== "mock") {
    throw new Error("LINQ_MODE must be either live or mock");
  }

  const port = Number(process.env.PORT || "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  const webhookSecret = process.env.LINQ_WEBHOOK_SECRET?.trim() || null;
  if (modeValue === "live" && !webhookSecret) {
    throw new Error("LINQ_WEBHOOK_SECRET is required when LINQ_MODE=live");
  }

  return {
    ...api,
    ...openAI,
    ...senso,
    ...prava,
    ...iMessageApp,
    mode: modeValue,
    port,
    webhookSecret,
  };
}

export function loadPublicBaseUrl(): URL {
  const url = new URL(required("PUBLIC_BASE_URL"));
  if (url.protocol !== "https:") {
    throw new Error("PUBLIC_BASE_URL must use HTTPS for Linq webhooks");
  }
  return url;
}
