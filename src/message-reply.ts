import type {
  MessageReceivedWebhookEvent,
  ReactionAddedWebhookEvent,
} from "@linqapp/sdk/resources/webhooks";

import type { ProcessedEventStore } from "./event-store.js";
import type {
  IMessageAppCard,
  IMessageAppCardUpdate,
} from "./imessage-app.js";
import {
  isLocationSharingStartedEvent,
  isLocationSharingStoppedEvent,
  isReactionAddedEvent,
  isThumbsUpReaction,
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

export interface ReplyTurnContext {
  /** Durable, monotonically increasing revision allocated for this chat turn. */
  revision: number;
  /** False once a newer inbound turn has superseded this asynchronous work. */
  isCurrent(): Promise<boolean>;
}

export interface ReplyGenerator {
  generateReply(request: {
    message: string;
    senderHandle: string;
    chatId: string;
    attachments?: InboundAttachment[];
    turn?: ReplyTurnContext;
  }): Promise<string>;
  consumePresentation?(chatId: string): ReplyPresentation | null;
  chatForLocationShare?(
    senderHandle: string,
  ): string | null | Promise<string | null>;
  generateLocationShareReply?(request: {
    chatId: string;
    senderHandle: string;
    eventAt: string;
    turn?: ReplyTurnContext;
  }): Promise<string | null>;
  locationSharingStopped?(senderHandle: string): void | Promise<void>;
  /** Records the provider message ID only after an outbound reply is accepted. */
  recordSentReply?(request: {
    chatId: string;
    eventId: string;
    messageId: string;
    reply: string;
  }): void | Promise<void>;
  /** Handles a thumbs-up only when it targets the active final approval summary. */
  generateReactionReply?(request: {
    chatId: string;
    senderHandle: string;
    targetMessageId: string;
    eventId: string;
    reactedAt: string;
    turn?: ReplyTurnContext;
  }): Promise<string | null>;
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
  sendDocument?(
    chatId: string,
    eventId: string,
    document: {
      filename: string;
      contentType: "application/pdf";
      bytes: Uint8Array;
    },
  ): Promise<{ messageId: string; attachmentId: string }>;
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
        | "superseded_turn"
        | "evidence_recorded"
        | "location_not_relevant"
        | "location_pending"
        | "location_stopped"
        | "reaction_not_relevant";
    };

const SAFE_GENERATION_REPLY =
  "I hit a temporary issue while handling that message. Nothing was ordered or submitted. Please send it again.";

function sanitizeOutboundReply(reply: string): string {
  return reply.trim().replace(/\s*—\s*/g, " - ");
}

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
  /** Injectable scheduler keeps webhook acknowledgement separate from polling. */
  defer?: (task: () => Promise<void>) => void;
}) {
  const inFlight = new Map<string, Promise<MessageReplyResult>>();
  const chatQueues = new Map<string, Promise<void>>();
  const locationJobs = new Map<string, symbol>();
  const defer =
    dependencies.defer ??
    ((task: () => Promise<void>) => {
      setTimeout(() => {
        void task().catch((error) => {
          console.warn(
            JSON.stringify({
              scope: "linq_location_background",
              status: "failed",
              error: error instanceof Error ? error.message : "Unknown error",
            }),
          );
        });
      }, 0);
    });

  type PreparedMessage =
    | { kind: "result"; result: MessageReplyResult }
    | {
        kind: "accepted";
        message: string;
        attachments: InboundAttachment[];
        revision: number;
      };

  async function prepareMessage(
    event: MessageReceivedWebhookEvent,
  ): Promise<PreparedMessage> {
    if (await dependencies.store.has(event.event_id)) {
      return {
        kind: "result",
        result: { status: "duplicate", eventId: event.event_id },
      };
    }
    if (await dependencies.store.hasMessage(event.data.id)) {
      await dependencies.store.add(event.event_id);
      return {
        kind: "result",
        result: { status: "duplicate", eventId: event.event_id },
      };
    }

    const message = textFromMessage(event);
    const attachments = attachmentsFromMessage(event);
    const freshAttachments: InboundAttachment[] = [];
    for (const attachment of attachments) {
      if (!(await dependencies.store.hasAttachment(attachment.id))) {
        freshAttachments.push(attachment);
      }
    }
    let ignoredReason:
      | Extract<MessageReplyResult, { status: "ignored" }>['reason']
      | null = null;
    if (event.data.direction !== "inbound") ignoredReason = "not_inbound";
    else if (event.data.service !== "iMessage") ignoredReason = "not_imessage";
    else if (event.data.chat.owner_handle?.handle !== dependencies.fromNumber) {
      ignoredReason = "wrong_line";
    } else if (!message && freshAttachments.length === 0) {
      ignoredReason = "empty_text";
    }

    if (ignoredReason) {
      await dependencies.store.add(event.event_id);
      return {
        kind: "result",
        result: {
          status: "ignored",
          eventId: event.event_id,
          reason: ignoredReason,
        },
      };
    }

    const sentAt = messageTimestamp(event) ?? new Date().toISOString();
    const reservation = await dependencies.store.reserve(event.event_id, {
      chatId: event.data.chat.id,
      messageId: event.data.id,
      sentAt,
      attachmentIds: freshAttachments.map((attachment) => attachment.id),
    });
    if (
      reservation.status === "duplicate_event" ||
      reservation.status === "duplicate_message"
    ) {
      return {
        kind: "result",
        result: { status: "duplicate", eventId: event.event_id },
      };
    }
    if (reservation.status === "stale") {
      const latest = await dependencies.store.latestForChat(event.data.chat.id);
      console.info(
        JSON.stringify({
          scope: "linq_webhook",
          status: "ignored_stale",
          chatId: event.data.chat.id,
          messageId: event.data.id,
          sentAt,
          latestMessageId: latest?.messageId,
          latestSentAt: latest?.sentAt,
        }),
      );
      return {
        kind: "result",
        result: {
          status: "ignored",
          eventId: event.event_id,
          reason: "stale_message",
        },
      };
    }
    return {
      kind: "accepted",
      message,
      attachments: freshAttachments,
      revision: reservation.revision,
    };
  }

  async function sendPresentationBestEffort(
    chatId: string,
    eventId: string,
    presentation: ReplyPresentation | null | undefined,
  ): Promise<void> {
    if (!presentation) return;
    if (presentation.productMedia?.length) {
      try {
        if (!dependencies.sender.sendMedia) {
          throw new Error("Linq media sending is not configured");
        }
        await dependencies.sender.sendMedia(
          chatId,
          eventId,
          presentation.productMedia,
        );
      } catch (error) {
        console.warn(
          JSON.stringify({
            scope: "linq_reply_media",
            status: "failed_best_effort",
            chatId,
            eventId,
            error: error instanceof Error ? error.message : "Unknown error",
          }),
        );
      }
    }
    if (presentation.appCard) {
      try {
        if (!dependencies.sender.sendAppCard) {
          throw new Error("Linq iMessage app-card sending is not configured");
        }
        const appCardSent = await dependencies.sender.sendAppCard(
          chatId,
          eventId,
          presentation.appCard,
        );
        await dependencies.onAppCardSent?.({
          checkoutId: presentation.appCard.checkoutId,
          messageId: appCardSent.messageId,
          chatId,
        });
      } catch (error) {
        console.warn(
          JSON.stringify({
            scope: "linq_reply_app_card",
            status: "failed_using_link_fallback",
            chatId,
            eventId,
            error: error instanceof Error ? error.message : "Unknown error",
          }),
        );
        if (dependencies.sender.sendLink) {
          try {
            await dependencies.sender.sendLink(
              chatId,
              eventId,
              presentation.appCard.url,
            );
          } catch (fallbackError) {
            console.warn(
              JSON.stringify({
                scope: "linq_reply_link_fallback",
                status: "failed_best_effort",
                chatId,
                eventId,
                error:
                  fallbackError instanceof Error
                    ? fallbackError.message
                    : "Unknown error",
              }),
            );
          }
        }
      }
      return;
    }
    if (presentation.linkUrl) {
      try {
        if (!dependencies.sender.sendLink) {
          throw new Error("Linq rich-link sending is not configured");
        }
        await dependencies.sender.sendLink(
          chatId,
          eventId,
          presentation.linkUrl,
        );
      } catch (error) {
        console.warn(
          JSON.stringify({
            scope: "linq_reply_link",
            status: "failed_best_effort",
            chatId,
            eventId,
            error: error instanceof Error ? error.message : "Unknown error",
          }),
        );
      }
    }
  }

  async function processMessageOnce(
    event: MessageReceivedWebhookEvent,
    prepared: PreparedMessage,
  ): Promise<MessageReplyResult> {
    if (prepared.kind === "result") return prepared.result;

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
      const turn = {
        revision: prepared.revision,
        isCurrent: () =>
          dependencies.store.isCurrent(
            event.data.chat.id,
            prepared.revision,
          ),
      };
      let reply: string;
      try {
        reply = await dependencies.generator.generateReply({
          message: prepared.message,
          senderHandle: event.data.sender_handle.handle?.trim() || "",
          chatId: event.data.chat.id,
          attachments: prepared.attachments,
          turn,
        });
      } catch (error) {
        console.warn(
          JSON.stringify({
            scope: "linq_reply_generation",
            status: "fallback",
            chatId: event.data.chat.id,
            eventId: event.event_id,
            error: error instanceof Error ? error.message : "Unknown error",
          }),
        );
        reply = SAFE_GENERATION_REPLY;
      }
      const presentation = dependencies.generator.consumePresentation?.(
        event.data.chat.id,
      );
      if (!(await turn.isCurrent())) {
        return {
          status: "ignored",
          eventId: event.event_id,
          reason: "superseded_turn",
        };
      }
      reply = sanitizeOutboundReply(reply);
      if (!reply) {
        return {
          status: "ignored",
          eventId: event.event_id,
          reason: "evidence_recorded",
        };
      }
      const sent = await dependencies.sender.sendText(
        event.data.chat.id,
        event.event_id,
        reply,
      );
      try {
        await dependencies.generator.recordSentReply?.({
          chatId: event.data.chat.id,
          eventId: event.event_id,
          messageId: sent.messageId,
          reply,
        });
      } catch (error) {
        console.warn(
          JSON.stringify({
            scope: "linq_reply_record",
            status: "failed_best_effort",
            chatId: event.data.chat.id,
            eventId: event.event_id,
            error: error instanceof Error ? error.message : "Unknown error",
          }),
        );
      }
      await sendPresentationBestEffort(
        event.data.chat.id,
        event.event_id,
        presentation,
      );
      replySent = true;
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

    const chatId = await dependencies.generator.chatForLocationShare?.(
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
    const eventAt = event.data.began_at || event.created_at;
    const reservation = await dependencies.store.reserve(event.event_id, {
      chatId,
      messageId: `linq-location:${event.event_id}`,
      sentAt: Number.isFinite(Date.parse(eventAt))
        ? eventAt
        : new Date().toISOString(),
      attachmentIds: [],
    });
    if (
      reservation.status === "duplicate_event" ||
      reservation.status === "duplicate_message"
    ) {
      return { status: "duplicate", eventId: event.event_id };
    }
    if (reservation.status === "stale") {
      return {
        status: "ignored",
        eventId: event.event_id,
        reason: "stale_message",
      };
    }

    const jobToken = Symbol(event.event_id);
    locationJobs.set(chatId, jobToken);
    const turn: ReplyTurnContext = {
      revision: reservation.revision,
      isCurrent: () =>
        dependencies.store.isCurrent(chatId, reservation.revision),
    };
    defer(async () => {
      let typingStarted = false;
      try {
        if (locationJobs.get(chatId) !== jobToken || !(await turn.isCurrent())) {
          return;
        }
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
        let reply: string | null;
        try {
          reply = await dependencies.generator.generateLocationShareReply?.({
            chatId,
            senderHandle: event.data.shared_by,
            eventAt,
            turn,
          }) ?? null;
        } catch (error) {
          console.warn(
            JSON.stringify({
              scope: "linq_location_reply",
              status: "fallback",
              chatId,
              eventId: event.event_id,
              error: error instanceof Error ? error.message : "Unknown error",
            }),
          );
          reply =
            "I couldn’t verify the shared address just now. Please type the hotel or building address instead.";
        }
        if (
          locationJobs.get(chatId) !== jobToken ||
          !(await turn.isCurrent()) ||
          !reply
        ) {
          return;
        }
        await dependencies.sender.sendText(
          chatId,
          `${event.event_id}-resolved`,
          sanitizeOutboundReply(reply),
        );
      } finally {
        if (typingStarted && dependencies.sender.stopTyping) {
          try {
            await dependencies.sender.stopTyping(chatId);
          } catch {
            // Typing is best-effort and expires automatically.
          }
        }
        if (locationJobs.get(chatId) === jobToken) {
          locationJobs.delete(chatId);
        }
      }
    });
    return {
      status: "ignored",
      eventId: event.event_id,
      reason: "location_pending",
    };
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
    await dependencies.generator.locationSharingStopped?.(event.data.shared_by);
    await dependencies.store.add(event.event_id);
    return {
      status: "ignored",
      eventId: event.event_id,
      reason: "location_stopped",
    };
  }

  async function processReactionAddedOnce(
    event: ReactionAddedWebhookEvent,
  ): Promise<MessageReplyResult> {
    if (await dependencies.store.has(event.event_id)) {
      return { status: "duplicate", eventId: event.event_id };
    }
    const chatId = event.data.chat_id?.trim() ?? "";
    const targetMessageId = event.data.message_id?.trim() ?? "";
    const senderHandle =
      event.data.from_handle?.handle?.trim() || event.data.from?.trim() || "";
    if (
      event.data.is_from_me ||
      (event.data.service && event.data.service !== "iMessage") ||
      !isThumbsUpReaction(event) ||
      !chatId ||
      !targetMessageId ||
      !senderHandle ||
      !dependencies.generator.generateReactionReply
    ) {
      await dependencies.store.add(event.event_id);
      return {
        status: "ignored",
        eventId: event.event_id,
        reason: "reaction_not_relevant",
      };
    }

    const reactedAt = event.data.reacted_at ?? event.created_at;
    const reservation = await dependencies.store.reserve(event.event_id, {
      chatId,
      messageId: `linq-reaction:${event.event_id}`,
      sentAt: Number.isFinite(Date.parse(reactedAt))
        ? reactedAt
        : new Date().toISOString(),
      attachmentIds: [],
    });
    if (
      reservation.status === "duplicate_event" ||
      reservation.status === "duplicate_message"
    ) {
      return { status: "duplicate", eventId: event.event_id };
    }
    if (reservation.status === "stale") {
      return {
        status: "ignored",
        eventId: event.event_id,
        reason: "stale_message",
      };
    }
    const turn: ReplyTurnContext = {
      revision: reservation.revision,
      isCurrent: () => dependencies.store.isCurrent(chatId, reservation.revision),
    };
    const reply = await dependencies.generator.generateReactionReply({
      chatId,
      senderHandle,
      targetMessageId,
      eventId: event.event_id,
      reactedAt,
      turn,
    });
    if (!reply || !(await turn.isCurrent())) {
      return {
        status: "ignored",
        eventId: event.event_id,
        reason: !reply ? "reaction_not_relevant" : "superseded_turn",
      };
    }
    const sanitized = sanitizeOutboundReply(reply);
    if (!sanitized) {
      return {
        status: "ignored",
        eventId: event.event_id,
        reason: "reaction_not_relevant",
      };
    }
    const presentation = dependencies.generator.consumePresentation?.(chatId);
    const sent = await dependencies.sender.sendText(
      chatId,
      event.event_id,
      sanitized,
    );
    await dependencies.generator.recordSentReply?.({
      chatId,
      eventId: event.event_id,
      messageId: sent.messageId,
      reply: sanitized,
    });
    await sendPresentationBestEffort(chatId, event.event_id, presentation);
    return {
      status: "sent",
      eventId: event.event_id,
      chatId,
      messageId: sent.messageId,
    };
  }

  function processNonMessageOnce(
    event: Exclude<TavraLinqWebhookEvent, MessageReceivedWebhookEvent>,
  ): Promise<MessageReplyResult> {
    if (isLocationSharingStartedEvent(event)) {
      return processLocationStartedOnce(event);
    }
    if (isLocationSharingStoppedEvent(event)) {
      return processLocationStoppedOnce(event);
    }
    if (isReactionAddedEvent(event)) {
      return processReactionAddedOnce(event);
    }
    throw new Error("Unsupported Linq webhook event type");
  }

  return (event: TavraLinqWebhookEvent): Promise<MessageReplyResult> => {
    const active = inFlight.get(event.event_id);
    if (active) return active;

    const preparedMessage = isMessageReceivedEvent(event)
      ? prepareMessage(event)
      : null;
    const chatQueueKey = isMessageReceivedEvent(event)
      ? event.data.chat.id
      : isReactionAddedEvent(event)
        ? event.data.chat_id ?? `reaction:${event.event_id}`
        : `location:${event.data.shared_by}`;
    const previous = chatQueues.get(chatQueueKey) ?? Promise.resolve();
    const processing = previous
      .catch(() => undefined)
      .then(async () =>
        isMessageReceivedEvent(event)
          ? processMessageOnce(event, (await preparedMessage) as PreparedMessage)
          : processNonMessageOnce(event),
      )
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
