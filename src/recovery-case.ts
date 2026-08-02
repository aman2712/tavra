import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, appendFile } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  PravaProduct,
  PravaStatusEvent,
  RecoveryCheckoutContext,
} from "./prava.js";
import {
  commerceAmountMinor,
  normalizeCommerceAmount,
  type CommerceMoney,
  type CommerceQuote,
  type RecoveryEssentialSelection,
} from "./commerce.js";
import type {
  LiveCommerceRecoveryRequest,
  LiveCommerceStatusEvent,
} from "./live-commerce.js";

export type RecoveryCaseStatus =
  | "claim_draft"
  | "payment_approval_pending"
  | "sandbox_authorization_complete"
  | "merchant_order_confirmed"
  | "payment_reconciliation_required"
  | "payment_canceled"
  | "payment_failed";

export type LiveCommerceCaseStatus =
  | "offer_review"
  | "quote_review"
  | "approval_pending"
  | "order_confirmed"
  | "failed"
  | "reconciliation_required"
  | "canceled";

export interface LiveCommerceQuoteRecord {
  quoteId: string;
  quantity: number;
  subtotal: CommerceMoney;
  shipping: CommerceMoney;
  tax: CommerceMoney;
  total: CommerceMoney;
  deliveryLabel: string | null;
  estimatedArrival: string | null;
  expiresAt: string;
}

export interface LiveCommerceCaseRecord {
  provider: "prava_ucp";
  status: LiveCommerceCaseStatus;
  checkoutId: string;
  provenance: {
    source: "prava_ucp";
    retrievedAt: string;
  };
  merchant: {
    name: string;
    domain: string;
    country: string | null;
  };
  product: {
    productId: string;
    variantId: string;
    category: RecoveryEssentialSelection["category"];
    title: string;
    description: string;
    options: Record<string, string>;
    imageUrl: string;
    unitPrice: CommerceMoney;
  };
  address: {
    addressId: string;
    maskedSummary: string;
  };
  quote: LiveCommerceQuoteRecord | null;
  paymentSessionId: string | null;
  order: {
    orderId: string;
    amount: CommerceMoney;
    replayed: boolean;
  } | null;
}

export interface SaveLiveCommercePreparedInput {
  checkoutId: string;
  request: LiveCommerceRecoveryRequest;
  selection: RecoveryEssentialSelection;
  quote?: CommerceQuote | null;
  paymentSessionId?: string | null;
  status?: "offer_review" | "quote_review" | "approval_pending";
}

export type ClaimEvidenceKind =
  | "baggage_delay_notice"
  | "baggage_file_reference"
  | "passenger_identity"
  | "travel_itinerary"
  | "baggage_check"
  | "itemized_receipt"
  | "merchant_order"
  | "payment_authorization"
  | "airline_policy_snapshot"
  | "submission_confirmation";

export interface ClaimEvidenceRecord {
  evidenceId: string;
  kind: ClaimEvidenceKind;
  source:
    | "employee_message"
    | "linq_attachment"
    | "merchant"
    | "prava"
    | "official_airline"
    | "external_confirmation";
  description: string;
  capturedAt: string;
  verification: "unverified" | "verified" | "rejected";
  attachmentId: string | null;
  sha256: string | null;
  sourceUrl: string | null;
  /** Internal provenance boundary. Sandbox evidence is never promoted to production. */
  environment?: "sandbox" | "production";
}

export interface ClaimExpenseRecord {
  expenseId: string;
  description: string;
  amount: string;
  currency: string;
  quantity: number;
  merchantName: string | null;
  purchasedAt: string | null;
  receiptEvidenceId: string | null;
  status: "proposed" | "incurred";
}

export interface AirlineSubmissionTarget {
  resolution: "official_handoff" | "unresolved";
  airlineCode: string | null;
  airlineName: string;
  channel:
    | "official_web_form"
    | "official_guidance_page"
    | "manual_research_required";
  submissionUrl: string | null;
  policyUrl: string | null;
  requiredFields: Array<"passenger_name" | "baggage_reference">;
  requiredEvidence: ClaimEvidenceKind[];
  automation: "manual_handoff_only";
  reviewedAt: string;
  disclosure: string;
}

export interface ReimbursementClaimPacket {
  schemaVersion: 1;
  caseId: string;
  generatedAt: string;
  incident: {
    airline: string;
    arrivalAirport: string;
    baggageReference: string | null;
    passengerName: string | null;
    flightNumber: string | null;
    incidentDate: string | null;
  };
  expenses: ClaimExpenseRecord[];
  evidenceIds: string[];
  submissionTarget: AirlineSubmissionTarget;
  packetHash: string;
}

export interface ClaimAuthorizationRecord {
  authorizedAt: string;
  authorizedBy: "employee";
  authorizationEventId: string;
  packetHash: string;
  scope: "manual_airline_claim_handoff" | "sandbox_airline_connector";
}

export interface ClaimSubmissionRecord {
  submittedAt: string;
  submittedBy: "employee" | "support" | "external_connector";
  externalClaimId: string;
  confirmationEvidenceId: string;
  packetHash: string;
  environment?: "sandbox" | "production";
  expectedReviewBusinessDays?: { min: number; max: number } | null;
  companyNotificationId?: string | null;
  companyNotifiedAt?: string | null;
}

export type ReimbursementHandoffState =
  | "packet_uploaded"
  | "awaiting_confirmation"
  | "submission_pending"
  | "submitted";

export interface ReimbursementHandoffRecord {
  environment: "sandbox" | "production";
  state: ReimbursementHandoffState;
  packetHash: string;
  packetAttachmentId: string;
  packetFilename: string;
  packetSha256: string;
  uploadedAt: string;
  confirmationRequestedAt: string | null;
  authorizationEventId: string | null;
  submissionIdempotencyKey: string | null;
  submissionStartedAt: string | null;
  expectedReviewBusinessDays: { min: number; max: number } | null;
  companyNotificationId: string | null;
  companyNotifiedAt: string | null;
}

export interface RecoveryCaseRecord {
  caseId: string;
  chatId: string;
  employeeId: string;
  employeePhone: string;
  status: RecoveryCaseStatus;
  incident: {
    airline: string;
    arrivalAirport: string;
    baggageReference: string | null;
    passengerName: string | null;
    flightNumber: string | null;
    incidentDate: string | null;
    noticeAttachmentIds: string[];
  };
  recovery: {
    needBy: string | null;
    deliveryArea: string | null;
    deliveryAddress: string | null;
    deliveryAddressSource:
      | "message"
      | "linq_location"
      | "prava_address"
      | null;
    products: PravaProduct[];
    totalAmount: string | null;
    currency: string | null;
  };
  payment: {
    checkoutId: string | null;
    pravaReference: string | null;
    status:
      | "not_started"
      | "pending"
      | "approved"
      | "reconciliation_required"
      | "canceled"
      | "failed";
  };
  fulfillment: {
    status: "not_started" | "merchant_order_confirmed";
    merchantOrderId: string | null;
    disclosure: string;
  };
  commerce: LiveCommerceCaseRecord | null;
  reimbursement: {
    airlineClaimStatus:
      | "draft"
      | "ready_for_authorization"
      | "authorized_for_handoff"
      | "submitted";
    employerExpenseStatus: "draft";
    blockers: string[];
    evidence: ClaimEvidenceRecord[];
    expenses: ClaimExpenseRecord[];
    submissionTarget: AirlineSubmissionTarget;
    claimPacket: ReimbursementClaimPacket;
    authorization: ClaimAuthorizationRecord | null;
    submission: ClaimSubmissionRecord | null;
    handoff?: ReimbursementHandoffRecord | null;
    automationBoundary: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface RecoveryCaseLedger {
  savePrepared(input: {
    caseId: string;
    chatId: string;
    employeeId: string;
    employeePhone: string;
    recovery: RecoveryCheckoutContext;
    products: PravaProduct[];
    totalAmount: string;
    currency: string;
    checkoutId: string;
    incidentEvidence?: {
      passengerName?: string | null;
      flightNumber?: string | null;
      incidentDate?: string | null;
    };
  }): Promise<RecoveryCaseRecord>;
  saveClaimDraft(input: {
    caseId: string;
    chatId: string;
    employeeId: string;
    employeePhone: string;
    airline: string;
    arrivalAirport: string;
    baggageReference: string | null;
    noticeAttachmentIds: string[];
    passengerName?: string | null;
    flightNumber?: string | null;
    incidentDate?: string | null;
  }): Promise<RecoveryCaseRecord>;
  addClaimEvidence(input: {
    caseId: string;
    evidenceId?: string;
    kind: ClaimEvidenceKind;
    source: ClaimEvidenceRecord["source"];
    description: string;
    capturedAt?: string;
    verification?: ClaimEvidenceRecord["verification"];
    attachmentId?: string | null;
    sha256?: string | null;
    sourceUrl?: string | null;
  }): Promise<RecoveryCaseRecord>;
  addClaimExpense(input: {
    caseId: string;
    expenseId?: string;
    description: string;
    amount: string;
    currency: string;
    quantity?: number;
    merchantName?: string | null;
    purchasedAt?: string | null;
    receiptEvidenceId?: string | null;
    status?: ClaimExpenseRecord["status"];
  }): Promise<RecoveryCaseRecord>;
  authorizeAirlineClaim(input: {
    caseId: string;
    authorizationEventId: string;
  }): Promise<RecoveryCaseRecord>;
  recordExternalClaimSubmission(input: {
    caseId: string;
    submittedBy: ClaimSubmissionRecord["submittedBy"];
    externalClaimId: string;
    submittedAt?: string;
    confirmationEvidence: {
      evidenceId?: string;
      description: string;
      attachmentId?: string | null;
      sha256?: string | null;
      sourceUrl?: string | null;
    };
  }): Promise<RecoveryCaseRecord>;
  recordReimbursementPacketUploaded?(input: {
    caseId: string;
    environment: "sandbox" | "production";
    packetHash: string;
    attachmentId: string;
    filename: string;
    sha256: string;
    uploadedAt?: string;
  }): Promise<RecoveryCaseRecord>;
  markReimbursementAwaitingConfirmation?(input: {
    caseId: string;
    packetHash: string;
    requestedAt?: string;
  }): Promise<RecoveryCaseRecord>;
  beginSandboxClaimSubmission?(input: {
    caseId: string;
    authorizationEventId: string;
    startedAt?: string;
  }): Promise<RecoveryCaseRecord>;
  recordSandboxClaimSubmission?(input: {
    caseId: string;
    idempotencyKey: string;
    externalClaimId: string;
    providerConfirmationSha256: string;
    submittedAt?: string;
    expectedReviewBusinessDays: { min: 3; max: 5 };
    companyNotificationId: string;
    companyNotifiedAt?: string;
  }): Promise<RecoveryCaseRecord>;
  recordPayment(event: PravaStatusEvent): Promise<RecoveryCaseRecord | null>;
  saveLiveCommercePrepared(
    input: SaveLiveCommercePreparedInput,
  ): Promise<RecoveryCaseRecord>;
  recordLiveCommerce(event: LiveCommerceStatusEvent): Promise<RecoveryCaseRecord>;
  get(caseId: string): Promise<RecoveryCaseRecord | null>;
  getLatestForChat(chatId: string): Promise<RecoveryCaseRecord | null>;
}

const TARGET_REVIEWED_AT = "2026-08-02";
const AUTOMATION_BOUNDARY =
  "Production airline claims remain manual handoff only and are recorded as submitted only from separate external confirmation evidence. Sandbox provider confirmations are stored with environment=sandbox and are never promoted to production evidence.";

const AIRLINE_TARGETS: Array<{
  aliases: RegExp;
  target: Omit<AirlineSubmissionTarget, "resolution" | "automation" | "reviewedAt" | "disclosure">;
}> = [
  {
    aliases: /\b(?:delta|delta air lines?|dl)\b/i,
    target: {
      airlineCode: "DL",
      airlineName: "Delta Air Lines",
      channel: "official_web_form",
      submissionUrl: "https://www.delta.com/bag-claim",
      policyUrl:
        "https://www.delta.com/us/en/baggage/delayed-lost-damaged-baggage",
      requiredFields: ["passenger_name", "baggage_reference"],
      requiredEvidence: ["baggage_delay_notice", "itemized_receipt"],
    },
  },
  {
    aliases: /\b(?:american|american airlines?|aa)\b/i,
    target: {
      airlineCode: "AA",
      airlineName: "American Airlines",
      channel: "official_web_form",
      submissionUrl:
        "https://centralbaggage.aa.com/en-US/?from=selfServiceCallouts-BG-DLD_RIBSMT",
      policyUrl:
        "https://www.aa.com/web/i18n/travel-info/baggage/delayed-or-damaged-baggage.html",
      requiredFields: ["passenger_name", "baggage_reference"],
      requiredEvidence: [
        "baggage_delay_notice",
        "travel_itinerary",
        "baggage_check",
        "itemized_receipt",
      ],
    },
  },
  {
    aliases: /\b(?:etihad(?: airways)?|ey)\b/i,
    target: {
      airlineCode: "EY",
      airlineName: "Etihad Airways",
      channel: "official_web_form",
      submissionUrl:
        "https://www.etihad.com/en/help/baggage-information/baggage-claim-form",
      policyUrl: "https://www.etihad.com/en/help/faq/baggage",
      requiredFields: ["passenger_name", "baggage_reference"],
      requiredEvidence: ["baggage_delay_notice", "itemized_receipt"],
    },
  },
  {
    aliases: /\b(?:emirates|ek)\b/i,
    target: {
      airlineCode: "EK",
      airlineName: "Emirates",
      channel: "official_guidance_page",
      submissionUrl:
        "https://www.emirates.com/english/help/forms/complaint/",
      policyUrl:
        "https://www.emirates.com/english/before-you-fly/baggage/delayed-damaged-baggage/",
      requiredFields: ["passenger_name", "baggage_reference"],
      requiredEvidence: ["baggage_delay_notice", "itemized_receipt"],
    },
  },
];

export function resolveAirlineSubmissionTarget(
  airline: string,
): AirlineSubmissionTarget {
  const normalized = airline.replace(/\s+/g, " ").trim();
  const matched = AIRLINE_TARGETS.find(({ aliases }) => aliases.test(normalized));
  if (!matched) {
    return {
      resolution: "unresolved",
      airlineCode: null,
      airlineName: normalized || "Unknown airline",
      channel: "manual_research_required",
      submissionUrl: null,
      policyUrl: null,
      requiredFields: [],
      requiredEvidence: ["baggage_delay_notice", "itemized_receipt"],
      automation: "manual_handoff_only",
      reviewedAt: TARGET_REVIEWED_AT,
      disclosure:
        "No reviewed official submission destination is configured for this airline. Tavra will not guess a claim URL or claim that it submitted anything.",
    };
  }
  return {
    ...matched.target,
    resolution: "official_handoff",
    automation: "manual_handoff_only",
    reviewedAt: TARGET_REVIEWED_AT,
    disclosure:
      "This is a reviewed official handoff destination, not an airline API. The employee must complete the airline form, and Tavra records submission only after receiving external confirmation.",
  };
}

function stableEvidenceId(parts: string[]): string {
  return `EVD-${createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 12).toUpperCase()}`;
}

function validAmount(value: string): string {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value) || Number(value) < 0) {
    throw new Error("Claim expense amount must be a non-negative decimal string");
  }
  return Number(value).toFixed(2);
}

function validSha256(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(`${label} must be a 64-character hex digest`);
  }
  return normalized;
}

function validIsoTimestamp(value: string, label: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

function handoffIdentifier(value: string, label: string, max = 180): string {
  const normalized = value.trim();
  if (
    normalized.length < 4 ||
    normalized.length > max ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalized)
  ) {
    throw new Error(`${label} contains unsupported characters`);
  }
  return normalized;
}

function reimbursementPacketFilename(value: string): string {
  const filename = value.trim();
  if (
    filename.length < 5 ||
    filename.length > 120 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*\.pdf$/i.test(filename)
  ) {
    throw new Error("Reimbursement packet filename must be a safe PDF filename");
  }
  return filename;
}

function conciseCommerceValue(value: string, label: string, max = 240): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned.length > max) {
    throw new Error(`Live commerce ${label} is invalid`);
  }
  return cleaned;
}

function commerceMoney(value: CommerceMoney): CommerceMoney {
  return {
    amount: normalizeCommerceAmount(value.amount),
    currency: value.currency,
  };
}

function liveQuoteRecord(quote: CommerceQuote): LiveCommerceQuoteRecord {
  if (!Number.isInteger(quote.quantity) || quote.quantity < 1) {
    throw new Error("Live commerce quote quantity must be a positive integer");
  }
  if (!Number.isFinite(Date.parse(quote.expiresAt))) {
    throw new Error("Live commerce quote expiry must be an ISO timestamp");
  }
  if (
    quote.estimatedArrival &&
    !Number.isFinite(Date.parse(quote.estimatedArrival))
  ) {
    throw new Error("Live commerce delivery estimate must be an ISO timestamp");
  }
  const currency = quote.total.currency;
  if (
    quote.subtotal.currency !== currency ||
    quote.shipping.currency !== currency ||
    quote.tax.currency !== currency
  ) {
    throw new Error("Live commerce quote uses mixed currencies");
  }
  const subtotal = commerceMoney(quote.subtotal);
  const shipping = commerceMoney(quote.shipping);
  const tax = commerceMoney(quote.tax);
  const total = commerceMoney(quote.total);
  const calculated =
    commerceAmountMinor(subtotal.amount) +
    commerceAmountMinor(shipping.amount) +
    commerceAmountMinor(tax.amount);
  if (calculated !== commerceAmountMinor(total.amount)) {
    throw new Error("Live commerce quote total does not match its breakdown");
  }
  return {
    quoteId: conciseCommerceValue(quote.quoteId, "quote ID", 180),
    quantity: quote.quantity,
    subtotal,
    shipping,
    tax,
    total,
    deliveryLabel: quote.deliveryLabel
      ? conciseCommerceValue(quote.deliveryLabel, "delivery label")
      : null,
    estimatedArrival: quote.estimatedArrival,
    expiresAt: quote.expiresAt,
  };
}

function liveCommerceRecord(
  input: SaveLiveCommercePreparedInput,
): LiveCommerceCaseRecord {
  const { offer } = input.selection;
  if (
    offer.provenance.source !== "prava_ucp" ||
    offer.provenance.merchantDomain !== offer.merchant.domain
  ) {
    throw new Error("Live commerce offer lacks matching Prava UCP provenance");
  }
  if (input.quote) {
    if (
      input.quote.offer.productId !== offer.productId ||
      input.quote.offer.variantId !== offer.variantId ||
      input.quote.offer.merchant.domain !== offer.merchant.domain ||
      input.quote.addressId !== input.request.address.id
    ) {
      throw new Error(
        "Live commerce quote does not match the selected product and address",
      );
    }
  }
  const imageUrl = new URL(offer.imageUrl ?? "");
  if (
    imageUrl.protocol !== "https:" ||
    imageUrl.username ||
    imageUrl.password
  ) {
    throw new Error("Live commerce product image must use trusted HTTPS");
  }
  const status =
    input.status ??
    (input.paymentSessionId
      ? "approval_pending"
      : input.quote
        ? "quote_review"
        : "offer_review");
  if (status !== "offer_review" && !input.quote) {
    throw new Error("Live commerce quote review requires an exact quote");
  }
  if (status === "approval_pending" && !input.paymentSessionId) {
    throw new Error("Live commerce approval requires a payment session ID");
  }
  return {
    provider: "prava_ucp",
    status,
    checkoutId: conciseCommerceValue(input.checkoutId, "checkout ID", 180),
    provenance: {
      source: "prava_ucp",
      retrievedAt: offer.provenance.retrievedAt,
    },
    merchant: {
      name: conciseCommerceValue(offer.merchant.name, "merchant name"),
      domain: conciseCommerceValue(offer.merchant.domain, "merchant domain", 253),
      country: offer.merchant.country
        ? conciseCommerceValue(offer.merchant.country, "merchant country", 80)
        : null,
    },
    product: {
      productId: conciseCommerceValue(offer.productId, "product ID", 180),
      variantId: conciseCommerceValue(offer.variantId, "variant ID", 180),
      category: input.selection.category,
      title: conciseCommerceValue(offer.title, "product title"),
      description: conciseCommerceValue(offer.description, "product description"),
      options: Object.fromEntries(
        Object.entries(offer.options).map(([key, value]) => [
          conciseCommerceValue(key, "option name", 80),
          conciseCommerceValue(value, "option value", 120),
        ]),
      ),
      imageUrl: imageUrl.toString(),
      unitPrice: commerceMoney(offer.unitPrice),
    },
    address: {
      addressId: conciseCommerceValue(input.request.address.id, "address ID", 180),
      maskedSummary: conciseCommerceValue(
        input.request.address.summary,
        "masked address summary",
      ),
    },
    quote: input.quote ? liveQuoteRecord(input.quote) : null,
    paymentSessionId: input.paymentSessionId
      ? conciseCommerceValue(
          input.paymentSessionId,
          "payment session ID",
          180,
        )
      : null,
    order: null,
  };
}

function upsertEvidence(
  record: RecoveryCaseRecord,
  evidence: ClaimEvidenceRecord,
): void {
  const index = record.reimbursement.evidence.findIndex(
    (candidate) => candidate.evidenceId === evidence.evidenceId,
  );
  if (index >= 0) record.reimbursement.evidence[index] = evidence;
  else record.reimbursement.evidence.push(evidence);
}

function insertEvidenceIfMissing(
  record: RecoveryCaseRecord,
  evidence: ClaimEvidenceRecord,
): void {
  if (
    !record.reimbursement.evidence.some(
      (candidate) => candidate.evidenceId === evidence.evidenceId,
    )
  ) {
    record.reimbursement.evidence.push(evidence);
  }
}

function ensureDerivedEvidence(record: RecoveryCaseRecord): void {
  for (const attachmentId of record.incident.noticeAttachmentIds) {
    insertEvidenceIfMissing(record, {
      evidenceId: stableEvidenceId([
        record.caseId,
        "baggage_delay_notice",
        attachmentId,
      ]),
      kind: "baggage_delay_notice",
      source: "linq_attachment",
      description: "Employee-provided baggage disruption notice",
      capturedAt: record.createdAt,
      verification: "unverified",
      attachmentId,
      sha256: null,
      sourceUrl: null,
    });
  }
  if (record.incident.baggageReference) {
    insertEvidenceIfMissing(record, {
      evidenceId: stableEvidenceId([
        record.caseId,
        "baggage_file_reference",
        record.incident.baggageReference,
      ]),
      kind: "baggage_file_reference",
      source: "employee_message",
      description: "Baggage file reference supplied for this incident",
      capturedAt: record.createdAt,
      verification: "unverified",
      attachmentId: null,
      sha256: null,
      sourceUrl: null,
    });
  }
  if (record.incident.passengerName) {
    insertEvidenceIfMissing(record, {
      evidenceId: stableEvidenceId([
        record.caseId,
        "passenger_identity",
        record.incident.passengerName,
      ]),
      kind: "passenger_identity",
      source: "employee_message",
      description: "Passenger name supplied for the airline claim",
      capturedAt: record.createdAt,
      verification: "unverified",
      attachmentId: null,
      sha256: null,
      sourceUrl: null,
    });
  }
  const target = record.reimbursement.submissionTarget;
  if (target.policyUrl) {
    insertEvidenceIfMissing(record, {
      evidenceId: stableEvidenceId([
        record.caseId,
        "airline_policy_snapshot",
        target.policyUrl,
        target.reviewedAt,
      ]),
      kind: "airline_policy_snapshot",
      source: "official_airline",
      description: `Reviewed official ${target.airlineName} baggage-claim guidance`,
      capturedAt: `${target.reviewedAt}T00:00:00.000Z`,
      verification: "verified",
      attachmentId: null,
      sha256: null,
      sourceUrl: target.policyUrl,
    });
  }
}

function hasVerifiedEvidence(
  record: RecoveryCaseRecord,
  kind: ClaimEvidenceKind,
): boolean {
  return record.reimbursement.evidence.some(
    (evidence) => evidence.kind === kind && evidence.verification === "verified",
  );
}

function blockers(record: RecoveryCaseRecord): string[] {
  const target = record.reimbursement.submissionTarget;
  const evidenceLabel = (kind: ClaimEvidenceKind) =>
    kind === "itemized_receipt"
      ? "verified itemized merchant receipt"
      : `verified ${kind.replaceAll("_", " ")}`;
  const missing: Array<string | false> = [
    !record.incident.airline && "airline",
    !record.incident.arrivalAirport && "arrival airport",
    target.resolution !== "official_handoff" &&
      "reviewed official airline submission destination",
    target.requiredFields.includes("passenger_name") &&
      !record.incident.passengerName &&
      "passenger name as shown on the baggage report",
    target.requiredFields.includes("baggage_reference") &&
      !record.incident.baggageReference &&
      "airline baggage file reference",
    ...target.requiredEvidence.map(
      (kind) =>
        !hasVerifiedEvidence(record, kind) &&
        evidenceLabel(kind),
    ),
    !record.reimbursement.expenses.some((expense) => expense.status === "incurred") &&
      "incurred expense details",
    record.reimbursement.expenses.some(
      (expense) => expense.status === "incurred" && !expense.receiptEvidenceId,
    ) && "receipt linked to each incurred expense",
  ];
  return [...new Set(missing.filter((value): value is string => Boolean(value)))];
}

/**
 * The configured sandbox connector can exercise the handoff after the employee
 * confirms the core incident and an approved recovery expense exists. Evidence
 * verification remains visible in the durable packet, but it does not prevent
 * returning or exercising that sandbox packet. Production authorization keeps
 * using the complete `blockers` checklist above.
 */
function sandboxSubmissionBlockers(record: RecoveryCaseRecord): string[] {
  const missing: Array<string | false> = [
    !record.incident.airline && "airline",
    !record.incident.arrivalAirport && "arrival airport",
    !record.incident.baggageReference && "airline baggage file reference",
    !record.recovery.deliveryAddress && "confirmed delivery address",
    record.payment.status !== "approved" && "approved recovery payment",
    record.reimbursement.submissionTarget.resolution !== "official_handoff" &&
      "reviewed official airline submission destination",
    !record.reimbursement.expenses.some(
      (expense) => expense.status === "incurred",
    ) && "incurred expense details",
    record.reimbursement.expenses.some(
      (expense) => expense.status === "incurred" && !expense.receiptEvidenceId,
    ) && "receipt linked to each incurred expense",
  ];
  return [...new Set(missing.filter((value): value is string => Boolean(value)))];
}

function buildClaimPacket(record: RecoveryCaseRecord): ReimbursementClaimPacket {
  const packetContents = {
    schemaVersion: 1 as const,
    caseId: record.caseId,
    incident: {
      airline: record.incident.airline,
      arrivalAirport: record.incident.arrivalAirport,
      baggageReference: record.incident.baggageReference,
      passengerName: record.incident.passengerName,
      flightNumber: record.incident.flightNumber,
      incidentDate: record.incident.incidentDate,
    },
    expenses: record.reimbursement.expenses.map((expense) => ({ ...expense })),
    evidenceIds: record.reimbursement.evidence
      .filter(
        (evidence) =>
          evidence.verification !== "rejected" &&
          evidence.kind !== "submission_confirmation",
      )
      .map((evidence) => evidence.evidenceId)
      .sort(),
    submissionTarget: structuredClone(record.reimbursement.submissionTarget),
  };
  return {
    ...packetContents,
    generatedAt: record.updatedAt,
    packetHash: createHash("sha256")
      .update(JSON.stringify(packetContents))
      .digest("hex"),
  };
}

function refreshReimbursement(record: RecoveryCaseRecord): void {
  record.reimbursement.submissionTarget = resolveAirlineSubmissionTarget(
    record.incident.airline,
  );
  ensureDerivedEvidence(record);
  const claimPacket = buildClaimPacket(record);
  if (
    record.reimbursement.submission &&
    record.reimbursement.submission.packetHash !== claimPacket.packetHash
  ) {
    throw new Error("A submitted airline claim packet cannot be changed");
  }
  record.reimbursement.claimPacket = claimPacket;
  if (
    record.reimbursement.handoff &&
    record.reimbursement.handoff.packetHash !== claimPacket.packetHash
  ) {
    if (record.reimbursement.handoff.state === "submitted") {
      throw new Error("A submitted reimbursement handoff packet cannot be changed");
    }
    record.reimbursement.handoff = null;
  }
  record.reimbursement.blockers = blockers(record);
  if (record.reimbursement.submission) {
    record.reimbursement.airlineClaimStatus = "submitted";
    return;
  }
  if (
    record.reimbursement.authorization &&
    record.reimbursement.authorization.packetHash !==
      record.reimbursement.claimPacket.packetHash
  ) {
    record.reimbursement.authorization = null;
  }
  record.reimbursement.airlineClaimStatus = record.reimbursement.authorization
    ? "authorized_for_handoff"
    : record.reimbursement.blockers.length === 0
      ? "ready_for_authorization"
      : "draft";
}

function baseRecord(input: {
  caseId: string;
  chatId: string;
  employeeId: string;
  employeePhone: string;
  airline: string;
  arrivalAirport: string;
  baggageReference: string | null;
  noticeAttachmentIds: string[];
  passengerName?: string | null;
  flightNumber?: string | null;
  incidentDate?: string | null;
}): RecoveryCaseRecord {
  const now = new Date().toISOString();
  const record: RecoveryCaseRecord = {
    caseId: input.caseId,
    chatId: input.chatId,
    employeeId: input.employeeId,
    employeePhone: input.employeePhone,
    status: "claim_draft",
    incident: {
      airline: input.airline,
      arrivalAirport: input.arrivalAirport,
      baggageReference: input.baggageReference,
      passengerName: input.passengerName ?? null,
      flightNumber: input.flightNumber ?? null,
      incidentDate: input.incidentDate ?? null,
      noticeAttachmentIds: [...input.noticeAttachmentIds],
    },
    recovery: {
      needBy: null,
      deliveryArea: null,
      deliveryAddress: null,
      deliveryAddressSource: null,
      products: [],
      totalAmount: null,
      currency: null,
    },
    payment: {
      checkoutId: null,
      pravaReference: null,
      status: "not_started",
    },
    fulfillment: {
      status: "not_started",
      merchantOrderId: null,
      disclosure:
        "No verified merchant outcome has been recorded. A Prava approval alone is not a merchant order.",
    },
    commerce: null,
    reimbursement: {
      airlineClaimStatus: "draft",
      employerExpenseStatus: "draft",
      blockers: [],
      evidence: [],
      expenses: [],
      submissionTarget: resolveAirlineSubmissionTarget(input.airline),
      claimPacket: null as unknown as ReimbursementClaimPacket,
      authorization: null,
      submission: null,
      handoff: null,
      automationBoundary: AUTOMATION_BOUNDARY,
    },
    createdAt: now,
    updatedAt: now,
  };
  refreshReimbursement(record);
  return record;
}

function normalizeRecord(value: RecoveryCaseRecord): RecoveryCaseRecord {
  const record = structuredClone(value);
  record.incident.passengerName ??= null;
  record.incident.flightNumber ??= null;
  record.incident.incidentDate ??= null;
  record.incident.noticeAttachmentIds ??= [];
  record.commerce ??= null;
  record.reimbursement.evidence ??= [];
  record.reimbursement.expenses ??= record.recovery.products.map(
    (product, index) => ({
      expenseId: `EXP-${record.payment.checkoutId ?? record.caseId}-${index + 1}`,
      description: product.description,
      amount: validAmount(product.unitPrice),
      currency: record.recovery.currency ?? "USD",
      quantity: product.quantity,
      merchantName: null,
      purchasedAt: null,
      receiptEvidenceId: null,
      status:
        record.status === "merchant_order_confirmed"
          ? ("incurred" as const)
          : ("proposed" as const),
    }),
  );
  record.reimbursement.submissionTarget ??= resolveAirlineSubmissionTarget(
    record.incident.airline,
  );
  record.reimbursement.authorization ??= null;
  record.reimbursement.submission ??= null;
  record.reimbursement.handoff ??= null;
  record.reimbursement.automationBoundary ??= AUTOMATION_BOUNDARY;
  record.reimbursement.claimPacket ??=
    null as unknown as ReimbursementClaimPacket;
  refreshReimbursement(record);
  return record;
}

export class JsonlRecoveryCaseLedger implements RecoveryCaseLedger {
  private readonly loaded: Promise<Map<string, RecoveryCaseRecord>>;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {
    this.loaded = this.load();
  }

  async savePrepared(input: {
    caseId: string;
    chatId: string;
    employeeId: string;
    employeePhone: string;
    recovery: RecoveryCheckoutContext;
    products: PravaProduct[];
    totalAmount: string;
    currency: string;
    checkoutId: string;
    incidentEvidence?: {
      passengerName?: string | null;
      flightNumber?: string | null;
      incidentDate?: string | null;
    };
  }): Promise<RecoveryCaseRecord> {
    const records = await this.loaded;
    const existing = records.get(input.caseId);
    const record = existing ? structuredClone(existing) :
      baseRecord({
        caseId: input.caseId,
        chatId: input.chatId,
        employeeId: input.employeeId,
        employeePhone: input.employeePhone,
        airline: input.recovery.airline,
        arrivalAirport: input.recovery.arrivalAirport,
        baggageReference: input.recovery.baggageReference,
        noticeAttachmentIds: input.recovery.noticeAttachmentIds,
        passengerName: input.incidentEvidence?.passengerName,
        flightNumber: input.incidentEvidence?.flightNumber,
        incidentDate: input.incidentEvidence?.incidentDate,
      });
    record.incident = {
      airline: input.recovery.airline,
      arrivalAirport: input.recovery.arrivalAirport,
      baggageReference: input.recovery.baggageReference,
      passengerName:
        input.incidentEvidence?.passengerName ?? record.incident.passengerName,
      flightNumber:
        input.incidentEvidence?.flightNumber ?? record.incident.flightNumber,
      incidentDate:
        input.incidentEvidence?.incidentDate ?? record.incident.incidentDate,
      noticeAttachmentIds: [...input.recovery.noticeAttachmentIds],
    };
    record.status = "payment_approval_pending";
    record.recovery = {
      needBy: input.recovery.needBy,
      deliveryArea: input.recovery.deliveryArea,
      deliveryAddress: input.recovery.deliveryAddress,
      deliveryAddressSource: input.recovery.deliveryAddressSource,
      products: input.products.map((product) => ({ ...product })),
      totalAmount: input.totalAmount,
      currency: input.currency,
    };
    record.payment = {
      checkoutId: input.checkoutId,
      pravaReference: null,
      status: "pending",
    };
    record.updatedAt = new Date().toISOString();
    record.reimbursement.expenses = input.products.map((product, index) => ({
      expenseId: `EXP-${input.checkoutId}-${index + 1}`,
      description: product.description,
      amount: validAmount(product.unitPrice),
      currency: input.currency,
      quantity: product.quantity,
      merchantName: null,
      purchasedAt: null,
      receiptEvidenceId: null,
      status: "proposed",
    }));
    refreshReimbursement(record);
    await this.persist(record);
    return structuredClone(record);
  }

  async saveLiveCommercePrepared(
    input: SaveLiveCommercePreparedInput,
  ): Promise<RecoveryCaseRecord> {
    const commerce = liveCommerceRecord(input);
    const records = await this.loaded;
    const existing = records.get(input.request.caseId);
    if (
      existing &&
      (existing.chatId !== input.request.chatId ||
        existing.employeeId !== input.request.employeeId ||
        existing.employeePhone !== input.request.employeePhone)
    ) {
      throw new Error(
        "Live commerce preparation does not match the recovery case identity",
      );
    }
    if (
      existing?.commerce &&
      existing.commerce.checkoutId !== input.checkoutId &&
      (existing.commerce.status === "approval_pending" ||
        existing.commerce.status === "order_confirmed" ||
        existing.commerce.status === "reconciliation_required")
    ) {
      throw new Error(
        "A different live commerce attempt has already reached payment or checkout",
      );
    }
    if (
      existing?.commerce?.checkoutId === input.checkoutId &&
      (existing.commerce.status === "order_confirmed" ||
        existing.commerce.status === "reconciliation_required" ||
        existing.commerce.status === "failed" ||
        existing.commerce.status === "canceled")
    ) {
      throw new Error("A terminal live commerce attempt cannot be overwritten");
    }
    const incident = input.request.incident;
    const record = existing
      ? structuredClone(existing)
      : baseRecord({
          caseId: input.request.caseId,
          chatId: input.request.chatId,
          employeeId: input.request.employeeId,
          employeePhone: input.request.employeePhone,
          airline: incident.airline ?? "",
          arrivalAirport: incident.arrivalAirport ?? "",
          baggageReference: incident.baggageReference,
          noticeAttachmentIds: incident.noticeAttachmentIds,
          passengerName: incident.passengerName,
          flightNumber: incident.flightNumber,
          incidentDate: incident.incidentDate,
        });
    record.incident = {
      airline: incident.airline ?? record.incident.airline,
      arrivalAirport:
        incident.arrivalAirport ?? record.incident.arrivalAirport,
      baggageReference:
        incident.baggageReference ?? record.incident.baggageReference,
      passengerName: incident.passengerName ?? record.incident.passengerName,
      flightNumber: incident.flightNumber ?? record.incident.flightNumber,
      incidentDate: incident.incidentDate ?? record.incident.incidentDate,
      noticeAttachmentIds: [
        ...new Set([
          ...record.incident.noticeAttachmentIds,
          ...incident.noticeAttachmentIds,
        ]),
      ],
    };
    record.commerce = commerce;
    record.status =
      commerce.status === "approval_pending"
        ? "payment_approval_pending"
        : "claim_draft";
    const amount = commerce.quote?.total ?? commerce.product.unitPrice;
    record.recovery = {
      needBy: input.request.needBy,
      deliveryArea: input.request.deliveryArea,
      deliveryAddress: commerce.address.maskedSummary,
      deliveryAddressSource: "prava_address",
      products: [
        {
          description: commerce.product.title,
          unitPrice: commerce.product.unitPrice.amount,
          quantity: commerce.quote?.quantity ?? 1,
        },
      ],
      totalAmount: amount.amount,
      currency: amount.currency,
    };
    record.payment = {
      checkoutId: input.checkoutId,
      pravaReference: commerce.paymentSessionId,
      status: commerce.status === "approval_pending" ? "pending" : "not_started",
    };
    record.fulfillment = {
      status: "not_started",
      merchantOrderId: null,
      disclosure:
        "A live Prava UCP offer or quote is recorded, but no merchant order has been placed.",
    };
    record.reimbursement.expenses = [
      {
        expenseId: `EXP-${input.checkoutId}-1`,
        description: commerce.product.title,
        amount: amount.amount,
        currency: amount.currency,
        quantity: commerce.quote?.quantity ?? 1,
        merchantName: commerce.merchant.name,
        purchasedAt: null,
        receiptEvidenceId: null,
        status: "proposed",
      },
    ];
    record.updatedAt = new Date().toISOString();
    refreshReimbursement(record);
    await this.persist(record);
    return structuredClone(record);
  }

  async saveClaimDraft(input: {
    caseId: string;
    chatId: string;
    employeeId: string;
    employeePhone: string;
    airline: string;
    arrivalAirport: string;
    baggageReference: string | null;
    noticeAttachmentIds: string[];
    passengerName?: string | null;
    flightNumber?: string | null;
    incidentDate?: string | null;
  }): Promise<RecoveryCaseRecord> {
    const records = await this.loaded;
    const existing = records.get(input.caseId);
    const record = existing ? structuredClone(existing) : baseRecord(input);
    record.incident = {
      airline: input.airline,
      arrivalAirport: input.arrivalAirport,
      baggageReference: input.baggageReference,
      passengerName: input.passengerName ?? record.incident.passengerName,
      flightNumber: input.flightNumber ?? record.incident.flightNumber,
      incidentDate: input.incidentDate ?? record.incident.incidentDate,
      noticeAttachmentIds: [...input.noticeAttachmentIds],
    };
    record.updatedAt = new Date().toISOString();
    refreshReimbursement(record);
    await this.persist(record);
    return structuredClone(record);
  }

  async addClaimEvidence(input: {
    caseId: string;
    evidenceId?: string;
    kind: ClaimEvidenceKind;
    source: ClaimEvidenceRecord["source"];
    description: string;
    capturedAt?: string;
    verification?: ClaimEvidenceRecord["verification"];
    attachmentId?: string | null;
    sha256?: string | null;
    sourceUrl?: string | null;
  }): Promise<RecoveryCaseRecord> {
    const existing = (await this.loaded).get(input.caseId);
    if (!existing) throw new Error("Recovery case not found");
    const record = structuredClone(existing);
    const description = input.description.replace(/\s+/g, " ").trim();
    if (!description || description.length > 240) {
      throw new Error("Claim evidence requires a concise description");
    }
    const capturedAt = input.capturedAt ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(capturedAt))) {
      throw new Error("Claim evidence capturedAt must be an ISO timestamp");
    }
    const sha256 = input.sha256?.trim().toLowerCase() ?? null;
    if (sha256 && !/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error("Claim evidence sha256 must be a 64-character hex digest");
    }
    const sourceUrl = input.sourceUrl?.trim() ?? null;
    if (sourceUrl && new URL(sourceUrl).protocol !== "https:") {
      throw new Error("Claim evidence source URL must use HTTPS");
    }
    const evidenceId =
      input.evidenceId?.trim() ?? `EVD-${randomUUID().slice(0, 12).toUpperCase()}`;
    if (!/^[A-Za-z0-9_-]{4,80}$/.test(evidenceId)) {
      throw new Error("Claim evidence ID contains unsupported characters");
    }
    upsertEvidence(record, {
      evidenceId,
      kind: input.kind,
      source: input.source,
      description,
      capturedAt,
      verification: input.verification ?? "unverified",
      attachmentId: input.attachmentId?.trim() || null,
      sha256,
      sourceUrl,
    });
    if (
      input.kind === "baggage_delay_notice" &&
      input.attachmentId &&
      !record.incident.noticeAttachmentIds.includes(input.attachmentId)
    ) {
      record.incident.noticeAttachmentIds.push(input.attachmentId);
    }
    record.updatedAt = new Date().toISOString();
    refreshReimbursement(record);
    await this.persist(record);
    return structuredClone(record);
  }

  async addClaimExpense(input: {
    caseId: string;
    expenseId?: string;
    description: string;
    amount: string;
    currency: string;
    quantity?: number;
    merchantName?: string | null;
    purchasedAt?: string | null;
    receiptEvidenceId?: string | null;
    status?: ClaimExpenseRecord["status"];
  }): Promise<RecoveryCaseRecord> {
    const existing = (await this.loaded).get(input.caseId);
    if (!existing) throw new Error("Recovery case not found");
    const record = structuredClone(existing);
    const description = input.description.replace(/\s+/g, " ").trim();
    if (!description || description.length > 240) {
      throw new Error("Claim expense requires a concise description");
    }
    const currency = input.currency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new Error("Claim expense currency must be an ISO 4217 code");
    }
    const quantity = input.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new Error("Claim expense quantity must be a positive integer");
    }
    const purchasedAt = input.purchasedAt?.trim() || null;
    if (purchasedAt && !Number.isFinite(Date.parse(purchasedAt))) {
      throw new Error("Claim expense purchasedAt must be an ISO timestamp");
    }
    const receiptEvidenceId = input.receiptEvidenceId?.trim() || null;
    if (receiptEvidenceId) {
      const receipt = record.reimbursement.evidence.find(
        (evidence) => evidence.evidenceId === receiptEvidenceId,
      );
      if (!receipt || receipt.kind !== "itemized_receipt") {
        throw new Error("Claim expense receipt must reference itemized receipt evidence");
      }
      if (receipt.verification !== "verified") {
        throw new Error("Claim expense receipt evidence must be verified");
      }
    }
    const expenseId =
      input.expenseId?.trim() ?? `EXP-${randomUUID().slice(0, 12).toUpperCase()}`;
    if (!/^[A-Za-z0-9_-]{4,100}$/.test(expenseId)) {
      throw new Error("Claim expense ID contains unsupported characters");
    }
    const expense: ClaimExpenseRecord = {
      expenseId,
      description,
      amount: validAmount(input.amount),
      currency,
      quantity,
      merchantName: input.merchantName?.replace(/\s+/g, " ").trim() || null,
      purchasedAt,
      receiptEvidenceId,
      status: input.status ?? "incurred",
    };
    const index = record.reimbursement.expenses.findIndex(
      (candidate) => candidate.expenseId === expenseId,
    );
    if (index >= 0) record.reimbursement.expenses[index] = expense;
    else record.reimbursement.expenses.push(expense);
    record.updatedAt = new Date().toISOString();
    refreshReimbursement(record);
    await this.persist(record);
    return structuredClone(record);
  }

  async authorizeAirlineClaim(input: {
    caseId: string;
    authorizationEventId: string;
  }): Promise<RecoveryCaseRecord> {
    const existing = (await this.loaded).get(input.caseId);
    if (!existing) throw new Error("Recovery case not found");
    const record = structuredClone(existing);
    if (record.reimbursement.submission) return record;
    const authorizationEventId = input.authorizationEventId.trim();
    if (!authorizationEventId) {
      throw new Error("Claim authorization requires an event ID");
    }
    record.updatedAt = new Date().toISOString();
    refreshReimbursement(record);
    if (record.reimbursement.blockers.length > 0) {
      throw new Error(
        `Claim packet is not ready: ${record.reimbursement.blockers.join(", ")}`,
      );
    }
    if (record.reimbursement.submissionTarget.resolution !== "official_handoff") {
      throw new Error("Claim packet has no reviewed official airline handoff");
    }
    if (
      record.reimbursement.authorization?.authorizationEventId ===
        authorizationEventId &&
      record.reimbursement.authorization.packetHash ===
        record.reimbursement.claimPacket.packetHash
    ) {
      return record;
    }
    record.reimbursement.authorization = {
      authorizedAt: record.updatedAt,
      authorizedBy: "employee",
      authorizationEventId,
      packetHash: record.reimbursement.claimPacket.packetHash,
      scope: "manual_airline_claim_handoff",
    };
    record.reimbursement.airlineClaimStatus = "authorized_for_handoff";
    await this.persist(record);
    return structuredClone(record);
  }

  async recordExternalClaimSubmission(input: {
    caseId: string;
    submittedBy: ClaimSubmissionRecord["submittedBy"];
    externalClaimId: string;
    submittedAt?: string;
    confirmationEvidence: {
      evidenceId?: string;
      description: string;
      attachmentId?: string | null;
      sha256?: string | null;
      sourceUrl?: string | null;
    };
  }): Promise<RecoveryCaseRecord> {
    const existing = (await this.loaded).get(input.caseId);
    if (!existing) throw new Error("Recovery case not found");
    const record = structuredClone(existing);
    const authorization = record.reimbursement.authorization;
    if (!authorization) {
      throw new Error("Airline claim handoff has not been authorized");
    }
    if (authorization.scope === "sandbox_airline_connector") {
      throw new Error(
        "Sandbox airline submissions must be recorded from the sandbox provider confirmation",
      );
    }
    if (
      authorization.packetHash !== record.reimbursement.claimPacket.packetHash
    ) {
      throw new Error("Claim packet changed after authorization");
    }
    const externalClaimId = input.externalClaimId.replace(/\s+/g, " ").trim();
    if (!externalClaimId || externalClaimId.length > 120) {
      throw new Error("External claim submission requires a confirmation ID");
    }
    const submittedAt = input.submittedAt ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(submittedAt))) {
      throw new Error("Claim submittedAt must be an ISO timestamp");
    }
    const confirmation = input.confirmationEvidence;
    if (!confirmation.attachmentId && !confirmation.sha256 && !confirmation.sourceUrl) {
      throw new Error(
        "External claim submission requires independent confirmation evidence",
      );
    }
    const confirmationId =
      confirmation.evidenceId?.trim() ??
      `EVD-${randomUUID().slice(0, 12).toUpperCase()}`;
    if (!/^[A-Za-z0-9_-]{4,80}$/.test(confirmationId)) {
      throw new Error("Submission confirmation evidence ID contains unsupported characters");
    }
    const description = confirmation.description.replace(/\s+/g, " ").trim();
    if (!description || description.length > 240) {
      throw new Error("Submission confirmation requires a concise description");
    }
    const sourceUrl = confirmation.sourceUrl?.trim() || null;
    if (sourceUrl && new URL(sourceUrl).protocol !== "https:") {
      throw new Error("Submission confirmation URL must use HTTPS");
    }
    const sha256 = confirmation.sha256?.trim().toLowerCase() || null;
    if (sha256 && !/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error("Submission confirmation sha256 must be a hex digest");
    }
    upsertEvidence(record, {
      evidenceId: confirmationId,
      kind: "submission_confirmation",
      source: "external_confirmation",
      description,
      capturedAt: submittedAt,
      verification: "verified",
      attachmentId: confirmation.attachmentId?.trim() || null,
      sha256,
      sourceUrl,
      environment: "production",
    });
    record.reimbursement.submission = {
      submittedAt,
      submittedBy: input.submittedBy,
      externalClaimId,
      confirmationEvidenceId: confirmationId,
      packetHash: authorization.packetHash,
      environment: "production",
      expectedReviewBusinessDays: null,
      companyNotificationId: null,
      companyNotifiedAt: null,
    };
    record.updatedAt = new Date().toISOString();
    refreshReimbursement(record);
    await this.persist(record);
    return structuredClone(record);
  }

  async recordReimbursementPacketUploaded(input: {
    caseId: string;
    environment: "sandbox" | "production";
    packetHash: string;
    attachmentId: string;
    filename: string;
    sha256: string;
    uploadedAt?: string;
  }): Promise<RecoveryCaseRecord> {
    const existing = (await this.loaded).get(input.caseId);
    if (!existing) throw new Error("Recovery case not found");
    const record = structuredClone(existing);
    const packetHash = validSha256(input.packetHash, "Claim packet hash");
    if (packetHash !== record.reimbursement.claimPacket.packetHash) {
      throw new Error("Uploaded reimbursement packet does not match the current claim packet");
    }
    const attachmentId = handoffIdentifier(
      input.attachmentId,
      "Reimbursement packet attachment ID",
    );
    const filename = reimbursementPacketFilename(input.filename);
    const packetSha256 = validSha256(
      input.sha256,
      "Reimbursement packet SHA-256",
    );
    const uploadedAt = validIsoTimestamp(
      input.uploadedAt ?? new Date().toISOString(),
      "Reimbursement packet uploadedAt",
    );
    const current = record.reimbursement.handoff;
    if (current) {
      if (
        current.packetHash === packetHash &&
        current.environment === input.environment &&
        current.packetAttachmentId === attachmentId &&
        current.packetFilename === filename &&
        current.packetSha256 === packetSha256
      ) {
        return structuredClone(record);
      }
      throw new Error("A different reimbursement packet handoff is already active");
    }
    record.reimbursement.handoff = {
      environment: input.environment,
      state: "packet_uploaded",
      packetHash,
      packetAttachmentId: attachmentId,
      packetFilename: filename,
      packetSha256,
      uploadedAt,
      confirmationRequestedAt: null,
      authorizationEventId: null,
      submissionIdempotencyKey: null,
      submissionStartedAt: null,
      expectedReviewBusinessDays: null,
      companyNotificationId: null,
      companyNotifiedAt: null,
    };
    record.updatedAt = new Date().toISOString();
    await this.persist(record);
    return structuredClone(record);
  }

  async markReimbursementAwaitingConfirmation(input: {
    caseId: string;
    packetHash: string;
    requestedAt?: string;
  }): Promise<RecoveryCaseRecord> {
    const existing = (await this.loaded).get(input.caseId);
    if (!existing) throw new Error("Recovery case not found");
    const record = structuredClone(existing);
    const packetHash = validSha256(input.packetHash, "Claim packet hash");
    const handoff = record.reimbursement.handoff;
    if (!handoff || handoff.packetHash !== packetHash) {
      throw new Error("Reimbursement packet has not been uploaded for this claim");
    }
    if (handoff.state !== "packet_uploaded") {
      return structuredClone(record);
    }
    handoff.state = "awaiting_confirmation";
    handoff.confirmationRequestedAt = validIsoTimestamp(
      input.requestedAt ?? new Date().toISOString(),
      "Reimbursement confirmation requestedAt",
    );
    record.updatedAt = new Date().toISOString();
    await this.persist(record);
    return structuredClone(record);
  }

  async beginSandboxClaimSubmission(input: {
    caseId: string;
    authorizationEventId: string;
    startedAt?: string;
  }): Promise<RecoveryCaseRecord> {
    const existing = (await this.loaded).get(input.caseId);
    if (!existing) throw new Error("Recovery case not found");
    const record = structuredClone(existing);
    const handoff = record.reimbursement.handoff;
    if (!handoff || handoff.environment !== "sandbox") {
      throw new Error("Sandbox claim submission requires a sandbox reimbursement packet");
    }
    if (handoff.state === "submitted" || handoff.state === "submission_pending") {
      return structuredClone(record);
    }
    if (handoff.state !== "awaiting_confirmation") {
      throw new Error("Sandbox claim submission is not awaiting employee confirmation");
    }
    const submissionBlockers = sandboxSubmissionBlockers(record);
    if (submissionBlockers.length > 0) {
      throw new Error(
        `Claim packet is not ready: ${submissionBlockers.join(", ")}`,
      );
    }
    if (record.reimbursement.submissionTarget.resolution !== "official_handoff") {
      throw new Error("Claim packet has no reviewed official airline handoff");
    }
    const authorizationEventId = handoffIdentifier(
      input.authorizationEventId,
      "Sandbox claim authorization event ID",
    );
    const startedAt = validIsoTimestamp(
      input.startedAt ?? new Date().toISOString(),
      "Sandbox claim submission startedAt",
    );
    const idempotencyKey = `sandbox-claim-${createHash("sha256")
      .update(`${record.caseId}\u0000${handoff.packetHash}`)
      .digest("hex")
      .slice(0, 32)}`;
    record.reimbursement.authorization = {
      authorizedAt: startedAt,
      authorizedBy: "employee",
      authorizationEventId,
      packetHash: handoff.packetHash,
      scope: "sandbox_airline_connector",
    };
    handoff.state = "submission_pending";
    handoff.authorizationEventId = authorizationEventId;
    handoff.submissionIdempotencyKey = idempotencyKey;
    handoff.submissionStartedAt = startedAt;
    record.reimbursement.airlineClaimStatus = "authorized_for_handoff";
    record.updatedAt = new Date().toISOString();
    await this.persist(record);
    return structuredClone(record);
  }

  async recordSandboxClaimSubmission(input: {
    caseId: string;
    idempotencyKey: string;
    externalClaimId: string;
    providerConfirmationSha256: string;
    submittedAt?: string;
    expectedReviewBusinessDays: { min: 3; max: 5 };
    companyNotificationId: string;
    companyNotifiedAt?: string;
  }): Promise<RecoveryCaseRecord> {
    const existing = (await this.loaded).get(input.caseId);
    if (!existing) throw new Error("Recovery case not found");
    const record = structuredClone(existing);
    const handoff = record.reimbursement.handoff;
    const idempotencyKey = handoffIdentifier(
      input.idempotencyKey,
      "Sandbox claim idempotency key",
    );
    const externalClaimId = handoffIdentifier(
      input.externalClaimId,
      "Sandbox airline confirmation ID",
      120,
    );
    if (record.reimbursement.submission) {
      if (
        record.reimbursement.submission.environment === "sandbox" &&
        record.reimbursement.submission.externalClaimId === externalClaimId &&
        handoff?.submissionIdempotencyKey === idempotencyKey
      ) {
        return structuredClone(record);
      }
      throw new Error("A different airline claim submission is already recorded");
    }
    const activeHandoff = record.reimbursement.handoff;
    if (
      !activeHandoff ||
      activeHandoff.environment !== "sandbox" ||
      activeHandoff.state !== "submission_pending" ||
      activeHandoff.submissionIdempotencyKey !== idempotencyKey
    ) {
      throw new Error("Sandbox provider confirmation does not match the pending submission");
    }
    const authorization = record.reimbursement.authorization;
    if (
      !authorization ||
      authorization.scope !== "sandbox_airline_connector" ||
      authorization.packetHash !== activeHandoff.packetHash
    ) {
      throw new Error("Sandbox provider confirmation lacks matching employee authorization");
    }
    if (
      input.expectedReviewBusinessDays.min !== 3 ||
      input.expectedReviewBusinessDays.max !== 5
    ) {
      throw new Error("Sandbox airline review window must be 3-5 business days");
    }
    const submittedAt = validIsoTimestamp(
      input.submittedAt ?? new Date().toISOString(),
      "Sandbox claim submittedAt",
    );
    const companyNotifiedAt = validIsoTimestamp(
      input.companyNotifiedAt ?? submittedAt,
      "Sandbox company notification timestamp",
    );
    const companyNotificationId = handoffIdentifier(
      input.companyNotificationId,
      "Sandbox company notification ID",
    );
    const confirmationSha256 = validSha256(
      input.providerConfirmationSha256,
      "Sandbox provider confirmation SHA-256",
    );
    const confirmationEvidenceId = stableEvidenceId([
      record.caseId,
      "submission_confirmation",
      externalClaimId,
    ]);
    upsertEvidence(record, {
      evidenceId: confirmationEvidenceId,
      kind: "submission_confirmation",
      source: "external_confirmation",
      description: "Airline claim confirmation returned by the configured sandbox provider",
      capturedAt: submittedAt,
      verification: "verified",
      attachmentId: null,
      sha256: confirmationSha256,
      sourceUrl: null,
      environment: "sandbox",
    });
    record.reimbursement.submission = {
      submittedAt,
      submittedBy: "external_connector",
      externalClaimId,
      confirmationEvidenceId,
      packetHash: authorization.packetHash,
      environment: "sandbox",
      expectedReviewBusinessDays: { min: 3, max: 5 },
      companyNotificationId,
      companyNotifiedAt,
    };
    activeHandoff.state = "submitted";
    activeHandoff.expectedReviewBusinessDays = { min: 3, max: 5 };
    activeHandoff.companyNotificationId = companyNotificationId;
    activeHandoff.companyNotifiedAt = companyNotifiedAt;
    record.updatedAt = new Date().toISOString();
    refreshReimbursement(record);
    await this.persist(record);
    return structuredClone(record);
  }

  async recordPayment(event: PravaStatusEvent): Promise<RecoveryCaseRecord | null> {
    const caseId = event.recovery?.caseId;
    if (!caseId) return null;
    const records = await this.loaded;
    const existing = records.get(caseId);
    let record = existing ? structuredClone(existing) : undefined;
    if (
      record &&
      (record.chatId !== event.chatId ||
        record.employeeId !== event.employeeId ||
        (record.payment.checkoutId && record.payment.checkoutId !== event.checkoutId))
    ) {
      throw new Error("Prava status event does not match the prepared recovery case");
    }
    if (
      record &&
      record.payment.checkoutId === event.checkoutId &&
      (record.status === "merchant_order_confirmed" ||
        record.status === "sandbox_authorization_complete")
    ) {
      return structuredClone(record);
    }
    if (!record) {
      const recovery = event.recovery as RecoveryCheckoutContext;
      record = baseRecord({
        caseId,
        chatId: event.chatId,
        employeeId: event.employeeId,
        employeePhone: event.employeePhone,
        airline: recovery.airline,
        arrivalAirport: recovery.arrivalAirport,
        baggageReference: recovery.baggageReference,
        noticeAttachmentIds: recovery.noticeAttachmentIds,
      });
      record.recovery = {
        needBy: recovery.needBy,
        deliveryArea: recovery.deliveryArea,
        deliveryAddress: recovery.deliveryAddress,
        deliveryAddressSource: recovery.deliveryAddressSource,
        products: event.products.map((product) => ({ ...product })),
        totalAmount: event.totalAmount,
        currency: event.currency,
      };
      record.reimbursement.expenses = event.products.map((product, index) => ({
        expenseId: `EXP-${event.checkoutId}-${index + 1}`,
        description: product.description,
        amount: validAmount(product.unitPrice),
        currency: event.currency,
        quantity: product.quantity,
        merchantName: null,
        purchasedAt: null,
        receiptEvidenceId: null,
        status: "proposed",
      }));
    }
    record.status = event.status === "completed"
      ? event.merchantOutcome === "live"
        ? "merchant_order_confirmed"
        : "sandbox_authorization_complete"
      : event.status === "reconciliation_required"
        ? "payment_reconciliation_required"
        : "payment_failed";
    record.payment = {
      checkoutId: event.checkoutId,
      pravaReference: event.pravaOrderId,
      status: event.status === "completed"
        ? "approved"
        : event.status === "reconciliation_required"
          ? "reconciliation_required"
          : "failed",
    };
    if (event.status === "completed" && event.merchantOutcome === "simulated") {
      const recordedAt = new Date().toISOString();
      const receiptEvidenceId = stableEvidenceId([
        record.caseId,
        "itemized_receipt",
        event.checkoutId,
        "sandbox",
      ]);
      const receiptSha256 = createHash("sha256")
        .update(
          JSON.stringify({
            checkoutId: event.checkoutId,
            pravaOrderId: event.pravaOrderId,
            totalAmount: event.totalAmount,
            currency: event.currency,
            products: event.products.map((product) => ({
              productRef: product.productRef ?? null,
              description: product.description,
              unitPrice: product.unitPrice,
              quantity: product.quantity,
            })),
          }),
        )
        .digest("hex");
      upsertEvidence(record, {
        evidenceId: receiptEvidenceId,
        kind: "itemized_receipt",
        source: "prava",
        description: "Itemized checkout receipt from the configured recovery provider",
        capturedAt: recordedAt,
        verification: "verified",
        attachmentId: null,
        sha256: receiptSha256,
        sourceUrl: null,
        environment: "sandbox",
      });
      record.reimbursement.expenses = record.reimbursement.expenses.map(
        (expense) => ({
          ...expense,
          status: "incurred" as const,
          purchasedAt: expense.purchasedAt ?? recordedAt,
          receiptEvidenceId,
        }),
      );
      record.fulfillment = {
        status: "not_started",
        merchantOrderId: null,
        disclosure: "Secure approval completed and the recovery case was updated.",
      };
    }
    if (
      event.status === "completed" &&
      event.merchantOutcome === "live" &&
      event.merchantOrderId
    ) {
      record.fulfillment = {
        status: "merchant_order_confirmed",
        merchantOrderId: event.merchantOrderId,
        disclosure:
          "The configured live merchant adapter confirmed this order. Dispatch and delivery require separate merchant evidence.",
      };
      record.reimbursement.expenses = record.reimbursement.expenses.map(
        (expense) => ({
          ...expense,
          status: "incurred" as const,
          purchasedAt: expense.purchasedAt ?? new Date().toISOString(),
        }),
      );
      upsertEvidence(record, {
        evidenceId: stableEvidenceId([
          record.caseId,
          "merchant_order",
          event.merchantOrderId,
        ]),
        kind: "merchant_order",
        source: "merchant",
        description: "Merchant order acceptance recorded for the recovery case",
        capturedAt: new Date().toISOString(),
        verification: "verified",
        attachmentId: null,
        sha256: null,
        sourceUrl: null,
      });
    }
    if (event.status === "completed") {
      upsertEvidence(record, {
        evidenceId: stableEvidenceId([
          record.caseId,
          "payment_authorization",
          event.checkoutId,
        ]),
        kind: "payment_authorization",
        source: "prava",
        description:
          event.merchantOutcome === "live"
            ? "Prava payment authorization associated with the merchant order"
            : "Prava payment authorization associated with the recovery case",
        capturedAt: new Date().toISOString(),
        verification: "verified",
        attachmentId: null,
        sha256: null,
        sourceUrl: null,
      });
    }
    record.updatedAt = new Date().toISOString();
    refreshReimbursement(record);
    await this.persist(record);
    return structuredClone(record);
  }

  async recordLiveCommerce(
    event: LiveCommerceStatusEvent,
  ): Promise<RecoveryCaseRecord> {
    const existing = (await this.loaded).get(event.caseId);
    if (!existing?.commerce) {
      throw new Error(
        "Live commerce status requires a previously prepared recovery case",
      );
    }
    const record = structuredClone(existing);
    const commerce = record.commerce;
    if (!commerce) {
      throw new Error(
        "Live commerce status requires persisted live commerce metadata",
      );
    }
    if (
      record.chatId !== event.chatId ||
      record.employeeId !== event.employeeId ||
      record.employeePhone !== event.employeePhone ||
      commerce.checkoutId !== event.checkoutId
    ) {
      throw new Error(
        "Live commerce status does not match the prepared recovery case",
      );
    }
    const offer = event.selection.offer;
    if (
      commerce.product.productId !== offer.productId ||
      commerce.product.variantId !== offer.variantId ||
      commerce.merchant.domain !== offer.merchant.domain ||
      commerce.address.addressId !== event.quote.addressId
    ) {
      throw new Error(
        "Live commerce status does not match the prepared product and address",
      );
    }
    const quote = liveQuoteRecord(event.quote);
    if (
      commerce.quote &&
      (commerce.quote.quoteId !== quote.quoteId ||
        commerce.quote.total.currency !== quote.total.currency ||
        commerce.quote.total.amount !== quote.total.amount)
    ) {
      throw new Error("Live commerce status does not match the approved quote");
    }
    if (
      commerce.paymentSessionId &&
      event.paymentSessionId &&
      commerce.paymentSessionId !== event.paymentSessionId
    ) {
      throw new Error(
        "Live commerce status does not match the approved payment session",
      );
    }
    if (
      commerce.status === "order_confirmed" &&
      event.state === "order_confirmed" &&
      commerce.order?.orderId ===
        (event.checkoutResult?.status === "ordered"
          ? event.checkoutResult.orderId
          : null)
    ) {
      return structuredClone(record);
    }

    commerce.quote = quote;
    commerce.paymentSessionId = event.paymentSessionId;
    commerce.status = event.state;
    record.recovery.totalAmount = quote.total.amount;
    record.recovery.currency = quote.total.currency;
    record.payment = {
      checkoutId: event.checkoutId,
      pravaReference: event.paymentSessionId,
      status:
        event.state === "order_confirmed"
          ? "approved"
          : event.state === "reconciliation_required"
            ? "reconciliation_required"
            : event.state === "canceled"
              ? "canceled"
              : "failed",
    };

    if (event.state === "order_confirmed") {
      if (
        !event.paymentSessionId ||
        event.checkoutResult?.status !== "ordered" ||
        event.checkoutResult.amount.currency !== quote.total.currency ||
        normalizeCommerceAmount(event.checkoutResult.amount.amount) !==
          quote.total.amount
      ) {
        throw new Error(
          "Live merchant order confirmation is incomplete or does not match the quote",
        );
      }
      const orderId = conciseCommerceValue(
        event.checkoutResult.orderId,
        "merchant order ID",
        180,
      );
      commerce.order = {
        orderId,
        amount: commerceMoney(event.checkoutResult.amount),
        replayed: event.checkoutResult.replayed,
      };
      record.status = "merchant_order_confirmed";
      record.fulfillment = {
        status: "merchant_order_confirmed",
        merchantOrderId: orderId,
        disclosure:
          "The live merchant accepted the order through Prava Browser Harness. Dispatch and delivery still require separate merchant evidence.",
      };
      const purchasedAt = new Date().toISOString();
      record.reimbursement.expenses = [
        {
          expenseId: `EXP-${event.checkoutId}-1`,
          description: commerce.product.title,
          amount: quote.total.amount,
          currency: quote.total.currency,
          quantity: quote.quantity,
          merchantName: commerce.merchant.name,
          purchasedAt,
          receiptEvidenceId: null,
          status: "incurred",
        },
      ];
      upsertEvidence(record, {
        evidenceId: stableEvidenceId([
          record.caseId,
          "merchant_order",
          orderId,
        ]),
        kind: "merchant_order",
        source: "merchant",
        description: `${commerce.merchant.name} order ${orderId} accepted through Prava Browser Harness`,
        capturedAt: purchasedAt,
        verification: "verified",
        attachmentId: null,
        sha256: null,
        sourceUrl: null,
      });
      upsertEvidence(record, {
        evidenceId: stableEvidenceId([
          record.caseId,
          "payment_authorization",
          event.paymentSessionId,
        ]),
        kind: "payment_authorization",
        source: "prava",
        description:
          "Prava payment authorization bound to the accepted live merchant order",
        capturedAt: purchasedAt,
        verification: "verified",
        attachmentId: null,
        sha256: null,
        sourceUrl: null,
      });
    } else {
      commerce.order = null;
      record.status =
        event.state === "reconciliation_required"
          ? "payment_reconciliation_required"
          : event.state === "canceled"
            ? "payment_canceled"
            : "payment_failed";
      record.fulfillment = {
        status: "not_started",
        merchantOrderId: null,
        disclosure:
          event.state === "reconciliation_required"
            ? "The live merchant outcome is unknown. Tavra will not claim an order or retry checkout until it is reconciled."
            : event.state === "canceled"
              ? "The live approval was canceled before a merchant order was confirmed."
              : "The live payment or merchant checkout failed, and no merchant order was confirmed.",
      };
    }
    record.updatedAt = new Date().toISOString();
    refreshReimbursement(record);
    await this.persist(record);
    return structuredClone(record);
  }

  async get(caseId: string): Promise<RecoveryCaseRecord | null> {
    const record = (await this.loaded).get(caseId);
    return record ? structuredClone(record) : null;
  }

  async getLatestForChat(chatId: string): Promise<RecoveryCaseRecord | null> {
    const candidates = [...(await this.loaded).values()]
      .filter((record) => record.chatId === chatId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return candidates[0] ? structuredClone(candidates[0]) : null;
  }

  private async persist(record: RecoveryCaseRecord): Promise<void> {
    const records = await this.loaded;
    const snapshot = structuredClone(record);
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await appendFile(this.path, `${JSON.stringify(snapshot)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      records.set(snapshot.caseId, structuredClone(snapshot));
    });
    await this.writeQueue;
  }

  private async load(): Promise<Map<string, RecoveryCaseRecord>> {
    const records = new Map<string, RecoveryCaseRecord>();
    try {
      const contents = await readFile(this.path, "utf8");
      for (const line of contents.split("\n").filter(Boolean)) {
        const record = JSON.parse(line) as RecoveryCaseRecord;
        if (record.caseId) records.set(record.caseId, normalizeRecord(record));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return records;
  }
}
