import type { MessageReceivedWebhookEvent } from "@linqapp/sdk/resources/webhooks";

interface LinqWebhookEnvelope {
  api_version: string;
  webhook_version: string;
  event_id: string;
  created_at: string;
  trace_id: string;
  partner_id: string;
}

export interface LocationSharingStartedWebhookEvent
  extends LinqWebhookEnvelope {
  event_type: "location.sharing.started";
  data: {
    shared_by: string;
    shared_with: string;
    began_at: string;
    ends_at?: string | null;
  };
}

export interface LocationSharingStoppedWebhookEvent
  extends LinqWebhookEnvelope {
  event_type: "location.sharing.stopped";
  data: {
    shared_by: string;
    shared_with: string;
  };
}

export type TavraLinqWebhookEvent =
  | MessageReceivedWebhookEvent
  | LocationSharingStartedWebhookEvent
  | LocationSharingStoppedWebhookEvent;

export function sameLinqHandle(left: string, right: string): boolean {
  const normalizedLeft = left.trim().toLowerCase();
  const normalizedRight = right.trim().toLowerCase();
  if (normalizedLeft === normalizedRight) return true;
  if (normalizedLeft.includes("@") || normalizedRight.includes("@")) return false;
  const leftDigits = normalizedLeft.replace(/\D/g, "");
  const rightDigits = normalizedRight.replace(/\D/g, "");
  return leftDigits.length >= 7 && leftDigits === rightDigits;
}

export function isLocationSharingStartedEvent(
  event: TavraLinqWebhookEvent,
): event is LocationSharingStartedWebhookEvent {
  return event.event_type === "location.sharing.started";
}

export function isLocationSharingStoppedEvent(
  event: TavraLinqWebhookEvent,
): event is LocationSharingStoppedWebhookEvent {
  return event.event_type === "location.sharing.stopped";
}
