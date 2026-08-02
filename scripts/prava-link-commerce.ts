import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { linkPravaCommerce } from "../src/prava-oauth-link.js";
import {
  DEFAULT_PRAVA_MCP_URL,
  createPravaUcpCommerceProvider,
} from "../src/prava-commerce.js";
import {
  MacOsKeychainPravaTokenStore,
  PravaStreamableHttpTransport,
} from "../src/prava-mcp.js";

const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("The one-time Tavra linker currently requires macOS Keychain and `open`");
  }
  const endpoint = process.env.PRAVA_MCP_URL?.trim() || DEFAULT_PRAVA_MCP_URL;
  const tokenStore = new MacOsKeychainPravaTokenStore(
    process.env.PRAVA_MCP_KEYCHAIN_SERVICE?.trim() || "space.tavra.prava-mcp",
    process.env.PRAVA_MCP_KEYCHAIN_ACCOUNT?.trim() || "commerce-oauth",
  );

  process.stdout.write("Opening Prava sign-in for Tavra live commerce...\n");
  await linkPravaCommerce({
    endpoint,
    tokenStore,
    async openBrowser(url) {
      await execFileAsync("open", [url]);
    },
  });

  const transport = new PravaStreamableHttpTransport({ endpoint, tokenStore });
  const provider = createPravaUcpCommerceProvider({ transport });
  const health = await provider.health();
  if (!health.ready) {
    throw new Error(
      health.message ??
        "Prava linked, but the account is missing a connected shopping agent or saved masked address",
    );
  }
  const search = await provider.search({
    query: "basic neutral T-shirt size M",
    category: "tshirt",
    shipsTo: "AE",
  });
  const first = search.results[0] ?? null;
  if (first) {
    await provider.getProduct({
      productId: first.productId,
      merchant: first.merchant.domain,
    });
  }
  process.stdout.write(
    `Prava linked. Connected agents: ${health.connectedAgentCount}. Saved masked addresses: ${health.savedAddressCount}.\n`,
  );
  process.stdout.write(
    first
      ? "UCP search and product access verified. No quote or order was created.\n"
      : "UCP search access verified, but no UAE T-shirt result was returned. No quote or order was created.\n",
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Prava commerce linking failed: ${message}\n`);
  process.exitCode = 1;
});
