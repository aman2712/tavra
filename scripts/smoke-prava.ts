import { loadPravaConfig } from "../src/config.js";
import {
  createPravaCheckoutService,
  createSandboxMerchantCheckoutAdapter,
} from "../src/prava.js";

const config = loadPravaConfig();
if (config.pravaMode !== "sandbox") {
  throw new Error("smoke:prava is sandbox-only and refuses PRAVA_MODE=live");
}
const service = createPravaCheckoutService({
  backendUrl: config.pravaBackendUrl,
  publishableKey: config.pravaPublishableKey,
  secretKey: config.pravaSecretKey,
  publicBaseUrl: config.publicBaseUrl,
  checkoutMode: config.pravaCheckoutMode,
  mode: "sandbox",
  merchantCheckout: createSandboxMerchantCheckoutAdapter(),
});

const checkout = await service.createCheckout({
  employeeId: "tavra_prava_smoke",
  employeeEmail: "tavra-prava-smoke@example.com",
  employeePhone: "+12025550123",
  chatId: "tavra-prava-smoke",
  totalAmount: "154.00",
  currency: "USD",
  description: "Tavra sandbox integration smoke test",
  products: [
    { description: "Neutral basic T-shirt, size M", unitPrice: "54.00", quantity: 1 },
    { description: "Basic trousers, 32x30", unitPrice: "78.00", quantity: 1 },
    { description: "Essential toiletry kit", unitPrice: "22.00", quantity: 1 },
  ],
});

const clientSession = service.getClientSession(checkout.checkoutId);
if (!clientSession) throw new Error("Prava session was not available after creation");
if (!clientSession.publishableKey.startsWith("pk_test_")) {
  throw new Error("Prava smoke test did not receive a sandbox publishable key");
}
if (!/(^|\.)prava\.space$/i.test(new URL(clientSession.iframeUrl).hostname)) {
  throw new Error("Prava smoke test received an untrusted iframe URL");
}
const clientPayload = JSON.stringify(clientSession);
if (/sk_test_|dynamic_cvv|network.?token/i.test(clientPayload)) {
  throw new Error("Prava browser payload exposed server-side payment data");
}
if (!(await service.revoke(checkout.checkoutId))) {
  throw new Error("Prava smoke session could not be revoked");
}

console.log("Prava sandbox session creation, browser handoff, and revocation passed.");
