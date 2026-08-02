import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createSandboxReimbursementPacketDelivery,
  sandboxPacketReadiness,
} from "../src/reimbursement-delivery.js";
import type { LinqMessageSender } from "../src/message-reply.js";
import type { PravaStatusEvent } from "../src/prava.js";
import {
  JsonlRecoveryCaseLedger,
  type RecoveryCaseRecord,
} from "../src/recovery-case.js";

async function completedCase(t: test.TestContext): Promise<{
  ledger: JsonlRecoveryCaseLedger;
  event: PravaStatusEvent;
  record: RecoveryCaseRecord;
}> {
  const directory = await mkdtemp(join(tmpdir(), "tavra-packet-delivery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledger = new JsonlRecoveryCaseLedger(join(directory, "cases.jsonl"));
  const products = [
    {
      description: "Recovery essentials kit",
      unitPrice: "154.00",
      quantity: 1,
    },
  ];
  const recovery = {
    caseId: "RCV-PACKET-DELIVERY",
    needBy: "8:00 AM tomorrow",
    deliveryArea: "Abu Dhabi",
    deliveryAddress: "Masdar City, Abu Dhabi, room 308",
    deliveryAddressSource: "message" as const,
    airline: "Emirates",
    arrivalAirport: "AUH",
    baggageReference: "RF392942",
    noticeAttachmentIds: ["notice-unverified-1"],
  };
  await ledger.savePrepared({
    caseId: recovery.caseId,
    chatId: "chat-packet-delivery",
    employeeId: "employee-demo",
    employeePhone: "+971501234567",
    recovery,
    products,
    totalAmount: "154.00",
    currency: "USD",
    checkoutId: "checkout-packet-delivery",
    incidentEvidence: {
      passengerName: "Demo Traveler",
      flightNumber: "EK202",
      incidentDate: "2026-08-02",
    },
  });
  const event: PravaStatusEvent = {
    chatId: "chat-packet-delivery",
    checkoutId: "checkout-packet-delivery",
    status: "completed",
    pravaOrderId: "prava-packet-delivery",
    merchantOrderId: "SIM-PACKET-DELIVERY",
    totalAmount: "154.00",
    currency: "USD",
    employeeId: "employee-demo",
    employeePhone: "+971501234567",
    products,
    recovery,
    merchantOutcome: "simulated",
  };
  const record = await ledger.recordPayment(event);
  assert.ok(record);
  return { ledger, event, record };
}

function packetArtifact() {
  return {
    filename: "tavra-emirates-reimbursement-packet.pdf",
    contentType: "application/pdf" as const,
    bytes: new TextEncoder().encode("%PDF-1.4 demo packet"),
    sha256: "a".repeat(64),
  };
}

test("returns a completed reimbursement packet despite nonessential evidence blockers and only sends the PDF once", async (t) => {
  const { ledger, event, record } = await completedCase(t);
  assert.ok(
    record.reimbursement.blockers.includes(
      "verified baggage delay notice",
    ),
  );
  assert.deepEqual(sandboxPacketReadiness(event, record), {
    ready: true,
    missing: [],
  });

  const documents: string[] = [];
  const texts: string[] = [];
  const sender: Pick<LinqMessageSender, "sendDocument" | "sendText"> = {
    async sendDocument(_chatId, eventId) {
      documents.push(eventId);
      return {
        messageId: "message-packet-1",
        attachmentId: "attachment-packet-1",
      };
    },
    async sendText(_chatId, _eventId, text) {
      texts.push(text);
      return { messageId: "message-offer-1" };
    },
  };
  const deliver = createSandboxReimbursementPacketDelivery({
    sender,
    recoveryCases: ledger,
    loadPacket: async () => packetArtifact(),
    retryDelayMs: 0,
  });

  const [first, concurrent] = await Promise.all([
    deliver(event, record),
    deliver(event, record),
  ]);
  const replay = await deliver(event, record);

  assert.match(first ?? "", /reply yes/i);
  assert.equal(concurrent, first);
  assert.equal(replay, first);
  assert.deepEqual(documents, [
    "reimbursement-packet-checkout-packet-delivery",
  ]);
  assert.equal(texts.length, 2);
  assert.equal(
    (await ledger.get(record.caseId))?.reimbursement.handoff?.state,
    "awaiting_confirmation",
  );
  const pending = await ledger.beginSandboxClaimSubmission({
    caseId: record.caseId,
    authorizationEventId: "employee-confirmed-packet",
  });
  assert.equal(pending.reimbursement.handoff?.state, "submission_pending");
});

test("retries a transient private attachment failure with the same idempotency event", async (t) => {
  const { ledger, event, record } = await completedCase(t);
  const documentEvents: string[] = [];
  const sender: Pick<LinqMessageSender, "sendDocument" | "sendText"> = {
    async sendDocument(_chatId, eventId) {
      documentEvents.push(eventId);
      if (documentEvents.length === 1) {
        throw new Error("temporary Linq attachment failure");
      }
      return {
        messageId: "message-packet-retry",
        attachmentId: "attachment-packet-retry",
      };
    },
    async sendText() {
      return { messageId: "message-offer-retry" };
    },
  };
  const deliver = createSandboxReimbursementPacketDelivery({
    sender,
    recoveryCases: ledger,
    loadPacket: async () => packetArtifact(),
    attempts: 3,
    retryDelayMs: 0,
  });

  assert.match((await deliver(event, record)) ?? "", /reply yes/i);
  assert.deepEqual(documentEvents, [
    "reimbursement-packet-checkout-packet-delivery",
    "reimbursement-packet-checkout-packet-delivery",
  ]);
  assert.equal(
    (await ledger.get(record.caseId))?.reimbursement.handoff
      ?.packetAttachmentId,
    "attachment-packet-retry",
  );
});

test("does not send a packet without the core incident context", async (t) => {
  const { ledger, event, record } = await completedCase(t);
  const incomplete = structuredClone(record);
  incomplete.incident.baggageReference = null;
  let sends = 0;
  const deliver = createSandboxReimbursementPacketDelivery({
    sender: {
      async sendDocument() {
        sends += 1;
        return { messageId: "message", attachmentId: "attachment" };
      },
      async sendText() {
        sends += 1;
        return { messageId: "message" };
      },
    },
    recoveryCases: {
      ...ledger,
      async get() {
        return incomplete;
      },
    },
    loadPacket: async () => packetArtifact(),
    retryDelayMs: 0,
  });

  assert.deepEqual(sandboxPacketReadiness(event, incomplete), {
    ready: false,
    missing: ["baggage reference"],
  });
  assert.equal(await deliver(event, incomplete), null);
  assert.equal(sends, 0);
});
