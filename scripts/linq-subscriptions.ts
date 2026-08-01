import { loadLinqApiConfig } from "../src/config.js";
import { createLinqClient } from "../src/linq.js";

const config = loadLinqApiConfig();
const client = createLinqClient(config);
const result = await client.webhookSubscriptions.list();

console.log(
  JSON.stringify(
    result.subscriptions.map((subscription) => ({
      id: subscription.id,
      active: subscription.is_active,
      targetUrl: subscription.target_url,
      events: subscription.subscribed_events,
      phoneNumbers: subscription.phone_numbers?.map(
        (number) => `…${number.slice(-4)}`,
      ),
    })),
    null,
    2,
  ),
);
