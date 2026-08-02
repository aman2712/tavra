import type { LinqMessageSender } from "./message-reply.js";
import type { PravaStatusEvent } from "./prava.js";
import type {
  RecoveryCaseLedger,
  RecoveryCaseRecord,
} from "./recovery-case.js";
import {
  emiratesReimbursementOffer,
  loadDemoReimbursementPacket,
  type ReimbursementPacketArtifact,
} from "./reimbursement-packet.js";

type ReimbursementDeliveryLedger = Pick<
  RecoveryCaseLedger,
  | "get"
  | "recordReimbursementPacketUploaded"
  | "markReimbursementAwaitingConfirmation"
>;

export interface SandboxReimbursementDeliveryOptions {
  sender: Pick<LinqMessageSender, "sendDocument" | "sendText">;
  recoveryCases: ReimbursementDeliveryLedger;
  loadPacket?: () => Promise<ReimbursementPacketArtifact>;
  offerText?: () => string;
  attempts?: number;
  retryDelayMs?: number;
}

export interface SandboxPacketReadiness {
  ready: boolean;
  missing: string[];
}

/**
 * Returning the prepared packet does not require every item needed for final
 * airline submission. It does require enough context to bind the packet to the
 * completed recovery case and prevent an unrelated document from being sent.
 */
export function sandboxPacketReadiness(
  event: PravaStatusEvent,
  recoveryCase: RecoveryCaseRecord,
): SandboxPacketReadiness {
  const missing: string[] = [];
  if (event.status !== "completed") missing.push("completed approval");
  if (event.merchantOutcome !== "simulated") {
    missing.push("sandbox recovery outcome");
  }
  if (recoveryCase.payment.status !== "approved") {
    missing.push("approved payment status");
  }
  if (recoveryCase.payment.checkoutId !== event.checkoutId) {
    missing.push("matching checkout");
  }
  if (!recoveryCase.incident.airline.trim()) missing.push("airline");
  if (!recoveryCase.incident.arrivalAirport.trim()) {
    missing.push("arrival airport");
  }
  if (!recoveryCase.incident.baggageReference?.trim()) {
    missing.push("baggage reference");
  }
  if (!recoveryCase.recovery.deliveryAddress?.trim()) {
    missing.push("delivery address");
  }
  if (
    !recoveryCase.reimbursement.expenses.some(
      (expense) => expense.status === "incurred",
    )
  ) {
    missing.push("incurred expense");
  }
  return { ready: missing.length === 0, missing };
}

async function retry<T>(
  operation: () => Promise<T>,
  attempts: number,
  delayMs: number,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts && delayMs > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, delayMs * attempt);
        });
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Reimbursement packet delivery failed");
}

/**
 * Creates a per-process, per-case coordinator. Linq receives a stable
 * idempotency key for every retry, while the durable handoff prevents the PDF
 * from being sent again after a restart or repeated Prava callback.
 */
export function createSandboxReimbursementPacketDelivery(
  options: SandboxReimbursementDeliveryOptions,
): (
  event: PravaStatusEvent,
  recoveryCase: RecoveryCaseRecord,
) => Promise<string | null> {
  const attempts = Math.max(1, Math.min(options.attempts ?? 3, 5));
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 250);
  const inFlight = new Map<string, Promise<string | null>>();

  const deliver = async (
    event: PravaStatusEvent,
    suppliedCase: RecoveryCaseRecord,
  ): Promise<string | null> => {
    const recoveryCase =
      (await options.recoveryCases.get(suppliedCase.caseId)) ?? suppliedCase;
    if (!sandboxPacketReadiness(event, recoveryCase).ready) return null;
    if (
      !options.sender.sendDocument ||
      !options.recoveryCases.recordReimbursementPacketUploaded ||
      !options.recoveryCases.markReimbursementAwaitingConfirmation
    ) {
      throw new Error("Reimbursement packet delivery is not configured");
    }

    const packetHash = recoveryCase.reimbursement.claimPacket.packetHash;
    let handoff = recoveryCase.reimbursement.handoff ?? null;
    if (!handoff) {
      const packet = await (options.loadPacket ?? loadDemoReimbursementPacket)();
      const sent = await retry(
        () =>
          options.sender.sendDocument!(
            event.chatId,
            `reimbursement-packet-${event.checkoutId}`,
            packet,
          ),
        attempts,
        retryDelayMs,
      );
      const uploaded = await retry(
        () =>
          options.recoveryCases.recordReimbursementPacketUploaded!({
            caseId: recoveryCase.caseId,
            environment: "sandbox",
            packetHash,
            attachmentId: sent.attachmentId,
            filename: packet.filename,
            sha256: packet.sha256,
          }),
        attempts,
        retryDelayMs,
      );
      handoff = uploaded.reimbursement.handoff ?? null;
    }

    if (handoff?.state === "packet_uploaded") {
      const awaiting = await retry(
        () =>
          options.recoveryCases.markReimbursementAwaitingConfirmation!({
            caseId: recoveryCase.caseId,
            packetHash,
          }),
        attempts,
        retryDelayMs,
      );
      handoff = awaiting.reimbursement.handoff ?? handoff;
    }
    if (
      handoff?.state !== "awaiting_confirmation" &&
      handoff?.state !== "submission_pending"
    ) {
      return null;
    }

    const offer = (options.offerText ?? emiratesReimbursementOffer)();
    await retry(
      () =>
        options.sender.sendText(
          event.chatId,
          `reimbursement-offer-${event.checkoutId}`,
          offer,
        ),
      attempts,
      retryDelayMs,
    );
    return offer;
  };

  return async (event, recoveryCase) => {
    const existing = inFlight.get(recoveryCase.caseId);
    if (existing) return existing;
    const current = deliver(event, recoveryCase).finally(() => {
      if (inFlight.get(recoveryCase.caseId) === current) {
        inFlight.delete(recoveryCase.caseId);
      }
    });
    inFlight.set(recoveryCase.caseId, current);
    return current;
  };
}
