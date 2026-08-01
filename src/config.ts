import "dotenv/config";

export type LinqMode = "live" | "mock";

export interface LinqApiConfig {
  apiKey: string;
  fromNumber: string;
}

export interface OpenAIConfig {
  openAIApiKey: string;
  openAIModel: string;
}

export interface ServerConfig extends LinqApiConfig, OpenAIConfig {
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
  };
}

export function loadServerConfig(): ServerConfig {
  const api = loadLinqApiConfig();
  const openAI = loadOpenAIConfig();
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
