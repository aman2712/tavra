import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SqliteCheckoutStateStore } from "../src/checkout-state-store.js";

test("persists workflow, Messages card, and notification outbox across restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tavra-checkout-state-"));
  const path = join(directory, "tavra.sqlite");
  const updatedAt = "2026-08-02T12:00:00.000Z";
  const first = new SqliteCheckoutStateStore(path);

  await first.saveWorkflow({
    checkoutId: "checkout_live_1234567890",
    caseId: "RCV-1234ABCD",
    chatId: "chat-live-1234",
    state: "approval_pending",
    payload: { paymentSessionId: "session_redacted", total: "68.00" },
    updatedAt,
  });
  await first.saveCard({
    checkoutId: "checkout_live_1234567890",
    chatId: "chat-live-1234",
    messageId: "message-live-1234",
    updatedAt,
  });
  await first.enqueueNotification({
    checkoutId: "checkout_live_1234567890",
    chatId: "chat-live-1234",
    payload: { status: "order_confirmed", orderId: "order_123" },
    attempts: 0,
    createdAt: updatedAt,
  });

  const reloaded = new SqliteCheckoutStateStore(path);
  assert.deepEqual(
    await reloaded.getWorkflow("checkout_live_1234567890"),
    {
      checkoutId: "checkout_live_1234567890",
      caseId: "RCV-1234ABCD",
      chatId: "chat-live-1234",
      state: "approval_pending",
      payload: { paymentSessionId: "session_redacted", total: "68.00" },
      updatedAt,
    },
  );
  assert.equal(
    (await reloaded.getCard("checkout_live_1234567890"))?.messageId,
    "message-live-1234",
  );
  assert.equal((await reloaded.pendingNotifications()).length, 1);
  await reloaded.markNotificationDelivered("checkout_live_1234567890");
  assert.deepEqual(await reloaded.pendingNotifications(), []);
});

test("updates a checkout idempotently without duplicating card or outbox rows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tavra-checkout-state-"));
  const store = new SqliteCheckoutStateStore(join(directory, "tavra.sqlite"));
  const checkoutId = "checkout_live_abcdefghij";
  await store.saveWorkflow({
    checkoutId,
    caseId: "RCV-1234ABCD",
    chatId: "chat-live-1234",
    state: "approval_pending",
    payload: { value: 1 },
    updatedAt: "2026-08-02T12:00:00.000Z",
  });
  await store.saveWorkflow({
    checkoutId,
    caseId: "RCV-1234ABCD",
    chatId: "chat-live-1234",
    state: "order_confirmed",
    payload: { value: 2 },
    updatedAt: "2026-08-02T12:01:00.000Z",
  });

  const snapshot = await store.getWorkflow<{ value: number }>(checkoutId);
  assert.equal(snapshot?.state, "order_confirmed");
  assert.equal(snapshot?.payload.value, 2);
});

test("atomically grants one durable merchant-checkout claim across store instances", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tavra-checkout-claim-"));
  const path = join(directory, "tavra.sqlite");
  const first = new SqliteCheckoutStateStore(path);
  const second = new SqliteCheckoutStateStore(path);
  const checkoutId = "checkout_live_atomic_claim";
  await first.saveWorkflow({
    checkoutId,
    caseId: "RCV-CLAIM123",
    chatId: "chat-claim-1234",
    state: "approval_pending",
    payload: { paymentSessionId: "session_claim" },
    updatedAt: "2026-08-02T12:00:00.000Z",
  });

  const [left, right] = await Promise.all([
    first.claimMerchantCheckout({
      checkoutId,
      ownerId: "worker-first",
      claimedAt: "2026-08-02T12:01:00.000Z",
      leaseExpiresAt: "2026-08-02T12:03:00.000Z",
    }),
    second.claimMerchantCheckout({
      checkoutId,
      ownerId: "worker-second",
      claimedAt: "2026-08-02T12:01:00.000Z",
      leaseExpiresAt: "2026-08-02T12:03:00.000Z",
    }),
  ]);

  assert.equal([left, right].filter(Boolean).length, 1);
  assert.equal(
    (await second.getWorkflow(checkoutId))?.state,
    "merchant_checkout_pending",
  );
  assert.equal(
    (await second.getMerchantCheckoutClaim(checkoutId))?.ownerId,
    left ? "worker-first" : "worker-second",
  );
});

test("only the claim owner can durably complete merchant checkout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tavra-checkout-complete-"));
  const store = new SqliteCheckoutStateStore(join(directory, "tavra.sqlite"));
  const checkoutId = "checkout_live_owned_claim";
  await store.saveWorkflow({
    checkoutId,
    caseId: "RCV-OWNED123",
    chatId: "chat-owned-1234",
    state: "approval_pending",
    payload: { result: null },
    updatedAt: "2026-08-02T12:00:00.000Z",
  });
  const claimed = await store.claimMerchantCheckout<{ result: string | null }>({
    checkoutId,
    ownerId: "worker-owner",
    claimedAt: "2026-08-02T12:01:00.000Z",
    leaseExpiresAt: "2026-08-02T12:03:00.000Z",
  });
  assert.ok(claimed);
  const completed = {
    ...claimed,
    state: "order_confirmed" as const,
    payload: { result: "merchant-order-1" },
    updatedAt: "2026-08-02T12:01:10.000Z",
  };

  assert.equal(
    await store.completeMerchantCheckout(completed, "worker-intruder"),
    false,
  );
  assert.equal(
    await store.completeMerchantCheckout(completed, "worker-owner"),
    true,
  );
  assert.equal((await store.getWorkflow(checkoutId))?.state, "order_confirmed");
});
