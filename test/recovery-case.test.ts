import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  JsonlRecoveryCaseLedger,
  resolveAirlineSubmissionTarget,
} from "../src/recovery-case.js";
import type {
  CommerceOffer,
  CommerceQuote,
  RecoveryEssentialSelection,
} from "../src/commerce.js";
import type {
  LiveCommerceRecoveryRequest,
  LiveCommerceStatusEvent,
} from "../src/live-commerce.js";

function liveCommerceFixture(suffix = "1"): {
  request: LiveCommerceRecoveryRequest;
  selection: RecoveryEssentialSelection;
  quote: CommerceQuote;
} {
  const merchant = {
    name: "Abu Dhabi Essentials",
    domain: "shop.example.ae",
    country: "AE",
  };
  const provenance = {
    source: "prava_ucp" as const,
    merchantDomain: merchant.domain,
    retrievedAt: "2026-08-02T06:00:00.000Z",
  };
  const offer: CommerceOffer = {
    productId: `product-shirt-${suffix}`,
    variantId: `variant-shirt-m-${suffix}`,
    title: "Organic cotton crew T-shirt",
    description: "Black organic cotton crew T-shirt",
    merchant,
    options: { size: "M", color: "Black" },
    unitPrice: { amount: "120.00", currency: "AED" },
    available: true,
    imageUrl: "https://cdn.example.ae/products/shirt-m.jpg",
    provenance,
  };
  const selection: RecoveryEssentialSelection = {
    category: "tshirt",
    result: {
      productId: offer.productId,
      title: offer.title,
      merchant,
      estimatedPrice: offer.unitPrice,
      imageUrl: offer.imageUrl,
      provenance,
    },
    product: {
      productId: offer.productId,
      title: offer.title,
      description: offer.description,
      merchant,
      images: [offer.imageUrl ?? ""],
      offers: [offer],
      provenance,
    },
    offer,
  };
  const request: LiveCommerceRecoveryRequest = {
    caseId: `RCV-LIVE${suffix}`,
    chatId: `chat-live-${suffix}`,
    employeeId: `employee-live-${suffix}`,
    employeePhone: "+971501234567",
    employeeEmail: "employee@example.com",
    employeeAllowance: { amount: "250.00", currency: "AED" },
    needBy: "8:00 AM tomorrow",
    needByIso: "2026-08-03T08:00:00.000+04:00",
    deliveryArea: "Masdar City, Abu Dhabi",
    address: {
      id: `address-mbzuai-${suffix}`,
      label: "Work",
      summary: "Masdar City, Abu Dhabi, AE, building ending 01",
      country: "AE",
      isDefault: true,
      contactPhoneOnFile: true,
    },
    essentials: {
      shipsTo: "AE",
      tShirtSize: "M",
      trouserWaist: "32",
      trouserInseam: "30",
    },
    incident: {
      airline: "Emirates",
      arrivalAirport: "AUH",
      baggageReference: "AUHEK12345",
      noticeAttachmentIds: ["notice-live-1"],
      passengerName: "Demo Passenger",
      flightNumber: "EK123",
      incidentDate: "2026-08-02",
    },
  };
  const quote: CommerceQuote = {
    quoteId: `quote-live-${suffix}`,
    offer,
    addressId: request.address.id,
    quantity: 1,
    subtotal: { amount: "120.00", currency: "AED" },
    shipping: { amount: "15.00", currency: "AED" },
    tax: { amount: "6.75", currency: "AED" },
    total: { amount: "141.75", currency: "AED" },
    deliveryLabel: "Next morning delivery",
    estimatedArrival: "2026-08-03T07:30:00.000+04:00",
    expiresAt: "2026-08-02T07:00:00.000Z",
  };
  return { request, selection, quote };
}

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
  assert.equal(completed?.fulfillment.status, "not_started");
  assert.equal(completed?.fulfillment.merchantOrderId, null);
  assert.doesNotMatch(
    completed?.fulfillment.disclosure ?? "",
    /sandbox|simulat|no live/i,
  );
  assert.ok(
    !completed?.reimbursement.blockers.includes("verified itemized merchant receipt"),
  );
  const sandboxReceipt = completed?.reimbursement.evidence.find(
    (evidence) => evidence.kind === "itemized_receipt",
  );
  assert.equal(sandboxReceipt?.verification, "verified");
  assert.equal(sandboxReceipt?.environment, "sandbox");
  assert.equal(completed?.reimbursement.expenses[0]?.status, "incurred");
  assert.equal(
    completed?.reimbursement.expenses[0]?.receiptEvidenceId,
    sandboxReceipt?.evidenceId,
  );

  const reloaded = new JsonlRecoveryCaseLedger(path);
  assert.deepEqual(await reloaded.get(recovery.caseId), completed);
  const contents = await readFile(path, "utf8");
  assert.doesNotMatch(contents, /dynamic_cvv|network.?token/i);
});

test("persists an idempotent sandbox reimbursement handoff and provider confirmation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tavra-sandbox-handoff-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "cases.jsonl");
  const ledger = new JsonlRecoveryCaseLedger(path);
  const caseId = "RCV-SANDBOXCLAIM";
  const recovery = {
    caseId,
    needBy: "8:00 AM tomorrow",
    deliveryArea: "Abu Dhabi",
    deliveryAddress: "Khalifa City, Abu Dhabi, Room 308",
    deliveryAddressSource: "linq_location" as const,
    airline: "Emirates",
    arrivalAirport: "AUH",
    baggageReference: "RF392942",
    noticeAttachmentIds: ["notice-emirates-1"],
  };
  const products = [
    {
      productRef: "b-shirt-001",
      description: "Neutral basic T-shirt, size M",
      unitPrice: "54.00",
      quantity: 1,
    },
    {
      productRef: "b-trouser-001",
      description: "Basic trousers, 32x30",
      unitPrice: "78.00",
      quantity: 1,
    },
    {
      productRef: "b-toiletry-001",
      description: "Essential toiletry kit",
      unitPrice: "22.00",
      quantity: 1,
    },
  ];
  await ledger.savePrepared({
    caseId,
    chatId: "chat-sandbox-claim",
    employeeId: "emp-demo-001",
    employeePhone: "+971501234567",
    recovery,
    products,
    totalAmount: "154.00",
    currency: "USD",
    checkoutId: "checkout-sandbox-claim",
    incidentEvidence: {
      passengerName: "Demo Traveler",
      flightNumber: "EK231",
      incidentDate: "2026-08-02",
    },
  });
  await ledger.addClaimEvidence({
    caseId,
    evidenceId: "EVD-EMIRATES-NOTICE",
    kind: "baggage_delay_notice",
    source: "linq_attachment",
    description: "Employee-confirmed Emirates baggage delay notice",
    verification: "verified",
    attachmentId: "notice-emirates-1",
    sha256: "a".repeat(64),
  });
  const completed = await ledger.recordPayment({
    chatId: "chat-sandbox-claim",
    checkoutId: "checkout-sandbox-claim",
    status: "completed",
    pravaOrderId: "prava-sandbox-claim",
    merchantOrderId: "SIM-EMIRATES-ORDER",
    totalAmount: "154.00",
    currency: "USD",
    employeeId: "emp-demo-001",
    employeePhone: "+971501234567",
    products,
    recovery,
    merchantOutcome: "simulated",
  });
  assert.ok(completed);
  assert.deepEqual(completed.reimbursement.blockers, []);
  assert.equal(
    completed.reimbursement.airlineClaimStatus,
    "ready_for_authorization",
  );
  assert.equal(completed.reimbursement.expenses.length, 3);
  assert.ok(
    completed.reimbursement.expenses.every(
      (expense) => expense.status === "incurred" && expense.receiptEvidenceId,
    ),
  );
  assert.equal(
    completed.reimbursement.evidence.find(
      (evidence) => evidence.kind === "itemized_receipt",
    )?.environment,
    "sandbox",
  );

  const uploaded = await ledger.recordReimbursementPacketUploaded({
    caseId,
    environment: "sandbox",
    packetHash: completed.reimbursement.claimPacket.packetHash,
    attachmentId: "attachment-reimbursement-packet-1",
    filename: "Tavra-Emirates-Reimbursement-RCV-SANDBOXCLAIM.pdf",
    sha256: "c".repeat(64),
    uploadedAt: "2026-08-02T16:00:00.000Z",
  });
  assert.equal(uploaded.reimbursement.handoff?.state, "packet_uploaded");
  const uploadedReplay = await ledger.recordReimbursementPacketUploaded({
    caseId,
    environment: "sandbox",
    packetHash: completed.reimbursement.claimPacket.packetHash,
    attachmentId: "attachment-reimbursement-packet-1",
    filename: "Tavra-Emirates-Reimbursement-RCV-SANDBOXCLAIM.pdf",
    sha256: "c".repeat(64),
    uploadedAt: "2026-08-02T16:00:01.000Z",
  });
  assert.deepEqual(uploadedReplay, uploaded);

  const awaiting = await ledger.markReimbursementAwaitingConfirmation({
    caseId,
    packetHash: completed.reimbursement.claimPacket.packetHash,
    requestedAt: "2026-08-02T16:00:02.000Z",
  });
  assert.equal(awaiting.reimbursement.handoff?.state, "awaiting_confirmation");
  const pending = await ledger.beginSandboxClaimSubmission({
    caseId,
    authorizationEventId: "linq-message-yes-1",
    startedAt: "2026-08-02T16:01:00.000Z",
  });
  assert.equal(pending.reimbursement.handoff?.state, "submission_pending");
  assert.equal(
    pending.reimbursement.authorization?.scope,
    "sandbox_airline_connector",
  );
  const idempotencyKey = pending.reimbursement.handoff?.submissionIdempotencyKey;
  assert.ok(idempotencyKey);
  const pendingReplay = await ledger.beginSandboxClaimSubmission({
    caseId,
    authorizationEventId: "linq-message-yes-retry",
  });
  assert.deepEqual(pendingReplay, pending);
  await assert.rejects(
    () =>
      ledger.recordExternalClaimSubmission({
        caseId,
        submittedBy: "external_connector",
        externalClaimId: "EK-WRONG-PATH",
        confirmationEvidence: {
          description: "Should not cross the sandbox boundary",
          sha256: "d".repeat(64),
        },
      }),
    /sandbox provider confirmation/i,
  );
  await assert.rejects(
    () =>
      ledger.recordSandboxClaimSubmission({
        caseId,
        idempotencyKey: "sandbox-claim-wrong",
        externalClaimId: "EK-DEMO-20260802-001",
        providerConfirmationSha256: "d".repeat(64),
        submittedAt: "2026-08-02T16:02:00.000Z",
        expectedReviewBusinessDays: { min: 3, max: 5 },
        companyNotificationId: "company-notification-001",
        companyNotifiedAt: "2026-08-02T16:02:01.000Z",
      }),
    /does not match the pending submission/i,
  );

  const submitted = await ledger.recordSandboxClaimSubmission({
    caseId,
    idempotencyKey,
    externalClaimId: "EK-DEMO-20260802-001",
    providerConfirmationSha256: "d".repeat(64),
    submittedAt: "2026-08-02T16:02:00.000Z",
    expectedReviewBusinessDays: { min: 3, max: 5 },
    companyNotificationId: "company-notification-001",
    companyNotifiedAt: "2026-08-02T16:02:01.000Z",
  });
  assert.equal(submitted.reimbursement.airlineClaimStatus, "submitted");
  assert.equal(submitted.reimbursement.handoff?.state, "submitted");
  assert.equal(submitted.reimbursement.submission?.environment, "sandbox");
  assert.deepEqual(
    submitted.reimbursement.submission?.expectedReviewBusinessDays,
    { min: 3, max: 5 },
  );
  assert.equal(
    submitted.reimbursement.submission?.companyNotificationId,
    "company-notification-001",
  );
  assert.equal(
    submitted.reimbursement.evidence.find(
      (evidence) => evidence.kind === "submission_confirmation",
    )?.environment,
    "sandbox",
  );
  const submittedReplay = await ledger.recordSandboxClaimSubmission({
    caseId,
    idempotencyKey,
    externalClaimId: "EK-DEMO-20260802-001",
    providerConfirmationSha256: "d".repeat(64),
    submittedAt: "2026-08-02T16:02:00.000Z",
    expectedReviewBusinessDays: { min: 3, max: 5 },
    companyNotificationId: "company-notification-001",
    companyNotifiedAt: "2026-08-02T16:02:01.000Z",
  });
  assert.deepEqual(submittedReplay, submitted);

  const reloaded = new JsonlRecoveryCaseLedger(path);
  assert.deepEqual(await reloaded.get(caseId), submitted);
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

  const etihad = resolveAirlineSubmissionTarget("Etihad Airways");
  assert.equal(etihad.resolution, "official_handoff");
  assert.equal(etihad.airlineCode, "EY");
  assert.equal(etihad.airlineName, "Etihad Airways");
  assert.equal(etihad.channel, "official_web_form");
  assert.equal(
    etihad.submissionUrl,
    "https://www.etihad.com/en/help/baggage-information/baggage-claim-form",
  );
  assert.equal(etihad.policyUrl, "https://www.etihad.com/en/help/faq/baggage");
  assert.deepEqual(etihad.requiredFields, [
    "passenger_name",
    "baggage_reference",
  ]);
  assert.deepEqual(etihad.requiredEvidence, [
    "baggage_delay_notice",
    "itemized_receipt",
  ]);
  assert.equal(etihad.automation, "manual_handoff_only");
  assert.match(etihad.disclosure, /employee must complete the airline form/i);

  const etihadCode = resolveAirlineSubmissionTarget("EY");
  assert.equal(etihadCode.airlineCode, "EY");

  const unknown = resolveAirlineSubmissionTarget("Example Regional Air");
  assert.equal(unknown.resolution, "unresolved");
  assert.equal(unknown.submissionUrl, null);
  assert.match(unknown.disclosure, /will not guess/i);
});

test("builds an Etihad claim draft around the official manual handoff", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tavra-etihad-claim-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledger = new JsonlRecoveryCaseLedger(join(directory, "cases.jsonl"));

  const record = await ledger.saveClaimDraft({
    caseId: "RCV-ETIHAD01",
    chatId: "chat-etihad",
    employeeId: "emp-etihad",
    employeePhone: "+971501234567",
    airline: "Etihad",
    arrivalAirport: "AUH",
    baggageReference: "AUHEY12345",
    passengerName: "Demo Passenger",
    flightNumber: "EY101",
    incidentDate: "2026-08-02",
    noticeAttachmentIds: ["etihad-pir-image"],
  });

  assert.equal(record.reimbursement.submissionTarget.airlineCode, "EY");
  assert.equal(
    record.reimbursement.submissionTarget.submissionUrl,
    "https://www.etihad.com/en/help/baggage-information/baggage-claim-form",
  );
  assert.equal(record.reimbursement.airlineClaimStatus, "draft");
  assert.equal(record.reimbursement.authorization, null);
  assert.equal(record.reimbursement.submission, null);
  assert.match(record.reimbursement.automationBoundary, /manual handoff only/i);
  assert.ok(
    record.reimbursement.blockers.includes("verified baggage delay notice"),
  );
  assert.ok(
    record.reimbursement.blockers.includes("verified itemized merchant receipt"),
  );
  assert.ok(record.reimbursement.blockers.includes("incurred expense details"));
  assert.ok(
    record.reimbursement.evidence.some(
      (evidence) =>
        evidence.kind === "airline_policy_snapshot" &&
        evidence.source === "official_airline" &&
        evidence.verification === "verified" &&
        evidence.sourceUrl === "https://www.etihad.com/en/help/faq/baggage",
    ),
  );
  await assert.rejects(
    () =>
      ledger.authorizeAirlineClaim({
        caseId: record.caseId,
        authorizationEventId: "authorize-etihad-too-early",
      }),
    /not ready/i,
  );
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
  assert.equal(submitted.reimbursement.submission?.environment, "production");
  assert.equal(
    submitted.reimbursement.submission?.expectedReviewBusinessDays,
    null,
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

test("persists a Prava UCP quote and turns only an accepted merchant order into incurred evidence", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tavra-live-commerce-case-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "cases.jsonl");
  const ledger = new JsonlRecoveryCaseLedger(path);
  const { request, selection, quote } = liveCommerceFixture("ORDER1");
  const checkoutId = "checkout-live-order-1";

  const offerReview = await ledger.saveLiveCommercePrepared({
    checkoutId,
    request,
    selection,
  });
  assert.equal(offerReview.commerce?.status, "offer_review");
  assert.equal(offerReview.commerce?.merchant.name, "Abu Dhabi Essentials");
  assert.equal(offerReview.commerce?.merchant.domain, "shop.example.ae");
  assert.equal(offerReview.commerce?.product.productId, selection.offer.productId);
  assert.equal(offerReview.commerce?.product.variantId, selection.offer.variantId);
  assert.deepEqual(offerReview.commerce?.product.options, {
    size: "M",
    color: "Black",
  });
  assert.equal(offerReview.commerce?.quote, null);
  assert.equal(
    offerReview.recovery.deliveryAddress,
    request.address.summary,
  );
  assert.equal(offerReview.recovery.deliveryAddressSource, "prava_address");

  const quoteReview = await ledger.saveLiveCommercePrepared({
    checkoutId,
    request,
    selection,
    quote,
    status: "quote_review",
  });
  assert.equal(quoteReview.commerce?.quote?.quoteId, quote.quoteId);
  assert.equal(quoteReview.commerce?.address.addressId, request.address.id);
  assert.equal(
    quoteReview.commerce?.address.maskedSummary,
    request.address.summary,
  );
  assert.deepEqual(quoteReview.commerce?.quote?.subtotal, {
    amount: "120.00",
    currency: "AED",
  });
  assert.deepEqual(quoteReview.commerce?.quote?.shipping, {
    amount: "15.00",
    currency: "AED",
  });
  assert.deepEqual(quoteReview.commerce?.quote?.tax, {
    amount: "6.75",
    currency: "AED",
  });
  assert.deepEqual(quoteReview.commerce?.quote?.total, {
    amount: "141.75",
    currency: "AED",
  });
  assert.equal(
    quoteReview.commerce?.quote?.estimatedArrival,
    quote.estimatedArrival,
  );
  assert.equal(quoteReview.commerce?.quote?.expiresAt, quote.expiresAt);
  assert.equal(quoteReview.reimbursement.expenses[0]?.status, "proposed");

  await ledger.saveLiveCommercePrepared({
    checkoutId,
    request,
    selection,
    quote,
    paymentSessionId: "payment-session-live-1",
    status: "approval_pending",
  });
  const event: LiveCommerceStatusEvent = {
    checkoutId,
    caseId: request.caseId,
    chatId: request.chatId,
    employeeId: request.employeeId,
    employeePhone: request.employeePhone,
    state: "order_confirmed",
    selection,
    quote,
    paymentSessionId: "payment-session-live-1",
    checkoutResult: {
      status: "ordered",
      orderId: "MERCHANT-AE-10001",
      amount: quote.total,
      replayed: false,
    },
  };
  const ordered = await ledger.recordLiveCommerce(event);

  assert.equal(ordered.status, "merchant_order_confirmed");
  assert.equal(ordered.payment.status, "approved");
  assert.equal(ordered.payment.pravaReference, "payment-session-live-1");
  assert.equal(ordered.fulfillment.merchantOrderId, "MERCHANT-AE-10001");
  assert.equal(ordered.commerce?.status, "order_confirmed");
  assert.equal(ordered.commerce?.order?.orderId, "MERCHANT-AE-10001");
  assert.deepEqual(ordered.commerce?.order?.amount, quote.total);
  assert.equal(ordered.reimbursement.expenses.length, 1);
  assert.equal(ordered.reimbursement.expenses[0]?.status, "incurred");
  assert.equal(ordered.reimbursement.expenses[0]?.amount, "141.75");
  assert.equal(
    ordered.reimbursement.expenses[0]?.merchantName,
    "Abu Dhabi Essentials",
  );
  assert.equal(ordered.reimbursement.expenses[0]?.receiptEvidenceId, null);
  assert.equal(
    ordered.reimbursement.evidence.filter(
      (evidence) => evidence.kind === "merchant_order",
    ).length,
    1,
  );
  assert.equal(
    ordered.reimbursement.evidence.filter(
      (evidence) => evidence.kind === "payment_authorization",
    ).length,
    1,
  );
  assert.equal(
    ordered.reimbursement.evidence.filter(
      (evidence) => evidence.kind === "itemized_receipt",
    ).length,
    0,
  );
  assert.ok(
    ordered.reimbursement.blockers.includes("verified itemized merchant receipt"),
  );
  assert.ok(
    ordered.reimbursement.blockers.includes(
      "receipt linked to each incurred expense",
    ),
  );

  assert.deepEqual(await ledger.recordLiveCommerce(event), ordered);
  const reloaded = new JsonlRecoveryCaseLedger(path);
  assert.deepEqual(await reloaded.get(request.caseId), ordered);
  const contents = await readFile(path, "utf8");
  assert.doesNotMatch(contents, /dynamic_cvv|network.?token|card.?number/i);
});

test("records ambiguous, failed, and canceled live outcomes without claiming an order or receipt", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tavra-live-outcomes-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledger = new JsonlRecoveryCaseLedger(join(directory, "cases.jsonl"));

  const cases = [
    {
      suffix: "RECON1",
      state: "reconciliation_required" as const,
      result: {
        status: "reconciliation_required" as const,
        message: "Merchant result timed out",
      },
      caseStatus: "payment_reconciliation_required",
      paymentStatus: "reconciliation_required",
    },
    {
      suffix: "FAILED1",
      state: "failed" as const,
      result: {
        status: "failed" as const,
        message: "Merchant declined checkout",
      },
      caseStatus: "payment_failed",
      paymentStatus: "failed",
    },
    {
      suffix: "CANCEL1",
      state: "canceled" as const,
      result: null,
      caseStatus: "payment_canceled",
      paymentStatus: "canceled",
    },
  ];

  for (const expected of cases) {
    const { request, selection, quote } = liveCommerceFixture(expected.suffix);
    const checkoutId = `checkout-${expected.suffix.toLowerCase()}`;
    await ledger.saveLiveCommercePrepared({
      checkoutId,
      request,
      selection,
      quote,
      paymentSessionId: `payment-${expected.suffix.toLowerCase()}`,
      status: "approval_pending",
    });
    const result = await ledger.recordLiveCommerce({
      checkoutId,
      caseId: request.caseId,
      chatId: request.chatId,
      employeeId: request.employeeId,
      employeePhone: request.employeePhone,
      state: expected.state,
      selection,
      quote,
      paymentSessionId: `payment-${expected.suffix.toLowerCase()}`,
      checkoutResult: expected.result,
    });

    assert.equal(result.status, expected.caseStatus);
    assert.equal(result.payment.status, expected.paymentStatus);
    assert.equal(result.fulfillment.status, "not_started");
    assert.equal(result.fulfillment.merchantOrderId, null);
    assert.equal(result.commerce?.status, expected.state);
    assert.equal(result.commerce?.order, null);
    assert.equal(result.reimbursement.expenses[0]?.status, "proposed");
    assert.equal(
      result.reimbursement.evidence.some(
        (evidence) =>
          evidence.kind === "merchant_order" ||
          evidence.kind === "payment_authorization" ||
          evidence.kind === "itemized_receipt",
      ),
      false,
    );
    await assert.rejects(
      () =>
        ledger.saveLiveCommercePrepared({
          checkoutId,
          request,
          selection,
          quote,
        }),
      /terminal live commerce attempt/i,
    );
  }
});

test("rejects a terminal live result that is not bound to the prepared quote", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tavra-live-mismatch-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledger = new JsonlRecoveryCaseLedger(join(directory, "cases.jsonl"));
  const { request, selection, quote } = liveCommerceFixture("MISMATCH1");
  const checkoutId = "checkout-live-mismatch";
  await ledger.saveLiveCommercePrepared({
    checkoutId,
    request,
    selection,
    quote,
    paymentSessionId: "payment-live-mismatch",
    status: "approval_pending",
  });

  await assert.rejects(
    () =>
      ledger.recordLiveCommerce({
        checkoutId,
        caseId: request.caseId,
        chatId: request.chatId,
        employeeId: request.employeeId,
        employeePhone: request.employeePhone,
        state: "order_confirmed",
        selection,
        quote: {
          ...quote,
          total: { amount: "142.00", currency: "AED" },
        },
        paymentSessionId: "payment-live-mismatch",
        checkoutResult: {
          status: "ordered",
          orderId: "ORDER-WRONG-TOTAL",
          amount: { amount: "142.00", currency: "AED" },
          replayed: false,
        },
      }),
    /breakdown|approved quote/i,
  );
  const record = await ledger.get(request.caseId);
  assert.equal(record?.status, "payment_approval_pending");
  assert.equal(record?.fulfillment.merchantOrderId, null);
  assert.equal(record?.reimbursement.expenses[0]?.status, "proposed");
});
