import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const E164_PATTERN = /^\+[1-9]\d{7,14}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_QUERY_CHARACTERS = 4_000;
const MAX_CONTEXT_CHARACTERS = 14_000;
const MAX_OUTCOME_FIELD_CHARACTERS = 240;
const MAX_OUTCOME_ITEMS = 20;
const MONEY_PATTERN = /^(?:0|[1-9]\d{0,8})(?:\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

export interface TavraIdentity {
  phoneE164: string;
  companyId: string;
  employeeId: string;
  employeeProfileContentId: string;
  allowedPolicyContentIds: string[];
  allowedDemoContextContentIds: string[];
}

export interface IdentityResolver {
  resolve(phone: string): TavraIdentity | null;
}

export interface SensoKnowledge {
  companyId: string;
  employeeId: string;
  context: string;
  contentIds: string[];
}

export type KnowledgeScope = "profile" | "policy" | "team_recovery";

export interface SensoKnowledgeProvider {
  getKnowledge(
    senderHandle: string,
    message: string,
    scope: KnowledgeScope,
  ): Promise<SensoKnowledge | null>;
}

export type RecoveryOutcomeStatus =
  | "ordered"
  | "reimbursement_prepared"
  | "reimbursement_submitted"
  | "reimbursement_approved"
  | "reimbursed";

export type RecoveryReimbursementStatus =
  | "not_started"
  | "prepared"
  | "submitted"
  | "approved"
  | "paid"
  | "rejected";

export interface SensoRecoveryOutcomeItem {
  description: string;
  quantity: number;
}

/**
 * Deliberately contains no card, payment-token, CVV, or API-credential fields.
 * The writer accepts only the minimum operational facts needed for later recovery.
 */
export interface SensoRecoveryOutcome {
  recoveryCaseId: string;
  recordedAt: string;
  status: RecoveryOutcomeStatus;
  airline?: string;
  arrivalAirport?: string;
  baggageReference?: string;
  merchantName?: string;
  merchantOrderId?: string;
  items?: SensoRecoveryOutcomeItem[];
  total?: string;
  currency?: string;
  reimbursementPacketId?: string;
  reimbursementStatus?: RecoveryReimbursementStatus;
  companyNotified?: boolean;
}

export interface RecordedSensoRecoveryOutcome {
  employeeId: string;
  contentId: string;
}

export interface SensoRecoveryOutcomeWriter {
  recordRecoveryOutcome(
    senderHandle: string,
    outcome: SensoRecoveryOutcome,
  ): Promise<RecordedSensoRecoveryOutcome | null>;
}

export type SensoKnowledgeService = SensoKnowledgeProvider &
  SensoRecoveryOutcomeWriter;

interface SensoSearchResult {
  content_id: string;
  chunk_index?: number;
  chunk_text: string;
  title?: string;
}

interface SensoSearchResponse {
  results: SensoSearchResult[];
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label}.${key} must be a non-empty string`);
  }
  return value.trim();
}

function uuidArray(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new Error(`${label}.${key} must be an array`);
  }
  const ids = value.map((item, index) => {
    if (typeof item !== "string" || !UUID_PATTERN.test(item)) {
      throw new Error(`${label}.${key}[${index}] must be a Senso content UUID`);
    }
    return item;
  });
  return [...new Set(ids)];
}

function normalizePhone(value: string): string | null {
  const normalized = value.trim().replace(/[\s()-]/g, "");
  return E164_PATTERN.test(normalized) ? normalized : null;
}

function singleLineOutcomeField(
  value: string,
  label: string,
  maximumLength = MAX_OUTCOME_FIELD_CHARACTERS,
): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maximumLength || /[\r\n\0]/.test(trimmed)) {
    throw new Error(`${label} must be a non-empty single-line string`);
  }
  return trimmed;
}

function markdownValue(value: string): string {
  return value.replace(/([\\`*_[\]<>])/g, "\\$1");
}

function validateRecoveryOutcome(outcome: SensoRecoveryOutcome): SensoRecoveryOutcome {
  const validStatuses = new Set<RecoveryOutcomeStatus>([
    "ordered",
    "reimbursement_prepared",
    "reimbursement_submitted",
    "reimbursement_approved",
    "reimbursed",
  ]);
  const validReimbursementStatuses = new Set<RecoveryReimbursementStatus>([
    "not_started",
    "prepared",
    "submitted",
    "approved",
    "paid",
    "rejected",
  ]);
  const recordedAt = singleLineOutcomeField(outcome.recordedAt, "recordedAt", 64);
  if (!ISO_TIMESTAMP_PATTERN.test(recordedAt) || !Number.isFinite(Date.parse(recordedAt))) {
    throw new Error("recordedAt must be an ISO-8601 timestamp");
  }
  if (!validStatuses.has(outcome.status)) {
    throw new Error("status is not a supported recovery outcome");
  }
  if (
    outcome.reimbursementStatus !== undefined &&
    !validReimbursementStatuses.has(outcome.reimbursementStatus)
  ) {
    throw new Error("reimbursementStatus is not supported");
  }
  if ((outcome.total === undefined) !== (outcome.currency === undefined)) {
    throw new Error("total and currency must be provided together");
  }
  if (outcome.total !== undefined && !MONEY_PATTERN.test(outcome.total)) {
    throw new Error("total must be a non-negative decimal string with at most two decimals");
  }
  if (outcome.currency !== undefined && !CURRENCY_PATTERN.test(outcome.currency)) {
    throw new Error("currency must be an uppercase three-letter code");
  }
  if (outcome.items !== undefined && !Array.isArray(outcome.items)) {
    throw new Error("items must be an array");
  }
  if (outcome.items && outcome.items.length > MAX_OUTCOME_ITEMS) {
    throw new Error(`items must contain at most ${MAX_OUTCOME_ITEMS} entries`);
  }
  if (
    outcome.companyNotified !== undefined &&
    typeof outcome.companyNotified !== "boolean"
  ) {
    throw new Error("companyNotified must be a boolean");
  }

  const normalized: SensoRecoveryOutcome = {
    recoveryCaseId: singleLineOutcomeField(
      outcome.recoveryCaseId,
      "recoveryCaseId",
      120,
    ),
    recordedAt,
    status: outcome.status,
  };
  const optionalFields = [
    "airline",
    "arrivalAirport",
    "baggageReference",
    "merchantName",
    "merchantOrderId",
    "reimbursementPacketId",
  ] as const;
  for (const field of optionalFields) {
    if (outcome[field] !== undefined) {
      normalized[field] = singleLineOutcomeField(outcome[field], field);
    }
  }
  if (outcome.items !== undefined) {
    normalized.items = outcome.items.map((item, index) => {
      if (!Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 99) {
        throw new Error(`items[${index}].quantity must be an integer from 1 to 99`);
      }
      return {
        description: singleLineOutcomeField(
          item.description,
          `items[${index}].description`,
        ),
        quantity: item.quantity,
      };
    });
  }
  if (outcome.total !== undefined && outcome.currency !== undefined) {
    normalized.total = outcome.total;
    normalized.currency = outcome.currency;
  }
  if (outcome.reimbursementStatus !== undefined) {
    normalized.reimbursementStatus = outcome.reimbursementStatus;
  }
  if (outcome.companyNotified !== undefined) {
    normalized.companyNotified = outcome.companyNotified;
  }
  return normalized;
}

function formatRecoveryOutcomeMarkdown(
  identity: TavraIdentity,
  outcome: SensoRecoveryOutcome,
): string {
  const rows = [
    "# Tavra recovery outcome",
    "",
    `- Company: ${markdownValue(identity.companyId)}`,
    `- Employee: ${markdownValue(identity.employeeId)}`,
    `- Recovery case: ${markdownValue(outcome.recoveryCaseId)}`,
    `- Recorded at: ${markdownValue(outcome.recordedAt)}`,
    `- Outcome: ${markdownValue(outcome.status)}`,
  ];
  const optionalRows: Array<[string, string | undefined]> = [
    ["Airline", outcome.airline],
    ["Arrival airport", outcome.arrivalAirport],
    ["Baggage reference", outcome.baggageReference],
    ["Merchant", outcome.merchantName],
    ["Merchant order", outcome.merchantOrderId],
    ["Reimbursement packet", outcome.reimbursementPacketId],
    ["Reimbursement status", outcome.reimbursementStatus],
  ];
  for (const [label, value] of optionalRows) {
    if (value !== undefined) rows.push(`- ${label}: ${markdownValue(value)}`);
  }
  if (outcome.total !== undefined && outcome.currency !== undefined) {
    rows.push(`- Total: ${markdownValue(outcome.currency)} ${markdownValue(outcome.total)}`);
  }
  if (outcome.companyNotified !== undefined) {
    rows.push(`- Company notified: ${outcome.companyNotified ? "yes" : "no"}`);
  }
  if (outcome.items?.length) {
    rows.push("", "## Items");
    for (const item of outcome.items) {
      rows.push(`- ${item.quantity} x ${markdownValue(item.description)}`);
    }
  }
  return `${rows.join("\n")}\n`;
}

export function createIdentityResolver(value: unknown): IdentityResolver {
  const root = asRecord(value, "identity map");
  if (!Array.isArray(root.identities)) {
    throw new Error("identity map.identities must be an array");
  }

  const identities = new Map<string, TavraIdentity>();
  for (const [index, rawIdentity] of root.identities.entries()) {
    const label = `identity map.identities[${index}]`;
    const record = asRecord(rawIdentity, label);
    const status = requiredString(record, "status", label);
    if (status !== "active") continue;

    const phone = normalizePhone(requiredString(record, "phone_e164", label));
    if (!phone) throw new Error(`${label}.phone_e164 must be an E.164 phone number`);
    if (identities.has(phone)) throw new Error(`Duplicate active identity for ${phone}`);

    const employeeProfileContentId = requiredString(
      record,
      "employee_profile_content_id",
      label,
    );
    if (!UUID_PATTERN.test(employeeProfileContentId)) {
      throw new Error(`${label}.employee_profile_content_id must be a Senso content UUID`);
    }

    identities.set(phone, {
      phoneE164: phone,
      companyId: requiredString(record, "company_id", label),
      employeeId: requiredString(record, "employee_id", label),
      employeeProfileContentId,
      allowedPolicyContentIds: uuidArray(record, "allowed_policy_content_ids", label),
      allowedDemoContextContentIds: uuidArray(
        record,
        "allowed_demo_context_content_ids",
        label,
      ),
    });
  }

  if (identities.size === 0) {
    throw new Error("identity map must contain at least one active identity");
  }

  return {
    resolve(phone) {
      const normalized = normalizePhone(phone);
      return normalized ? identities.get(normalized) ?? null : null;
    },
  };
}

export function loadIdentityResolver(path: string): IdentityResolver {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    throw new Error(`Unable to load private Tavra identity map: ${message}`);
  }
  return createIdentityResolver(parsed);
}

function parseSearchResponse(value: unknown): SensoSearchResponse {
  const root = asRecord(value, "Senso search response");
  if (!Array.isArray(root.results)) {
    throw new Error("Senso search response.results must be an array");
  }
  return {
    results: root.results.map((raw, index) => {
      const record = asRecord(raw, `Senso search response.results[${index}]`);
      return {
        content_id: requiredString(record, "content_id", `Senso result ${index}`),
        chunk_index:
          typeof record.chunk_index === "number" ? record.chunk_index : undefined,
        chunk_text: requiredString(record, "chunk_text", `Senso result ${index}`),
        title: typeof record.title === "string" ? record.title : undefined,
      };
    }),
  };
}

function formatContext(results: SensoSearchResult[]): string {
  const unique = new Map<string, SensoSearchResult>();
  for (const result of results) {
    unique.set(`${result.content_id}:${result.chunk_index ?? "unknown"}`, result);
  }

  const context = [...unique.values()]
    .map((result, index) => {
      const textWithoutInternalReferences = result.chunk_text.replace(
        /`[^`\n]+`/g,
        "[internal reference]",
      );
      return `Company record ${index + 1}:\n${textWithoutInternalReferences}`;
    })
    .join("\n\n");
  return context.slice(0, MAX_CONTEXT_CHARACTERS);
}

export function createSensoKnowledgeProvider(options: {
  apiKey: string;
  baseUrl: string;
  identityResolver: IdentityResolver;
  fetch?: typeof fetch;
  timeoutMs?: number;
  pollIntervalMs?: number;
  findAttempts?: number;
  processingAttempts?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}): SensoKnowledgeService {
  const baseUrl = new URL(options.baseUrl);
  if (baseUrl.protocol !== "https:") {
    throw new Error("SENSO_BASE_URL must use HTTPS");
  }
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const findAttempts = options.findAttempts ?? 30;
  const processingAttempts = options.processingAttempts ?? 90;
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolveWait) => setTimeout(resolveWait, milliseconds)));
  if (pollIntervalMs < 0 || findAttempts < 1 || processingAttempts < 1) {
    throw new Error("Senso polling options must be positive");
  }
  const outcomeContentIdsByEmployee = new Map<string, Set<string>>();

  function employeeAllowlistKey(identity: TavraIdentity): string {
    return `${identity.companyId}\0${identity.employeeId}`;
  }

  function recoveryOutcomeContentIds(identity: TavraIdentity): string[] {
    return [...(outcomeContentIdsByEmployee.get(employeeAllowlistKey(identity)) ?? [])];
  }

  async function searchScoped(
    query: string,
    contentIds: string[],
    maxResults: number,
  ): Promise<SensoSearchResult[]> {
    if (contentIds.length === 0) return [];
    const allowedIds = new Set(contentIds);
    const response = await fetchImpl(new URL("org/search/context", baseUrl), {
      method: "POST",
      headers: {
        "X-API-Key": options.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        max_results: maxResults,
        content_ids: contentIds,
        require_scoped_ids: true,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Senso context search failed with HTTP ${response.status}`);
    }

    const search = parseSearchResponse(await response.json());
    const outOfScope = search.results.find(
      (result) => !allowedIds.has(result.content_id),
    );
    if (outOfScope) {
      throw new Error("Senso returned context outside the employee allowlist");
    }
    return search.results;
  }

  return {
    async getKnowledge(senderHandle, message, scope) {
      const identity = options.identityResolver.resolve(senderHandle);
      if (!identity) return null;

      const profileAndPolicyIds = [
        identity.employeeProfileContentId,
        ...identity.allowedPolicyContentIds,
      ];
      let contentIds: string[];
      let results: SensoSearchResult[];

      if (scope === "profile") {
        contentIds = [identity.employeeProfileContentId];
        results = await searchScoped(
          [
            `Complete employee recovery profile relevant to this request: ${message.slice(0, MAX_QUERY_CHARACTERS)}.`,
            "Include the confirmed work email, T-shirt size, trouser waist, trouser inseam,",
            "and explicitly identify any value that is missing or stale.",
          ].join(" "),
          contentIds,
          10,
        );
      } else if (scope === "policy") {
        contentIds = profileAndPolicyIds;
        results = await searchScoped(
          [
            `Employee-specific policy answer for: ${message.slice(0, MAX_QUERY_CHARACTERS)}.`,
            "Include the profile facts needed to select the applicable allowance,",
            "approval thresholds, permitted categories, and evidence requirements.",
          ].join(" "),
          contentIds,
          20,
        );
      } else {
        const incidentContentIds = [
          ...new Set([
            ...identity.allowedDemoContextContentIds,
            ...recoveryOutcomeContentIds(identity),
          ]),
        ];
        contentIds = [
          ...profileAndPolicyIds,
          ...incidentContentIds,
        ];
        const [profileAndPolicyResults, incidentResults] = await Promise.all([
          searchScoped(
            [
              `Complete recovery profile and applicable policies for employee ${identity.employeeId}.`,
              "Include every known, missing, stale, or conflicting clothing and equipment value,",
              "spending allowance, approval thresholds, permitted categories, and evidence requirements.",
            ].join(" "),
            profileAndPolicyIds,
            20,
          ),
          searchScoped(
            `Incident-specific merchant, product, and prior-outcome evidence for: ${message.slice(0, MAX_QUERY_CHARACTERS)}`,
            incidentContentIds,
            12,
          ),
        ]);
        results = [...profileAndPolicyResults, ...incidentResults];
      }
      if (results.length === 0) {
        throw new Error("Senso returned no scoped context for the employee");
      }

      return {
        companyId: identity.companyId,
        employeeId: identity.employeeId,
        context: formatContext(results),
        contentIds,
      };
    },

    async recordRecoveryOutcome(senderHandle, rawOutcome) {
      const identity = options.identityResolver.resolve(senderHandle);
      if (!identity) return null;

      const outcome = validateRecoveryOutcome(rawOutcome);
      const source = new TextEncoder().encode(
        formatRecoveryOutcomeMarkdown(identity, outcome),
      );
      const filenameFingerprint = createHash("sha256")
        .update(identity.companyId)
        .update("\0")
        .update(identity.employeeId)
        .update("\0")
        .update(outcome.recoveryCaseId)
        .update("\0")
        .update(outcome.recordedAt)
        .digest("hex")
        .slice(0, 20);
      const filename = `tavra-recovery-outcome-${filenameFingerprint}.md`;
      const uploadRequest = await fetchImpl(new URL("org/kb/upload", baseUrl), {
        method: "POST",
        headers: {
          "X-API-Key": options.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          files: [
            {
              filename,
              file_size_bytes: source.byteLength,
              content_type: "text/markdown",
              content_hash_md5: createHash("md5").update(source).digest("hex"),
            },
          ],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!uploadRequest.ok) {
        throw new Error(
          `Senso outcome upload preparation failed with HTTP ${uploadRequest.status}`,
        );
      }
      const uploadRoot = asRecord(
        await uploadRequest.json(),
        "Senso outcome upload response",
      );
      if (!Array.isArray(uploadRoot.results) || uploadRoot.results.length !== 1) {
        throw new Error("Senso outcome upload preparation returned an invalid response");
      }
      const upload = asRecord(
        uploadRoot.results[0],
        "Senso outcome upload response.results[0]",
      );
      const contentId = requiredString(upload, "content_id", "Senso outcome upload");
      if (!UUID_PATTERN.test(contentId)) {
        throw new Error("Senso outcome upload returned an invalid content ID");
      }
      const uploadUrlValue = requiredString(upload, "upload_url", "Senso outcome upload");
      let uploadUrl: URL;
      try {
        uploadUrl = new URL(uploadUrlValue);
      } catch {
        throw new Error("Senso outcome upload returned an invalid upload URL");
      }
      if (uploadUrl.protocol !== "https:") {
        throw new Error("Senso outcome upload URL must use HTTPS");
      }

      const objectUpload = await fetchImpl(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "text/markdown" },
        body: source,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!objectUpload.ok) {
        throw new Error(`Senso outcome source upload failed with HTTP ${objectUpload.status}`);
      }

      let nodeId: string | null = null;
      for (let attempt = 0; attempt < findAttempts && !nodeId; attempt += 1) {
        const found = await fetchImpl(
          new URL(`org/kb/find?q=${encodeURIComponent(filename)}`, baseUrl),
          {
            headers: { "X-API-Key": options.apiKey },
            signal: AbortSignal.timeout(timeoutMs),
          },
        );
        if (found.ok) {
          const foundRoot = asRecord(await found.json(), "Senso outcome find response");
          if (!Array.isArray(foundRoot.nodes)) {
            throw new Error("Senso outcome find response.nodes must be an array");
          }
          for (const [index, rawNode] of foundRoot.nodes.entries()) {
            const node = asRecord(rawNode, `Senso outcome find response.nodes[${index}]`);
            if (node.content_id !== contentId) continue;
            nodeId = requiredString(node, "kb_node_id", "Senso outcome node");
            break;
          }
        } else if (found.status !== 404 && found.status !== 202) {
          throw new Error(`Senso outcome lookup failed with HTTP ${found.status}`);
        }
        if (!nodeId && attempt + 1 < findAttempts) await sleep(pollIntervalMs);
      }
      if (!nodeId) throw new Error("Senso did not expose the recovery outcome in time");

      let completed = false;
      for (let attempt = 0; attempt < processingAttempts; attempt += 1) {
        const statusResponse = await fetchImpl(
          new URL(`org/kb/nodes/${encodeURIComponent(nodeId)}/content`, baseUrl),
          {
            headers: { "X-API-Key": options.apiKey },
            signal: AbortSignal.timeout(timeoutMs),
          },
        );
        if (!statusResponse.ok) {
          throw new Error(
            `Senso outcome processing status failed with HTTP ${statusResponse.status}`,
          );
        }
        const statusRoot = asRecord(
          await statusResponse.json(),
          "Senso outcome processing response",
        );
        const processingStatus =
          typeof statusRoot.processing_status === "string"
            ? statusRoot.processing_status.toLowerCase()
            : "";
        if (processingStatus === "complete" || processingStatus === "completed") {
          completed = true;
          break;
        }
        if (processingStatus === "failed" || processingStatus === "error") {
          throw new Error("Senso failed to process the recovery outcome");
        }
        if (attempt + 1 < processingAttempts) await sleep(pollIntervalMs);
      }
      if (!completed) throw new Error("Senso recovery outcome processing timed out");

      const employeeKey = employeeAllowlistKey(identity);
      const employeeContentIds =
        outcomeContentIdsByEmployee.get(employeeKey) ?? new Set<string>();
      employeeContentIds.add(contentId);
      outcomeContentIdsByEmployee.set(employeeKey, employeeContentIds);
      return { employeeId: identity.employeeId, contentId };
    },
  };
}
