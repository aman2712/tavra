import { readFileSync } from "node:fs";

const E164_PATTERN = /^\+[1-9]\d{7,14}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_QUERY_CHARACTERS = 4_000;
const MAX_CONTEXT_CHARACTERS = 14_000;

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
}): SensoKnowledgeProvider {
  const baseUrl = new URL(options.baseUrl);
  if (baseUrl.protocol !== "https:") {
    throw new Error("SENSO_BASE_URL must use HTTPS");
  }
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;

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
        contentIds = [
          ...profileAndPolicyIds,
          ...identity.allowedDemoContextContentIds,
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
            identity.allowedDemoContextContentIds,
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
  };
}
