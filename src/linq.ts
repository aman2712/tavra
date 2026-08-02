import { createHash } from "node:crypto";

import LinqAPIV3 from "@linqapp/sdk";
import {
  sameLinqHandle,
  type TavraLinqWebhookEvent,
} from "./linq-events.js";
import type { LinqMessageSender } from "./message-reply.js";

export function createLinqClient(options: {
  apiKey: string;
  webhookSecret?: string | null;
}): LinqAPIV3 {
  return new LinqAPIV3({
    apiKey: options.apiKey,
    webhookSecret: options.webhookSecret,
    maxRetries: 0,
    timeout: 8_000,
  });
}

export function createLinqMessageSender(
  client: LinqAPIV3,
  options: {
    fetch?: typeof fetch;
    /**
     * Linq recommends a public HTTPS media URL for a file that is sent once.
     * When configured, this avoids the optional pre-upload endpoint entirely.
     */
    documentUrl?: (input: {
      eventId: string;
      filename: string;
    }) => string;
  } = {},
): LinqMessageSender {
  const fetchImpl = options.fetch ?? fetch;
  return {
    async startTyping(chatId) {
      await client.chats.typing.start(chatId);
    },
    async stopTyping(chatId) {
      await client.chats.typing.stop(chatId);
    },
    async sendText(chatId, eventId, text) {
      const result = await client.chats.messages.send(chatId, {
        message: {
          parts: [{ type: "text", value: text }],
          preferred_service: "iMessage",
          idempotency_key: `tavra-reply-${eventId}`,
        },
      });
      return { messageId: result.message.id };
    },
    async sendMedia(chatId, eventId, items) {
      const result = await client.chats.messages.send(chatId, {
        message: {
          parts: items.flatMap((item) => [
            { type: "text" as const, value: item.caption },
            { type: "media" as const, url: item.url },
          ]),
          preferred_service: "iMessage",
          idempotency_key: `tavra-media-${eventId}`,
        },
      });
      return { messageId: result.message.id };
    },
    async sendDocument(chatId, eventId, document) {
      if (options.documentUrl) {
        const url = new URL(
          options.documentUrl({ eventId, filename: document.filename }),
        );
        if (url.protocol !== "https:") {
          throw new Error("Linq document media URL must use HTTPS");
        }
        const result = await client.chats.messages.send(chatId, {
          message: {
            parts: [{ type: "media", url: url.toString() }],
            preferred_service: "iMessage",
            idempotency_key: `tavra-document-${eventId}`,
          },
        });
        const deliveryReference = createHash("sha256")
          .update(eventId)
          .update("\0")
          .update(document.bytes)
          .digest("hex");
        return {
          messageId: result.message.id,
          attachmentId: `url-${deliveryReference}`,
        };
      }
      const attachment = await client.attachments.create({
        filename: document.filename,
        content_type: document.contentType,
        size_bytes: document.bytes.byteLength,
      });
      const upload = await fetchImpl(attachment.upload_url, {
        method: attachment.http_method,
        headers: attachment.required_headers,
        body: document.bytes as BodyInit,
      });
      if (!upload.ok) {
        throw new Error(
          `Linq attachment upload failed with HTTP ${upload.status}`,
        );
      }
      const result = await client.chats.messages.send(chatId, {
        message: {
          parts: [
            {
              type: "media",
              attachment_id: attachment.attachment_id,
            },
          ],
          preferred_service: "iMessage",
          idempotency_key: `tavra-document-${eventId}`,
        },
      });
      return {
        messageId: result.message.id,
        attachmentId: attachment.attachment_id,
      };
    },
    async sendLink(chatId, eventId, url) {
      const result = await client.chats.messages.send(chatId, {
        message: {
          parts: [{ type: "link", value: url }],
          preferred_service: "iMessage",
          idempotency_key: `tavra-link-${eventId}`,
        },
      });
      return { messageId: result.message.id };
    },
    async sendAppCard(chatId, eventId, card) {
      const result = await client.chats.messages.send(chatId, {
        message: {
          parts: [
            {
              type: "imessage_app",
              app: {
                name: card.identity.name,
                team_id: card.identity.teamId,
                bundle_id: card.identity.bundleId,
                ...(card.identity.appStoreId === undefined
                  ? {}
                  : { app_store_id: card.identity.appStoreId }),
              },
              url: card.url,
              fallback_text: card.fallbackText,
              interactive: card.interactive,
              layout: {
                ...(card.layout.caption
                  ? { caption: card.layout.caption }
                  : {}),
                ...(card.layout.subcaption
                  ? { subcaption: card.layout.subcaption }
                  : {}),
                ...(card.layout.trailingCaption
                  ? { trailing_caption: card.layout.trailingCaption }
                  : {}),
                ...(card.layout.trailingSubcaption
                  ? { trailing_subcaption: card.layout.trailingSubcaption }
                  : {}),
                ...(card.layout.imageUrl
                  ? { image_url: card.layout.imageUrl }
                  : {}),
                ...(card.layout.imageTitle
                  ? { image_title: card.layout.imageTitle }
                  : {}),
                ...(card.layout.imageSubtitle
                  ? { image_subtitle: card.layout.imageSubtitle }
                  : {}),
              },
            },
          ],
          preferred_service: "iMessage",
          idempotency_key: `tavra-app-card-${eventId}`,
        },
      });
      return { messageId: result.message.id };
    },
    async updateAppCard(messageId, update) {
      const result = await client.messages.updateAppCard(messageId, {
        url: update.url,
        fallback_text: update.fallbackText,
        interactive: update.interactive,
        layout: {
          ...(update.layout.caption
            ? { caption: update.layout.caption }
            : {}),
          ...(update.layout.subcaption
            ? { subcaption: update.layout.subcaption }
            : {}),
          ...(update.layout.trailingCaption
            ? { trailing_caption: update.layout.trailingCaption }
            : {}),
          ...(update.layout.trailingSubcaption
            ? { trailing_subcaption: update.layout.trailingSubcaption }
            : {}),
          ...(update.layout.imageUrl
            ? { image_url: update.layout.imageUrl }
            : {}),
          ...(update.layout.imageTitle
            ? { image_title: update.layout.imageTitle }
            : {}),
          ...(update.layout.imageSubtitle
            ? { image_subtitle: update.layout.imageSubtitle }
            : {}),
        },
      });
      return { messageId: result.message.id };
    },
  };
}

export interface SharedChatLocation {
  address: string | null;
  locality: string | null;
  coordinates: [number, number] | null;
  updatedAt: string | null;
}

export interface LinqLocationProvider {
  getCurrent(chatId: string, senderHandle: string): Promise<SharedChatLocation | null>;
  request(chatId: string): Promise<void>;
}

export interface LinqLocationErrorDetails {
  status: number | null;
  code: number | string | null;
  message: string;
  docUrl: string | null;
  traceId: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

export function linqLocationErrorDetails(
  error: unknown,
): LinqLocationErrorDetails {
  const outer = record(error);
  const body = record(outer?.error);
  const detail = record(body?.error) ?? body;
  const rawCode = detail?.code;
  const code =
    typeof rawCode === "number" || typeof rawCode === "string"
      ? rawCode
      : null;
  const rawStatus = outer?.status;
  const status = typeof rawStatus === "number" ? rawStatus : null;
  const rawMessage = detail?.message;
  const message =
    typeof rawMessage === "string"
      ? rawMessage
      : error instanceof Error
        ? error.message
        : "Unknown Linq location error";
  return {
    status,
    code,
    message,
    docUrl: typeof detail?.doc_url === "string" ? detail.doc_url : null,
    traceId: typeof body?.trace_id === "string" ? body.trace_id : null,
  };
}

export function createLinqLocationProvider(client: LinqAPIV3): LinqLocationProvider {
  return {
    async getCurrent(chatId, senderHandle) {
      const result = await client.chats.location.retrieve(chatId);
      const feature = result.data.features.find(
        (candidate) => sameLinqHandle(candidate.properties.handle, senderHandle),
      );
      if (!feature) return null;
      const [longitude, latitude] = feature.geometry.coordinates;
      return {
        address: feature.properties.address?.trim() || null,
        locality: feature.properties.locality?.trim() || null,
        coordinates:
          Number.isFinite(longitude) && Number.isFinite(latitude)
            ? [longitude as number, latitude as number]
            : null,
        updatedAt: feature.properties.updated_at ?? null,
      };
    },
    async request(chatId) {
      const result = await client.chats.location.request(chatId);
      if (!result.success) {
        throw new Error(result.message || "Linq did not accept the location request");
      }
    },
  };
}

export function unwrapLinqWebhook(options: {
  client: LinqAPIV3;
  rawBody: string;
  headers: Record<string, string>;
  verify: boolean;
}): TavraLinqWebhookEvent {
  if (!options.verify) {
    return JSON.parse(options.rawBody) as TavraLinqWebhookEvent;
  }
  return options.client.webhooks.unwrap(options.rawBody, {
    headers: options.headers,
  }) as TavraLinqWebhookEvent;
}
