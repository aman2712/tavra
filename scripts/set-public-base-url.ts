import { resolve } from "node:path";

import { setDotEnvValue } from "./env-file.js";

const value = process.argv[2];
if (!value) {
  throw new Error("Usage: npm run env:set-public-url -- https://example.com");
}

const url = new URL(value);
if (url.protocol !== "https:") {
  throw new Error("The public base URL must use HTTPS");
}

const origin = url.origin;
await setDotEnvValue(
  resolve(process.cwd(), ".env"),
  "PUBLIC_BASE_URL",
  origin,
);
console.log(`Saved PUBLIC_BASE_URL=${origin}`);
