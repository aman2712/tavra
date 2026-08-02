import type { MessageReceivedWebhookEvent } from "@linqapp/sdk/resources/webhooks";

import type { ProcessedEventStore } from "./event-store.js";
import type {
  IMessageAppCard,
  IMessageAppCardUpdate,
} from "./imessage-app.js";
import {
  isLocationSharingStartedEvent,
  isLocationSharingStoppedEvent,
  sameLinqHandle,
  type LocationSharingStartedWebhookEvent,
  type LocationSharingStoppedWebhookEvent,
  type TavraLinqWebhookEvent,
} from "./linq-events.js";
import type { ResolvedProductMedia } from "./product-media.js";

export interface InboundAttachment {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
}

export interface ReplyPresentation {
  /** Exact proposed line items paired with their own public image and metadata. */
  productMedia?: ResolvedProductMedia[];
  /** Interactive Messages extension card. Takes precedence over linkUrl. */
  appCard?: IMessageAppCard;
  /** Sent as a link-only part so iMessage can render a rich preview card. */
  linkUrl?: string;
}

export interface ReplyGenerator {
  generateReply(request: {
    message: string;
    senderHandle: string;
    chatId: string;
    attachments?: InboundAttachment[];
  }): Promise<string>;
  consumePresentation?(chatId: string): ReplyPresentation | null;
  chatForLocationShare?(senderHandle: string): string | null;
  generateLocationShareReply?(request: {
    chatId: string;
    senderHandle: string;
    eventAt: string;
  }): Promise<string | null>;
  locationSharingStopped?(senderHandle: string): void;
}

export interface LinqMessageSender {
  sendText(
    chatId: string,
    eventId: string,
    text: string,
  ): Promise<{ messageId: string }>;
  sendMedia?(
    chatId: string,
    eventId: string,
    items: ResolvedProductMedia[],
  ): Promise<{ messageId: string }>;
  sendLink?(
    chatId: string,
    eventId: string,
    url: string,
  ): Promise<{ messageId: string }>;
  sendAppCard?(
    chatId: string,
    eventId: string,
    card: IMessageAppCard,
  ): Promise<{ messageId: string }>;
  updateAppCard?(
    messageId: string,
    update: IMessageAppCardUpdate,
  ): Promise<{ messageId: string }>;
  startTyping?(chatId: string): Promise<void>;
  stopTyping?(chatId: string): Promise<void>;
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
        | "empty_text"
        | "stale_message"
        | "location_not_relevant"
        | "location_stopped";
    };

function isMessageReceivedEvent(
  event: TavraLinqWebhookEvent,
): event is MessageReceivedWebhookEvent {
  return event.event_type === "message.received";
}

function messageTimestamp(event: MessageReceivedWebhookEvent): string | null {
  const value = event.data.sent_at ?? event.created_at;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

export function textFromMessage(event: MessageReceivedWebhookEvent): string {
  return event.data.parts
    .filter((part): part is Extract<(typeof event.data.parts)[number], { type: "text" }> =>
      part.type === "text",
    )
    .map((part) => part.value)
    .join("\n")
    .trim();
}

export function attachmentsFromMessage(
  event: MessageReceivedWebhookEvent,
): InboundAttachment[] {
  return event.data.parts.flatMap((part) =>
    part.type === "media"
      ? [
          {
            id: part.id,
            filename: part.filename,
            mimeType: part.mime_type,
            sizeBytes: part.size_bytes,
            url: part.url,
          },
        ]
      : [],
  );
}

export function createMessageReplyProcessor(dependencies: {
  fromNumber: string;
  generator: ReplyGenerator;
  sender: LinqMessageSender;
  store: ProcessedEventStore;
  onAppCardSent?: (input: {
    checkoutId: string;
    messageId: string;
    chatId: string;
  }) => void | Promise<void>;
}) {
  const inFlight = new Map<string, Promise<MessageReplyResult>>();
  const chatQueues = new Map<string, Promise<void>>();

  async function processMessageOnce(
    event: MessageReceivedWebhookEvent,
  ): Promise<MessageReplyResult> {
    if (await dependencies.store.has(event.event_id)) {
      return { status: "duplicate", eventId: event.event_id };
    }

    if (await dependencies.store.hasMessage(event.data.id)) {
      await dependencies.store.add(event.event_id);
      return { status: "duplicate", eventId: event.event_id };
    }

    const message = textFromMessage(event);
    const attachments = attachmentsFromMessage(event);
    const freshAttachments: InboundAttachment[] = [];
    for (const attachment of attachments) {
      if (!(await dependencies.store.hasAttachment(attachment.id))) {
        freshAttachments.push(attachment);
      }
    }
    let ignoredReason: Extract<MessageReplyResult, { status: "ignored" }>['reason'] | null = null;
    if (event.event_type !== "message.received") ignoredReason = "not_received";
    else if (event.data.direction !== "inbound") ignoredReason = "not_inbound";
    else if (event.data.service !== "iMessage") ignoredReason = "not_imessage";
    else if (event.data.chat.owner_handle?.handle !== dependencies.fromNumber) {
      ignoredReason = "wrong_line";
    } else if (!message && freshAttachments.length === 0) {
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

    const sentAt = messageTimestamp(event);
    const cursor = sentAt
      ? {
          chatId: event.data.chat.id,
          messageId: event.data.id,
          sentAt,
          attachmentIds: freshAttachments.map((attachment) => attachment.id),
        }
      : null;
    const latest = await dependencies.store.latestForChat(event.data.chat.id);
    if (
      cursor &&
      latest &&
      Date.parse(cursor.sentAt) < Date.parse(latest.sentAt)
    ) {
      await dependencies.store.add(event.event_id);
      console.info(
        JSON.stringify({
          scope: "linq_webhook",
          status: "ignored_stale",
          chatId: event.data.chat.id,
          messageId: event.data.id,
          sentAt: cursor.sentAt,
          latestMessageId: latest.messageId,
          latestSentAt: latest.sentAt,
        }),
      );
      return {
        status: "ignored",
        eventId: event.event_id,
        reason: "stale_message",
      };
    }

    let typingStarted = false;
    let replySent = false;
    try {
      if (event.data.chat.is_group !== true && dependencies.sender.startTyping) {
        try {
          await dependencies.sender.startTyping(event.data.chat.id);
          typingStarted = true;
        } catch (error) {
          console.warn(
            JSON.stringify({
              scope: "linq_typing_indicator",
              status: "unavailable",
              chatId: event.data.chat.id,
              error: error instanceof Error ? error.message : "Unknown error",
            }),
          );
        }
      }
      const reply = await dependencies.generator.generateReply({
        message,
        senderHandle: event.data.sender_handle.handle?.trim() || "",
        chatId: event.data.chat.id,
        attachments: freshAttachments,
      });
      const presentation = dependencies.generator.consumePresentation?.(
        event.data.chat.id,
      );
      const sent = await dependencies.sender.sendText(
        event.data.chat.id,
        event.event_id,
        reply,
      );
      if (presentation?.productMedia?.length) {
        if (!dependencies.sender.sendMedia) {
          throw new Error("Linq media sending is not configured");
        }
        await dependencies.sender.sendMedia(
          event.data.chat.id,
          event.event_id,
          presentation.productMedia,
        );
      }
      if (presentation?.appCard) {
        if (!dependencies.sender.sendAppCard) {
          throw new Error("Linq iMessage app-card sending is not configured");
        }
        const appCardSent = await dependencies.sender.sendAppCard(
          event.data.chat.id,
          event.event_id,
          presentation.appCard,
        );
        await dependencies.onAppCardSent?.({
          checkoutId: presentation.appCard.checkoutId,
          messageId: appCardSent.messageId,
          chatId: event.data.chat.id,
        });
      } else if (presentation?.linkUrl) {
        if (!dependencies.sender.sendLink) {
          throw new Error("Linq rich-link sending is not configured");
        }
        await dependencies.sender.sendLink(
          event.data.chat.id,
          event.event_id,
          presentation.linkUrl,
        );
      }
      replySent = true;
      await dependencies.store.add(event.event_id, cursor ?? undefined);
      return {
        status: "sent",
        eventId: event.event_id,
        chatId: event.data.chat.id,
        messageId: sent.messageId,
      };
    } finally {
      if (typingStarted && !replySent && dependencies.sender.stopTyping) {
        try {
          await dependencies.sender.stopTyping(event.data.chat.id);
        } catch {
          // Typing is best-effort and expires automatically.
        }
      }
    }
  }

  async function processLocationStartedOnce(
    event: LocationSharingStartedWebhookEvent,
  ): Promise<MessageReplyResult> {
    if (await dependencies.store.has(event.event_id)) {
      return { status: "duplicate", eventId: event.event_id };
    }
    if (!sameLinqHandle(event.data.shared_with, dependencies.fromNumber)) {
      await dependencies.store.add(event.event_id);
      return {
        status: "ignored",
        eventId: event.event_id,
        reason: "wrong_line",
      };
    }

    const chatId = dependencies.generator.chatForLocationShare?.(
      event.data.shared_by,
    );
    if (!chatId || !dependencies.generator.generateLocationShareReply) {
      await dependencies.store.add(event.event_id);
      return {
        status: "ignored",
        eventId: event.event_id,
        reason: "location_not_relevant",
      };
    }

    let typingStarted = false;
    let replySent = false;
    try {
      if (dependencies.sender.startTyping) {
        try {
          await dependencies.sender.startTyping(chatId);
          typingStarted = true;
        } catch (error) {
          console.warn(
            JSON.stringify({
              scope: "linq_typing_indicator",
              status: "unavailable",
              chatId,
              error: error instanceof Error ? error.message : "Unknown error",
            }),
          );
        }
      }
      const reply = await dependencies.generator.generateLocationShareReply({
        chatId,
        senderHandle: event.data.shared_by,
        eventAt: event.data.began_at || event.created_at,
      });
      if (!reply) {
        await dependencies.store.add(event.event_id);
        return {
          status: "ignored",
          eventId: event.event_id,
          reason: "location_not_relevant",
        };
      }
      const sent = await dependencies.sender.sendText(
        chatId,
        event.event_id,
        reply,
      );
      replySent = true;
      await dependencies.store.add(event.event_id);
      return {
        status: "sent",
        eventId: event.event_id,
        chatId,
        messageId: sent.messageId,
      };
    } finally {
      if (typingStarted && !replySent && dependencies.sender.stopTyping) {
        try {
          await dependencies.sender.stopTyping(chatId);
        } catch {
          // Typing is best-effort and expires automatically.
        }
      }
    }
  }

  async function processLocationStoppedOnce(
    event: LocationSharingStoppedWebhookEvent,
  ): Promise<MessageReplyResult> {
    if (await dependencies.store.has(event.event_id)) {
      return { status: "duplicate", eventId: event.event_id };
    }
    if (!sameLinqHandle(event.data.shared_with, dependencies.fromNumber)) {
      await dependencies.store.add(event.event_id);
      return {
        status: "ignored",
        eventId: event.event_id,
        reason: "wrong_line",
      };
    }
    dependencies.generator.locationSharingStopped?.(event.data.shared_by);
    await dependencies.store.add(event.event_id);
    return {
      status: "ignored",
      eventId: event.event_id,
      reason: "location_stopped",
    };
  }

  function processOnce(event: TavraLinqWebhookEvent): Promise<MessageReplyResult> {
    if (isLocationSharingStartedEvent(event)) {
      return processLocationStartedOnce(event);
    }
    if (isLocationSharingStoppedEvent(event)) {
      return processLocationStoppedOnce(event);
    }
    return processMessageOnce(event);
  }

  return (event: TavraLinqWebhookEvent): Promise<MessageReplyResult> => {
    const active = inFlight.get(event.event_id);
    if (active) return active;

    const chatQueueKey = isMessageReceivedEvent(event)
      ? event.data.chat.id
      : isLocationSharingStartedEvent(event)
        ? dependencies.generator.chatForLocationShare?.(event.data.shared_by) ??
          `location:${event.data.shared_by}`
        : `location:${event.data.shared_by}`;
    const previous = chatQueues.get(chatQueueKey) ?? Promise.resolve();
    const processing = previous
      .catch(() => undefined)
      .then(() => processOnce(event))
      .finally(() => {
        inFlight.delete(event.event_id);
      });
    const queueTail = processing.then(
      () => undefined,
      () => undefined,
    );
    chatQueues.set(chatQueueKey, queueTail);
    void queueTail.finally(() => {
      if (chatQueues.get(chatQueueKey) === queueTail) {
        chatQueues.delete(chatQueueKey);
      }
    });
    inFlight.set(event.event_id, processing);
    return processing;
  };
}
