import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SqliteRecoveryStateStore } from "../src/recovery-state-store.js";

test("persists and deletes a recovery conversation across restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tavra-recovery-state-"));
  const path = join(directory, "tavra.sqlite");
  const first = new SqliteRecoveryStateStore(path);
  await first.save("chat-live-1234", {
    stage: "delivery_confirmation",
    caseId: "RCV-LIVE1234",
    deliveryAddress: "private address",
  });

  const second = new SqliteRecoveryStateStore(path);
  assert.deepEqual(await second.load("chat-live-1234"), {
    stage: "delivery_confirmation",
    caseId: "RCV-LIVE1234",
    deliveryAddress: "private address",
  });
  assert.deepEqual(await second.list?.(), [
    {
      chatId: "chat-live-1234",
      state: {
        stage: "delivery_confirmation",
        caseId: "RCV-LIVE1234",
        deliveryAddress: "private address",
      },
    },
  ]);
  await second.delete("chat-live-1234");
  assert.equal(await second.load("chat-live-1234"), null);
});
