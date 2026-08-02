import { resolve } from "node:path";

import { loadLinqApiConfig, loadPublicBaseUrl } from "../src/config.js";
import { createLinqClient } from "../src/linq.js";
import { setDotEnvValue } from "./env-file.js";

const config = loadLinqApiConfig();
const client = createLinqClient(config);
const target = new URL("/webhooks/linq?version=2026-02-03", loadPublicBaseUrl());
const subscribedEvents = [
  "message.received",
  "location.sharing.started",
  "location.sharing.stopped",
] as const;
const subscriptions = (await client.webhookSubscriptions.list()).subscriptions;
const existing =
  subscriptions.find(
    (subscription) => subscription.target_url === target.toString(),
  ) ??
  subscriptions.find(
    (subscription) =>
      subscription.target_url.includes("/webhooks/linq") &&
      subscription.phone_numbers?.includes(config.fromNumber),
  );

if (existing) {
  await client.webhookSubscriptions.update(existing.id, {
    is_active: true,
    target_url: target.toString(),
    subscribed_events: [...subscribedEvents],
    phone_numbers: [config.fromNumber],
  });
  console.log(`Linq webhook subscription ${existing.id} is active and up to date.`);
  console.log("Its signing secret is unchanged; LINQ_WEBHOOK_SECRET must match it.");
} else {
  const created = await client.webhookSubscriptions.create({
    target_url: target.toString(),
    subscribed_events: [...subscribedEvents],
    phone_numbers: [config.fromNumber],
  });
  await setDotEnvValue(
    resolve(process.cwd(), ".env"),
    "LINQ_WEBHOOK_SECRET",
    created.signing_secret,
  );
  console.log(`Created Linq webhook subscription ${created.id}.`);
  console.log("Saved its signing secret to .env without printing it.");
}

console.log(`Target: ${target.toString()}`);
