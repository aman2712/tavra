import assert from "node:assert/strict";
import test from "node:test";

import type OpenAI from "openai";

import {
  createOpenAIReplyGenerator,
  TAVRA_REPLY_INSTRUCTIONS,
} from "../src/openai.js";

test("requests a short stateless Tavra reply", async () => {
  let request: Record<string, unknown> | null = null;
  const client = {
    responses: {
      async create(value: Record<string, unknown>) {
        request = value;
        return { output_text: "  Check your airline's app first.  " };
      },
    },
  } as unknown as OpenAI;

  const generator = createOpenAIReplyGenerator(client, "test-model");
  const reply = await generator.generateReply("My flight is delayed");

  assert.equal(reply, "Check your airline's app first.");
  assert.deepEqual(request, {
    model: "test-model",
    instructions: TAVRA_REPLY_INSTRUCTIONS,
    input: "My flight is delayed",
    reasoning: { effort: "minimal" },
    text: { verbosity: "low" },
    max_output_tokens: 180,
    store: false,
  });
});

test("rejects an empty model reply", async () => {
  const client = {
    responses: {
      async create() {
        return { output_text: "   " };
      },
    },
  } as unknown as OpenAI;
  const generator = createOpenAIReplyGenerator(client, "test-model");

  await assert.rejects(() => generator.generateReply("hello"), /empty reply/);
});
