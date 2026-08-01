import { resolve } from "node:path";

import { createApp } from "./app.js";
import { loadServerConfig } from "./config.js";
import { JsonlProcessedEventStore } from "./event-store.js";
import { createLinqClient, createLinqMessageSender } from "./linq.js";
import { createMessageReplyProcessor } from "./message-reply.js";
import { createOpenAIClient, createOpenAIReplyGenerator } from "./openai.js";

const config = loadServerConfig();
const linqClient = createLinqClient(config);
const openAIClient = createOpenAIClient(config.openAIApiKey);
const generator = createOpenAIReplyGenerator(openAIClient, config.openAIModel);
const sender = createLinqMessageSender(linqClient);
const store = new JsonlProcessedEventStore(
  resolve(process.cwd(), "data/processed-events.jsonl"),
);
const processEvent = createMessageReplyProcessor({
  fromNumber: config.fromNumber,
  generator,
  sender,
  store,
});
const app = createApp({ config, client: linqClient, processEvent });

const server = app.listen(config.port, "0.0.0.0", () => {
  console.info(
    JSON.stringify({
      service: "tavra",
      status: "listening",
      port: config.port,
      linqMode: config.mode,
      openAIModel: config.openAIModel,
    }),
  );
});

function shutdown(signal: string) {
  console.info(JSON.stringify({ service: "tavra", status: "stopping", signal }));
  server.close((error) => {
    process.exit(error ? 1 : 0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
