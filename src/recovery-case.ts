import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, appendFile } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  PravaProduct,
  PravaStatusEvent,
  RecoveryCheckoutContext,
} from "./prava.js";

export type RecoveryCaseStatus =
  | "claim_draft"
  | "payment_approval_pending"
  | "sandbox_authorization_complete"
  | "merchant_order_confirmed"
  | "payment_reconciliation_required"
  | "payment_failed";

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
  scope: "manual_airline_claim_handoff";
}

export interface ClaimSubmissionRecord {
  submittedAt: string;
  submittedBy: "employee" | "support" | "external_connector";
  externalClaimId: string;
  confirmationEvidenceId: string;
  packetHash: string;
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
    deliveryAddressSource: "message" | "linq_location" | null;
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
      | "failed";
  };
  fulfillment: {
    status: "not_started" | "merchant_order_confirmed";
    merchantOrderId: string | null;
    disclosure: string;
  };
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
  recordPayment(event: PravaStatusEvent): Promise<RecoveryCaseRecord | null>;
  get(caseId: string): Promise<RecoveryCaseRecord | null>;
  getLatestForChat(chatId: string): Promise<RecoveryCaseRecord | null>;
}

const TARGET_REVIEWED_AT = "2026-08-02";
const AUTOMATION_BOUNDARY =
  "Tavra can prepare and lock the evidence packet, but it has no authenticated airline claim API. Authorization creates a manual handoff only. Submission is recorded only from separate external confirmation evidence.";

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
    });
    record.reimbursement.submission = {
      submittedAt,
      submittedBy: input.submittedBy,
      externalClaimId,
      confirmationEvidenceId: confirmationId,
      packetHash: authorization.packetHash,
    };
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
      record.fulfillment = {
        status: "not_started",
        merchantOrderId: null,
        disclosure:
          "The sandbox merchant simulator approved this test outcome. No live merchant order, charge, dispatch, or delivery was created.",
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
            : "Prava sandbox authorization; this is not evidence of a real charge",
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
