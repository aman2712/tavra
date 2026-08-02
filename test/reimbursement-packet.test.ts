import assert from "node:assert/strict";
import test from "node:test";

import {
  emiratesReimbursementOffer,
  loadDemoReimbursementPacket,
} from "../src/reimbursement-packet.js";

test("loads the bounded private reimbursement PDF and produces stable evidence", async () => {
  const first = await loadDemoReimbursementPacket();
  const second = await loadDemoReimbursementPacket();
  assert.equal(first.filename, "tavra-emirates-reimbursement-packet.pdf");
  assert.equal(first.contentType, "application/pdf");
  assert.equal(Buffer.from(first.bytes.subarray(0, 5)).toString("ascii"), "%PDF-");
  assert.match(first.sha256, /^[a-f0-9]{64}$/);
  assert.equal(first.sha256, second.sha256);
  assert.ok(first.bytes.byteLength > 1_000);
});

test("uses concise policy-grounded reimbursement follow-up copy", () => {
  const copy = emiratesReimbursementOffer();
  assert.match(copy, /within 21 days/i);
  assert.match(copy, /essential clothing or toiletries/i);
  assert.match(copy, /reply yes/i);
  assert.doesNotMatch(copy, /sandbox|simulat|—/i);
});
