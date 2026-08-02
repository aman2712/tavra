import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  JsonlRecoveryCaseLedger,
  resolveAirlineSubmissionTarget,
} from "../src/recovery-case.js";

test("persists incident, delivery, payment, and reimbursement-draft state", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tavra-recovery-case-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "cases.jsonl");
  const ledger = new JsonlRecoveryCaseLedger(path);
  const recovery = {
    caseId: "RCV-TEST1234",
    needBy: "8:00 AM",
    deliveryArea: "Boston",
    deliveryAddress: "1 Hotel Drive, Boston, MA, front desk",
    deliveryAddressSource: "message" as const,
    airline: "Delta",
    arrivalAirport: "BOS",
    baggageReference: "RF392942",
    noticeAttachmentIds: ["attachment-1"],
  };
  const products = [
    { description: "Essential toiletry kit", unitPrice: "22.00", quantity: 1 },
  ];

  await ledger.savePrepared({
    caseId: recovery.caseId,
    chatId: "chat-1",
    employeeId: "emp-1",
    employeePhone: "+15555550100",
    recovery,
    products,
    totalAmount: "22.00",
    currency: "USD",
    checkoutId: "checkout-1",
  });
  const completed = await ledger.recordPayment({
    chatId: "chat-1",
    checkoutId: "checkout-1",
    status: "completed",
    pravaOrderId: "prava-order-1",
    merchantOrderId: "SIM-ORDER-1",
    totalAmount: "22.00",
    currency: "USD",
    employeeId: "emp-1",
    employeePhone: "+15555550100",
    products,
    recovery,
    merchantOutcome: "simulated",
  });

  assert.equal(completed?.status, "sandbox_authorization_complete");
  assert.equal(completed?.incident.airline, "Delta");
  assert.equal(completed?.incident.arrivalAirport, "BOS");
  assert.equal(completed?.recovery.deliveryAddress, recovery.deliveryAddress);
  assert.equal(completed?.payment.status, "approved");
  assert.equal(completed?.fulfillment.merchantOrderId, null);
  assert.match(completed?.fulfillment.disclosure ?? "", /no live merchant order/i);
  assert.ok(
    completed?.reimbursement.blockers.includes("verified itemized merchant receipt"),
  );

  const reloaded = new JsonlRecoveryCaseLedger(path);
  assert.deepEqual(await reloaded.get(recovery.caseId), completed);
  const contents = await readFile(path, "utf8");
  assert.doesNotMatch(contents, /dynamic_cvv|network.?token/i);
});

test("resolves reviewed airline handoffs without pretending they are APIs", () => {
  const delta = resolveAirlineSubmissionTarget("Delta airline");
  assert.equal(delta.resolution, "official_handoff");
  assert.equal(delta.airlineCode, "DL");
  assert.equal(delta.submissionUrl, "https://www.delta.com/bag-claim");
  assert.equal(delta.automation, "manual_handoff_only");
  assert.match(delta.disclosure, /not an airline API/i);

  const american = resolveAirlineSubmissionTarget("American Airlines");
  assert.equal(american.airlineCode, "AA");
  assert.ok(american.requiredEvidence.includes("travel_itinerary"));
  assert.ok(american.requiredEvidence.includes("baggage_check"));

  const unknown = resolveAirlineSubmissionTarget("Example Regional Air");
  assert.equal(unknown.resolution, "unresolved");
  assert.equal(unknown.submissionUrl, null);
  assert.match(unknown.disclosure, /will not guess/i);
});

test("builds, authorizes, and records a claim only with durable evidence", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tavra-claim-packet-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "cases.jsonl");
  const ledger = new JsonlRecoveryCaseLedger(path);
  const caseId = "RCV-CLAIM001";

  const draft = await ledger.saveClaimDraft({
    caseId,
    chatId: "chat-claim",
    employeeId: "emp-claim",
    employeePhone: "+15555550101",
    airline: "Delta",
    arrivalAirport: "BOS",
    baggageReference: "BOSDL12345",
    passengerName: "Demo Passenger",
    flightNumber: "DL123",
    incidentDate: "2026-08-02",
    noticeAttachmentIds: ["notice-attachment-1"],
  });

  assert.equal(draft.reimbursement.airlineClaimStatus, "draft");
  assert.equal(draft.reimbursement.claimPacket.incident.airline, "Delta");
  assert.equal(draft.reimbursement.claimPacket.incident.arrivalAirport, "BOS");
  assert.equal(
    draft.reimbursement.claimPacket.incident.baggageReference,
    "BOSDL12345",
  );
  assert.match(draft.reimbursement.automationBoundary, /manual handoff/i);
  await assert.rejects(
    () =>
      ledger.authorizeAirlineClaim({
        caseId,
        authorizationEventId: "message-too-early",
      }),
    /not ready/i,
  );

  await ledger.addClaimEvidence({
    caseId,
    evidenceId: "EVD-NOTICE-VERIFIED",
    kind: "baggage_delay_notice",
    source: "linq_attachment",
    description: "Confirmed Delta delayed-baggage notice",
    verification: "verified",
    attachmentId: "notice-attachment-1",
    sha256: "1".repeat(64),
  });
  await ledger.addClaimEvidence({
    caseId,
    evidenceId: "EVD-RECEIPT-VERIFIED",
    kind: "itemized_receipt",
    source: "merchant",
    description: "Verified itemized receipt for emergency toiletries",
    verification: "verified",
    sha256: "2".repeat(64),
  });
  const ready = await ledger.addClaimExpense({
    caseId,
    expenseId: "EXP-TOILETRIES-1",
    description: "Emergency toiletries",
    amount: "22",
    currency: "usd",
    merchantName: "Demo Merchant",
    purchasedAt: "2026-08-02T08:00:00.000Z",
    receiptEvidenceId: "EVD-RECEIPT-VERIFIED",
    status: "incurred",
  });

  assert.deepEqual(ready.reimbursement.blockers, []);
  assert.equal(
    ready.reimbursement.airlineClaimStatus,
    "ready_for_authorization",
  );
  assert.equal(ready.reimbursement.claimPacket.expenses.length, 1);
  assert.equal(ready.reimbursement.claimPacket.expenses[0]?.amount, "22.00");
  assert.equal(ready.reimbursement.claimPacket.packetHash.length, 64);
  assert.equal(
    ready.reimbursement.claimPacket.submissionTarget.submissionUrl,
    "https://www.delta.com/bag-claim",
  );

  const authorized = await ledger.authorizeAirlineClaim({
    caseId,
    authorizationEventId: "linq-message-authorize-1",
  });
  assert.equal(
    authorized.reimbursement.airlineClaimStatus,
    "authorized_for_handoff",
  );
  assert.equal(
    authorized.reimbursement.authorization?.scope,
    "manual_airline_claim_handoff",
  );
  assert.equal(authorized.reimbursement.submission, null);

  await assert.rejects(
    () =>
      ledger.recordExternalClaimSubmission({
        caseId,
        submittedBy: "employee",
        externalClaimId: "DL-CLAIM-123",
        confirmationEvidence: {
          description: "Employee said the form was submitted",
        },
      }),
    /independent confirmation evidence/i,
  );

  const submitted = await ledger.recordExternalClaimSubmission({
    caseId,
    submittedBy: "employee",
    externalClaimId: "DL-CLAIM-123",
    submittedAt: "2026-08-02T09:00:00.000Z",
    confirmationEvidence: {
      evidenceId: "EVD-SUBMISSION-CONFIRMATION",
      description: "Delta claim confirmation receipt",
      attachmentId: "claim-confirmation-attachment",
      sha256: "3".repeat(64),
    },
  });
  assert.equal(submitted.reimbursement.airlineClaimStatus, "submitted");
  assert.equal(
    submitted.reimbursement.submission?.externalClaimId,
    "DL-CLAIM-123",
  );
  assert.equal(
    submitted.reimbursement.submission?.confirmationEvidenceId,
    "EVD-SUBMISSION-CONFIRMATION",
  );
  assert.equal(
    submitted.reimbursement.submission?.packetHash,
    submitted.reimbursement.claimPacket.packetHash,
  );
  await assert.rejects(
    () =>
      ledger.addClaimExpense({
        caseId,
        description: "Late expense mutation",
        amount: "1.00",
        currency: "USD",
        status: "incurred",
      }),
    /submitted airline claim packet cannot be changed/i,
  );

  const reloaded = new JsonlRecoveryCaseLedger(path);
  assert.deepEqual(await reloaded.get(caseId), submitted);
  const contents = await readFile(path, "utf8");
  assert.doesNotMatch(contents, /dynamic_cvv|network.?token/i);
});

test("keeps an unknown airline blocked instead of inventing a submission URL", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tavra-unknown-airline-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledger = new JsonlRecoveryCaseLedger(join(directory, "cases.jsonl"));
  const record = await ledger.saveClaimDraft({
    caseId: "RCV-UNKNOWN1",
    chatId: "chat-unknown",
    employeeId: "emp-unknown",
    employeePhone: "+15555550102",
    airline: "Example Regional Air",
    arrivalAirport: "BOS",
    baggageReference: "REF12345",
    passengerName: "Demo Passenger",
    noticeAttachmentIds: [],
  });

  assert.equal(record.reimbursement.submissionTarget.resolution, "unresolved");
  assert.equal(record.reimbursement.submissionTarget.submissionUrl, null);
  assert.ok(
    record.reimbursement.blockers.includes(
      "reviewed official airline submission destination",
    ),
  );
  await assert.rejects(
    () =>
      ledger.authorizeAirlineClaim({
        caseId: record.caseId,
        authorizationEventId: "authorize-unknown",
      }),
    /not ready/i,
  );
});
