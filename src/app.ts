import express, { type Request } from "express";
import { resolve } from "node:path";
import type LinqAPIV3 from "@linqapp/sdk";

import type { ServerConfig } from "./config.js";
import type { TavraLinqWebhookEvent } from "./linq-events.js";
import { unwrapLinqWebhook } from "./linq.js";
import type { MessageReplyResult } from "./message-reply.js";
import type { PravaCheckoutService } from "./prava.js";
import { DEMO_PRODUCT_MEDIA_ASSETS } from "./product-media.js";

const demoProductImageFilenames = new Map<string, string>(
  DEMO_PRODUCT_MEDIA_ASSETS.map((asset) => [asset.productRef, asset.assetFilename]),
);

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
  processEvent: (event: TavraLinqWebhookEvent) => Promise<MessageReplyResult>;
  prava?: PravaCheckoutService;
}) {
  const app = express();

  if (options.prava) {
    const checkoutAssets = resolve(process.cwd(), "web-dist");
    const checkoutPage = resolve(process.cwd(), "web-dist/index.html");
    app.use(
      "/checkout-assets",
      express.static(checkoutAssets, {
        immutable: true,
        maxAge: "1y",
        index: false,
      }),
    );
    app.use("/pay", (_request, response, next) => {
      response.set({
        "Cache-Control": "no-store",
        "Content-Security-Policy": [
          "default-src 'self'",
          "script-src 'self'",
          "style-src 'self'",
          "img-src 'self' data:",
          "connect-src 'self'",
          "frame-src https://*.prava.space https://prava.space",
          "font-src 'self'",
          "base-uri 'none'",
          "form-action 'self'",
          "frame-ancestors 'none'",
        ].join("; "),
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      });
      next();
    });
    app.get("/pay/:checkoutId", (request, response) => {
      if (!options.prava?.getClientSession(request.params.checkoutId)) {
        response.status(404).send("This secure checkout link is invalid or expired.");
        return;
      }
      response.sendFile(checkoutPage);
    });
    app.get("/api/prava/checkouts/:checkoutId/session", (request, response) => {
      response.set("Cache-Control", "no-store");
      const session = options.prava?.getClientSession(request.params.checkoutId);
      if (!session) {
        response.status(404).json({ error: "Checkout link is invalid or expired" });
        return;
      }
      response.json(session);
    });
    app.get("/api/prava/checkouts/:checkoutId/summary", (request, response) => {
      response.set({
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      const session = options.prava?.getClientSession(request.params.checkoutId);
      if (!session) {
        response.status(404).json({ error: "Checkout link is invalid or expired" });
        return;
      }
      const order = {
        ...session.order,
        products: session.order.products.map((product) => {
          const imageFilename = product.productRef
            ? demoProductImageFilenames.get(product.productRef)
            : undefined;
          if (options.config.pravaMode !== "sandbox" || !imageFilename) {
            return product;
          }
          return {
            ...product,
            imageUrl: new URL(
              `/checkout-assets/products/${imageFilename}`,
              options.config.publicBaseUrl,
            ).toString(),
          };
        }),
      };
      response.json({
        checkoutId: request.params.checkoutId,
        approvalUrl: new URL(
          `/pay/${encodeURIComponent(request.params.checkoutId)}`,
          options.config.publicBaseUrl,
        ).toString(),
        expiresAt: session.expiresAt,
        order,
      });
    });
    app.get("/api/prava/checkouts/:checkoutId/status", async (request, response) => {
      response.set("Cache-Control", "no-store");
      try {
        const status = await options.prava?.getStatus(request.params.checkoutId);
        if (!status) {
          response.status(404).json({ error: "Checkout link is invalid or expired" });
          return;
        }
        response.json(status);
      } catch {
        response.status(502).json({ error: "Unable to check secure approval status" });
      }
    });
    app.post("/api/prava/checkouts/:checkoutId/revoke", async (request, response) => {
      response.set("Cache-Control", "no-store");
      try {
        const revoked = await options.prava?.revoke(request.params.checkoutId);
        response.status(revoked ? 200 : 404).json({ revoked });
      } catch {
        response.status(502).json({ error: "Unable to cancel secure checkout" });
      }
    });
  }

  app.get("/", (_request, response) => {
    response.json({
      service: "tavra",
      status: "ok",
      feature: "linq-openai-senso-prava-recovery",
    });
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

      let event: TavraLinqWebhookEvent;
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
