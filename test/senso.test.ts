import assert from "node:assert/strict";
import test from "node:test";

import {
  createIdentityResolver,
  createSensoKnowledgeProvider,
} from "../src/senso.js";

const profileId = "11111111-1111-4111-8111-111111111111";
const policyId = "22222222-2222-4222-8222-222222222222";
const merchantId = "33333333-3333-4333-8333-333333333333";
const outcomeId = "55555555-5555-4555-8555-555555555555";

function resolver() {
  return createIdentityResolver({
    identities: [
      {
        phone_e164: "+919876543210",
        company_id: "northstar_demo",
        employee_id: "emp_demo_001",
        employee_profile_content_id: profileId,
        allowed_policy_content_ids: [policyId],
        allowed_demo_context_content_ids: [merchantId],
        status: "active",
      },
    ],
  });
}

test("resolves formatted phone input to one exact active identity", () => {
  const identity = resolver().resolve("+91 98765 43210");
  assert.equal(identity?.employeeId, "emp_demo_001");
  assert.equal(resolver().resolve("+919000000000"), null);
});

test("queries Senso with strict content IDs and formats returned chunks", async () => {
  let requestUrl = "";
  const requestBodies: Array<Record<string, unknown>> = [];
  const fetchMock = (async (input: URL | RequestInfo, init?: RequestInit) => {
    requestUrl = String(input);
    const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requestBodies.push(requestBody);
    const ids = requestBody.content_ids as string[];
    const results = ids.includes(profileId)
      ? [
          {
            content_id: profileId,
            chunk_index: 1,
            chunk_text: "T-shirt size M; trouser inseam missing.",
            title: "Employee profile",
          },
          {
            content_id: policyId,
            chunk_index: 0,
            chunk_text: "Incident allowance USD 175.",
            title: "Team policy",
          },
        ]
      : [
          {
            content_id: merchantId,
            chunk_index: 0,
            chunk_text: "Eligible demo bundle costs USD 154.",
            title: "Demo merchant",
          },
        ];
    return new Response(
      JSON.stringify({ results }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const provider = createSensoKnowledgeProvider({
    apiKey: "test-key",
    baseUrl: "https://senso.test/api/v1/",
    identityResolver: resolver(),
    fetch: fetchMock,
  });
  const knowledge = await provider.getKnowledge(
    "+919876543210",
    "My bag is delayed",
    "team_recovery",
  );

  assert.equal(requestUrl, "https://senso.test/api/v1/org/search/context");
  assert.equal(requestBodies.length, 2);
  assert.deepEqual(requestBodies[0], {
    query: [
      "Complete recovery profile and applicable policies for employee emp_demo_001.",
      "Include every known, missing, stale, or conflicting clothing and equipment value,",
      "spending allowance, approval thresholds, permitted categories, and evidence requirements.",
    ].join(" "),
    max_results: 20,
    content_ids: [profileId, policyId],
    require_scoped_ids: true,
  });
  assert.deepEqual(requestBodies[1], {
    query: "Incident-specific merchant, product, and prior-outcome evidence for: My bag is delayed",
    max_results: 12,
    content_ids: [merchantId],
    require_scoped_ids: true,
  });
  assert.deepEqual(knowledge?.contentIds, [profileId, policyId, merchantId]);
  assert.match(knowledge?.context ?? "", /T-shirt size M/);
  assert.match(knowledge?.context ?? "", /Incident allowance USD 175/);
  assert.match(knowledge?.context ?? "", /Eligible demo bundle costs USD 154/);
});

test("requires strict scope on every Senso search", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchMock = (async (_input: URL | RequestInfo, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    const contentIds = body.content_ids as string[];
    return new Response(
      JSON.stringify({
        results: [
          {
            content_id: contentIds[0],
            chunk_text: "Scoped result",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  const provider = createSensoKnowledgeProvider({
    apiKey: "test-key",
    baseUrl: "https://senso.test/api/v1/",
    identityResolver: resolver(),
    fetch: fetchMock,
  });

  await provider.getKnowledge("+919876543210", "hello", "team_recovery");
  assert.equal(bodies.length, 2);
  assert.ok(bodies.every((body) => body.require_scoped_ids === true));
  assert.deepEqual(bodies.map((body) => body.content_ids), [
    [profileId, policyId],
    [merchantId],
  ]);
});

test("rejects a Senso result outside the employee allowlist", async () => {
  const fetchMock = (async () =>
    new Response(
      JSON.stringify({
        results: [
          {
            content_id: "44444444-4444-4444-8444-444444444444",
            chunk_text: "Another employee's profile",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
  const provider = createSensoKnowledgeProvider({
    apiKey: "test-key",
    baseUrl: "https://senso.test/api/v1/",
    identityResolver: resolver(),
    fetch: fetchMock,
  });

  await assert.rejects(
    () => provider.getKnowledge("+919876543210", "hello", "team_recovery"),
    /outside the employee allowlist/,
  );
});

test("does not call Senso for an unknown sender", async () => {
  const fetchMock = (async () => {
    throw new Error("Senso should not be called");
  }) as typeof fetch;
  const provider = createSensoKnowledgeProvider({
    apiKey: "test-key",
    baseUrl: "https://senso.test/api/v1/",
    identityResolver: resolver(),
    fetch: fetchMock,
  });

  assert.equal(
    await provider.getKnowledge("+12025550123", "hello", "profile"),
    null,
  );
});

test("uploads a recovery outcome and scopes subsequent team recovery to it", async () => {
  const requests: Array<{
    url: string;
    method: string;
    headers: Headers;
    body: BodyInit | null | undefined;
  }> = [];
  const searchContentIds: string[][] = [];
  let uploadedMarkdown = "";
  let outcomeFilename = "";
  const fetchMock = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    requests.push({ url, method, headers, body: init?.body });

    if (url === "https://senso.test/api/v1/org/kb/upload") {
      const body = JSON.parse(String(init?.body)) as {
        files: Array<{
          filename: string;
          file_size_bytes: number;
          content_type: string;
          content_hash_md5: string;
        }>;
      };
      assert.equal(body.files.length, 1);
      outcomeFilename = body.files[0]?.filename ?? "";
      assert.match(outcomeFilename, /^tavra-recovery-outcome-[0-9a-f]{20}\.md$/);
      assert.equal(body.files[0]?.content_type, "text/markdown");
      assert.match(body.files[0]?.content_hash_md5 ?? "", /^[0-9a-f]{32}$/);
      return new Response(
        JSON.stringify({
          results: [
            {
              content_id: outcomeId,
              upload_url: "https://objects.senso.test/presigned-outcome?signature=secret",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.startsWith("https://objects.senso.test/presigned-outcome")) {
      assert.equal(method, "PUT");
      assert.equal(headers.get("content-type"), "text/markdown");
      assert.equal(headers.has("x-api-key"), false);
      uploadedMarkdown = new TextDecoder().decode(init?.body as Uint8Array);
      return new Response(null, { status: 200 });
    }
    if (url.startsWith("https://senso.test/api/v1/org/kb/find?q=")) {
      assert.equal(new URL(url).searchParams.get("q"), outcomeFilename);
      return new Response(
        JSON.stringify({
          nodes: [{ kb_node_id: "node/outcome", content_id: outcomeId }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url === "https://senso.test/api/v1/org/kb/nodes/node%2Foutcome/content") {
      return new Response(JSON.stringify({ processing_status: "completed" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://senso.test/api/v1/org/search/context") {
      const body = JSON.parse(String(init?.body)) as { content_ids: string[] };
      searchContentIds.push(body.content_ids);
      const contentId = body.content_ids.includes(profileId)
        ? profileId
        : body.content_ids.includes(outcomeId)
          ? outcomeId
          : merchantId;
      return new Response(
        JSON.stringify({
          results: [
            {
              content_id: contentId,
              chunk_text:
                contentId === outcomeId
                  ? "Recovery case RCV-TEST was ordered and reimbursement was submitted."
                  : "Scoped employee recovery context.",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  }) as typeof fetch;

  const provider = createSensoKnowledgeProvider({
    apiKey: "test-key-that-must-not-be-uploaded",
    baseUrl: "https://senso.test/api/v1/",
    identityResolver: resolver(),
    fetch: fetchMock,
    pollIntervalMs: 0,
  });
  const recorded = await provider.recordRecoveryOutcome("+91 98765 43210", {
    recoveryCaseId: "RCV-TEST",
    recordedAt: "2026-08-02T16:45:00.000Z",
    status: "reimbursement_submitted",
    airline: "Emirates",
    arrivalAirport: "AUH",
    baggageReference: "RF392942",
    merchantName: "Recovery Essentials",
    merchantOrderId: "ORD-1001",
    items: [
      { description: "T-shirt, size M", quantity: 1 },
      { description: "Essential toiletry kit", quantity: 1 },
    ],
    total: "154.00",
    currency: "USD",
    reimbursementPacketId: "RPK-1001",
    reimbursementStatus: "submitted",
    companyNotified: true,
  });

  assert.deepEqual(recorded, {
    employeeId: "emp_demo_001",
    contentId: outcomeId,
  });
  assert.match(uploadedMarkdown, /^# Tavra recovery outcome/m);
  assert.match(uploadedMarkdown, /Recovery case: RCV-TEST/);
  assert.match(uploadedMarkdown, /Airline: Emirates/);
  assert.match(uploadedMarkdown, /Total: USD 154\.00/);
  assert.match(uploadedMarkdown, /1 x T-shirt, size M/);
  assert.match(uploadedMarkdown, /Company notified: yes/);
  assert.doesNotMatch(uploadedMarkdown, /test-key-that-must-not-be-uploaded/);

  const knowledge = await provider.getKnowledge(
    "+919876543210",
    "What happened on my last recovery?",
    "team_recovery",
  );
  assert.deepEqual(searchContentIds, [
    [profileId, policyId],
    [merchantId, outcomeId],
  ]);
  assert.deepEqual(knowledge?.contentIds, [
    profileId,
    policyId,
    merchantId,
    outcomeId,
  ]);
  assert.match(knowledge?.context ?? "", /reimbursement was submitted/);
  assert.deepEqual(
    requests.slice(0, 4).map(({ url, method }) => ({ url, method })),
    [
      { url: "https://senso.test/api/v1/org/kb/upload", method: "POST" },
      {
        url: "https://objects.senso.test/presigned-outcome?signature=secret",
        method: "PUT",
      },
      {
        url: `https://senso.test/api/v1/org/kb/find?q=${encodeURIComponent(outcomeFilename)}`,
        method: "GET",
      },
      {
        url: "https://senso.test/api/v1/org/kb/nodes/node%2Foutcome/content",
        method: "GET",
      },
    ],
  );
});

test("fails closed and does not allowlist an outcome that Senso cannot process", async () => {
  const incidentSearchIds: string[][] = [];
  const fetchMock = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://senso.test/api/v1/org/kb/upload") {
      return new Response(
        JSON.stringify({
          results: [
            {
              content_id: outcomeId,
              upload_url: "https://objects.senso.test/failed-outcome",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url === "https://objects.senso.test/failed-outcome") {
      return new Response(null, { status: 200 });
    }
    if (url.startsWith("https://senso.test/api/v1/org/kb/find?q=")) {
      return new Response(
        JSON.stringify({
          nodes: [{ kb_node_id: "failed-node", content_id: outcomeId }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/org/kb/nodes/failed-node/content")) {
      return new Response(JSON.stringify({ processing_status: "failed" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://senso.test/api/v1/org/search/context") {
      const body = JSON.parse(String(init?.body)) as { content_ids: string[] };
      if (!body.content_ids.includes(profileId)) {
        incidentSearchIds.push(body.content_ids);
      }
      return new Response(
        JSON.stringify({
          results: [
            {
              content_id: body.content_ids[0],
              chunk_text: "Existing scoped context.",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;
  const provider = createSensoKnowledgeProvider({
    apiKey: "test-key",
    baseUrl: "https://senso.test/api/v1/",
    identityResolver: resolver(),
    fetch: fetchMock,
    pollIntervalMs: 0,
  });

  await assert.rejects(
    () =>
      provider.recordRecoveryOutcome("+919876543210", {
        recoveryCaseId: "RCV-FAILED",
        recordedAt: "2026-08-02T17:00:00.000Z",
        status: "ordered",
      }),
    /failed to process the recovery outcome/,
  );
  const knowledge = await provider.getKnowledge(
    "+919876543210",
    "What was recovered?",
    "team_recovery",
  );

  assert.deepEqual(incidentSearchIds, [[merchantId]]);
  assert.deepEqual(knowledge?.contentIds, [profileId, policyId, merchantId]);
  assert.equal(knowledge?.contentIds.includes(outcomeId), false);
});

test("does not attempt an outcome upload for an unknown employee", async () => {
  let calls = 0;
  const provider = createSensoKnowledgeProvider({
    apiKey: "test-key",
    baseUrl: "https://senso.test/api/v1/",
    identityResolver: resolver(),
    fetch: (async () => {
      calls += 1;
      throw new Error("Senso should not be called");
    }) as typeof fetch,
  });

  assert.equal(
    await provider.recordRecoveryOutcome("+12025550123", {
      recoveryCaseId: "RCV-UNKNOWN",
      recordedAt: "2026-08-02T17:00:00.000Z",
      status: "ordered",
    }),
    null,
  );
  assert.equal(calls, 0);
});
