import assert from "node:assert/strict";
import test from "node:test";

import { demoDeliveryEstimate } from "../src/demo-delivery.js";

test("shows a delivery estimate thirty minutes before the requested deadline", () => {
  assert.equal(
    demoDeliveryEstimate("8 AM tomorrow"),
    "7:30 AM tomorrow",
  );
  assert.equal(
    demoDeliveryEstimate("before 7:00 p.m. tomorrow"),
    "6:30 PM tomorrow",
  );
});

test("uses a stable demo estimate when the deadline has no parseable time", () => {
  assert.equal(demoDeliveryEstimate(null), "7:30 AM tomorrow");
  assert.equal(demoDeliveryEstimate("tomorrow morning"), "7:30 AM tomorrow");
});

test("handles a midnight deadline without assigning the estimate to the wrong day", () => {
  assert.equal(
    demoDeliveryEstimate("12:00 AM tomorrow"),
    "11:30 PM today",
  );
});
