import type { MessageReceivedWebhookEvent } from "@linqapp/sdk/resources/webhooks";

import type { ProcessedEventStore } from "./event-store.js";

export interface ReplyGenerator {
  generateReply(message: string): Promise<string>;
}

export interface LinqMessageSender {
  sendText(
    chatId: string,
    eventId: string,
    text: string,
  ): Promise<{ messageId: string }>;
}

export type MessageReplyResult =
  | { status: "sent"; eventId: string; chatId: string; messageId: string }
  | { status: "duplicate"; eventId: string }
  | {
      status: "ignored";
      eventId: string;
      reason:
        | "not_received"
        | "not_inbound"
        | "not_imessage"
        | "wrong_line"
        | "empty_text";
    };

export function textFromMessage(event: MessageReceivedWebhookEvent): string {
  return event.data.parts
    .filter((part): part is Extract<(typeof event.data.parts)[number], { type: "text" }> =>
      part.type === "text",
    )
    .map((part) => part.value)
    .join("\n")
    .trim();
}

export function createMessageReplyProcessor(dependencies: {
  fromNumber: string;
  generator: ReplyGenerator;
  sender: LinqMessageSender;
  store: ProcessedEventStore;
}) {
  const inFlight = new Map<string, Promise<MessageReplyResult>>();

  async function processOnce(
    event: MessageReceivedWebhookEvent,
  ): Promise<MessageReplyResult> {
    if (await dependencies.store.has(event.event_id)) {
      return { status: "duplicate", eventId: event.event_id };
    }

    const message = textFromMessage(event);
    let ignoredReason: Extract<MessageReplyResult, { status: "ignored" }>['reason'] | null = null;
    if (event.event_type !== "message.received") ignoredReason = "not_received";
    else if (event.data.direction !== "inbound") ignoredReason = "not_inbound";
    else if (event.data.service !== "iMessage") ignoredReason = "not_imessage";
    else if (event.data.chat.owner_handle?.handle !== dependencies.fromNumber) {
      ignoredReason = "wrong_line";
    } else if (!message) {
      ignoredReason = "empty_text";
    }

    if (ignoredReason) {
      await dependencies.store.add(event.event_id);
      return {
        status: "ignored",
        eventId: event.event_id,
        reason: ignoredReason,
      };
    }

    const reply = await dependencies.generator.generateReply(message);
    const sent = await dependencies.sender.sendText(
      event.data.chat.id,
      event.event_id,
      reply,
    );
    await dependencies.store.add(event.event_id);
    return {
      status: "sent",
      eventId: event.event_id,
      chatId: event.data.chat.id,
      messageId: sent.messageId,
    };
  }

  return (event: MessageReceivedWebhookEvent): Promise<MessageReplyResult> => {
    const active = inFlight.get(event.event_id);
    if (active) return active;

    const processing = processOnce(event).finally(() => {
      inFlight.delete(event.event_id);
    });
    inFlight.set(event.event_id, processing);
    return processing;
  };
}
