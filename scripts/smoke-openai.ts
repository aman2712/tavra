import { loadOpenAIConfig } from "../src/config.js";
import { createOpenAIClient, createOpenAIReplyGenerator } from "../src/openai.js";

const config = loadOpenAIConfig();
const client = createOpenAIClient(config.openAIApiKey);
const generator = createOpenAIReplyGenerator(client, config.openAIModel);
const reply = await generator.generateReply(
  "My flight is delayed. What should I do first?",
);

console.log(`OpenAI smoke test passed using ${config.openAIModel}.`);
console.log(`Reply: ${reply}`);
