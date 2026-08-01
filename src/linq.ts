import LinqAPIV3 from "@linqapp/sdk";
import type { MessageReceivedWebhookEvent } from "@linqapp/sdk/resources/webhooks";

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

export function createLinqMessageSender(client: LinqAPIV3): LinqMessageSender {
  return {
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
  };
}

export function unwrapLinqWebhook(options: {
  client: LinqAPIV3;
  rawBody: string;
  headers: Record<string, string>;
  verify: boolean;
}): MessageReceivedWebhookEvent {
  if (!options.verify) {
    return JSON.parse(options.rawBody) as MessageReceivedWebhookEvent;
  }
  return options.client.webhooks.unwrap(options.rawBody, {
    headers: options.headers,
  }) as MessageReceivedWebhookEvent;
}
