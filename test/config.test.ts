import assert from "node:assert/strict";
import test from "node:test";

import { loadServerConfig } from "../src/config.js";

const ENV_KEYS = [
  "LINQ_API_KEY",
  "LINQ_MODE",
  "LINQ_FROM_NUMBER",
  "LINQ_WEBHOOK_SECRET",
  "PUBLIC_BASE_URL",
  "OPENAI_API_KEY",
  "SENSO_API_KEY",
  "TAVRA_COMMERCE_MODE",
  "PRAVA_MCP_URL",
  "PRAVA_API_KEY",
  "PRAVA_SECRET_KEY",
  "PRAVA_MODE",
  "PRAVA_BACKEND_URL",
  "PRAVA_CHECKOUT_MODE",
  "TAVRA_MESSAGES_APP_TEAM_ID",
] as const;

function withBaseEnvironment<T>(operation: () => T): T {
  const before = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, {
      LINQ_API_KEY: "linq-test",
      LINQ_MODE: "mock",
      LINQ_FROM_NUMBER: "+971501234567",
      LINQ_WEBHOOK_SECRET: "",
      PUBLIC_BASE_URL: "https://tavra.example",
      OPENAI_API_KEY: "openai-test",
      SENSO_API_KEY: "senso-test",
      PRAVA_MCP_URL: "https://mcp.pay.prava.space/mcp",
      TAVRA_MESSAGES_APP_TEAM_ID: "",
    });
    delete process.env.PRAVA_API_KEY;
    delete process.env.PRAVA_SECRET_KEY;
    delete process.env.PRAVA_MODE;
    delete process.env.PRAVA_BACKEND_URL;
    delete process.env.PRAVA_CHECKOUT_MODE;
    return operation();
  } finally {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("live commerce does not require legacy sandbox SDK credentials", () => {
  withBaseEnvironment(() => {
    process.env.TAVRA_COMMERCE_MODE = "live";
    const config = loadServerConfig();
    assert.equal(config.commerceMode, "live");
    assert.equal(config.pravaPublishableKey, null);
    assert.equal(config.pravaSecretKey, null);
    assert.equal(config.pravaBackendUrl, null);
  });
});

test("explicit sandbox commerce still requires complete sandbox credentials", () => {
  withBaseEnvironment(() => {
    process.env.TAVRA_COMMERCE_MODE = "sandbox";
    assert.throws(() => loadServerConfig(), /PRAVA_API_KEY/);
  });
});
