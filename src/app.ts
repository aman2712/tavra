import express, { type Request } from "express";
import type LinqAPIV3 from "@linqapp/sdk";
import type { MessageReceivedWebhookEvent } from "@linqapp/sdk/resources/webhooks";

import type { ServerConfig } from "./config.js";
import { unwrapLinqWebhook } from "./linq.js";
import type { MessageReplyResult } from "./message-reply.js";

function headersFromRequest(request: Request): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") result[name] = value;
    else if (Array.isArray(value)) result[name] = value.join(",");
  }
  return result;
}

export function createApp(options: {
  config: ServerConfig;
  client: LinqAPIV3;
  processEvent: (event: MessageReceivedWebhookEvent) => Promise<MessageReplyResult>;
}) {
  const app = express();

  app.get("/", (_request, response) => {
    response.json({ service: "tavra", status: "ok", feature: "linq-openai-replies" });
  });

  app.get("/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  app.post(
    "/webhooks/linq",
    express.raw({ type: "application/json", limit: "2mb" }),
    async (request, response) => {
      const rawBody = Buffer.isBuffer(request.body)
        ? request.body.toString("utf8")
        : "";

      let event: MessageReceivedWebhookEvent;
      try {
        event = unwrapLinqWebhook({
          client: options.client,
          rawBody,
          headers: headersFromRequest(request),
          verify: options.config.mode === "live",
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.warn(
          JSON.stringify({
            scope: "linq_webhook",
            status: "rejected",
            error: message,
          }),
        );
        response.status(401).json({ ok: false });
        return;
      }

      try {
        const result = await options.processEvent(event);
        console.info(JSON.stringify({ scope: "linq_webhook", ...result }));
        response.status(200).json({ ok: true, status: result.status });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.error(
          JSON.stringify({ scope: "linq_webhook", status: "failed", error: message }),
        );
        response.status(500).json({ ok: false });
      }
    },
  );

  return app;
}
