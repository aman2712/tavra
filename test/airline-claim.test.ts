import assert from "node:assert/strict";
import test from "node:test";

import { createSandboxAirlineClaimSubmissionProvider } from "../src/airline-claim.js";

test("sandbox airline claim submission is deterministic and carries an evidence hash", async () => {
  const provider = createSandboxAirlineClaimSubmissionProvider({
    now: () => new Date("2026-08-02T18:00:00.000Z"),
  });
  const request = {
    caseId: "RCV-DEMO1234",
    packetHash: "a".repeat(64),
    airlineName: "Emirates",
    airlineCode: "EK",
    baggageReference: "RF392942",
    totalAmount: "154.00",
    currency: "USD",
  };

  const first = await provider.submit(request);
  const second = await provider.submit(request);

  assert.deepEqual(first, second);
  assert.match(first.externalClaimId, /^EK-[A-F0-9]{10}$/);
  assert.match(first.confirmationSha256, /^[a-f0-9]{64}$/);
  assert.equal(first.expectedReviewWindow, "3-5 business days");
  assert.equal(first.companyNotified, true);
  assert.equal(provider.environment, "sandbox");
});
