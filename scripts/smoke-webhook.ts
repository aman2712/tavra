import { createHmac, randomUUID } from "node:crypto";

import "dotenv/config";

import { loadPublicBaseUrl, loadServerConfig } from "../src/config.js";

const config = loadServerConfig();
if (!config.webhookSecret) {
  throw new Error("LINQ_WEBHOOK_SECRET is required for the signed smoke test");
}

const eventId = randomUUID();
const timestamp = String(Math.floor(Date.now() / 1_000));
const body = JSON.stringify({
  api_version: "v3",
  webhook_version: "2026-02-03",
  event_type: "message.received",
  event_id: eventId,
  created_at: new Date().toISOString(),
  trace_id: randomUUID().replaceAll("-", ""),
  partner_id: "tavra-local-smoke-test",
  data: {
    id: randomUUID(),
    direction: "inbound",
    service: "SMS",
    sender_handle: {
      id: randomUUID(),
      handle: "+12025550199",
      is_me: false,
      joined_at: new Date().toISOString(),
      left_at: null,
      service: "SMS",
    },
    chat: {
      id: randomUUID(),
      is_group: false,
      health_status: {
        status: "HEALTHY",
        doc_url: "https://docs.linqapp.com/",
        updated_at: new Date().toISOString(),
      },
      owner_handle: {
        id: randomUUID(),
        handle: "+12025550100",
        is_me: true,
        joined_at: new Date().toISOString(),
        left_at: null,
        service: "SMS",
      },
    },
    parts: [{ type: "text", value: "tavra signed smoke test" }],
  },
});

const key = Buffer.from(config.webhookSecret.replace(/^whsec_/, ""), "base64");
const signature = createHmac("sha256", key)
  .update(`${eventId}.${timestamp}.${body}`)
  .digest("base64");
const target = new URL("/webhooks/linq?version=2026-02-03", loadPublicBaseUrl());

async function deliver() {
  const response = await fetch(target, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": eventId,
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${signature}`,
    },
    body,
  });
  return {
    status: response.status,
    payload: (await response.json()) as { ok?: boolean; status?: string },
  };
}

const first = await deliver();
const retry = await deliver();
if (
  first.status !== 200 ||
  first.payload.status !== "ignored" ||
  retry.status !== 200 ||
  retry.payload.status !== "duplicate"
) {
  throw new Error(
    `Smoke test failed: first=${JSON.stringify(first)}, retry=${JSON.stringify(retry)}`,
  );
}

console.log("Signed public webhook: PASS");
console.log("Duplicate webhook delivery: PASS");
