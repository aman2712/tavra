import assert from "node:assert/strict";
import test from "node:test";

import {
  createIdentityResolver,
  createSensoKnowledgeProvider,
} from "../src/senso.js";

const profileId = "11111111-1111-4111-8111-111111111111";
const policyId = "22222222-2222-4222-8222-222222222222";
const merchantId = "33333333-3333-4333-8333-333333333333";

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
