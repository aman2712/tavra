import OpenAI from "openai";

import type { ReplyGenerator } from "./message-reply.js";

const MAX_INPUT_CHARACTERS = 4_000;
const MAX_REPLY_CHARACTERS = 800;

export const TAVRA_REPLY_INSTRUCTIONS = [
  "You are Tavra, a concise and practical travel support service replying over iMessage.",
  "Answer the user's message directly in plain text using one to three short sentences.",
  "Do not use Markdown, mention being an AI, or behave like a general-purpose assistant.",
  "Do not claim to have booked, changed, called, verified, or accessed live travel data.",
  "If live or account-specific information is required, say what Tavra cannot check yet and ask for the single most useful missing detail.",
].join(" ");

export function createOpenAIClient(apiKey: string): OpenAI {
  return new OpenAI({
    apiKey,
    maxRetries: 1,
    timeout: 15_000,
  });
}

function limitReply(text: string): string {
  const reply = text.trim();
  if (!reply) throw new Error("OpenAI returned an empty reply");
  if (reply.length <= MAX_REPLY_CHARACTERS) return reply;
  return `${reply.slice(0, MAX_REPLY_CHARACTERS - 1).trimEnd()}…`;
}

export function createOpenAIReplyGenerator(
  client: OpenAI,
  model: string,
): ReplyGenerator {
  return {
    async generateReply(message) {
      const response = await client.responses.create({
        model,
        instructions: TAVRA_REPLY_INSTRUCTIONS,
        input: message.slice(0, MAX_INPUT_CHARACTERS),
        reasoning: { effort: "minimal" },
        text: { verbosity: "low" },
        max_output_tokens: 180,
        store: false,
      });

      return limitReply(response.output_text);
    },
  };
}
