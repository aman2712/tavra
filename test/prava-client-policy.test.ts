import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  BrowserProfileStorageError,
  PRAVA_BROWSER_PROFILE_HEADER,
  PRAVA_BROWSER_PROFILE_STORAGE_KEY,
  PRAVA_POLL_INTERVAL_MS,
  PRAVA_POLL_TIMEOUT_MS,
  assessCheckoutEnvironment,
  getOrCreateBrowserProfileId,
  isSecureCardFormComplete,
  presentPravaFailure,
} from "../web/prava-client-policy.js";

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const firstProfile = "11111111-1111-4111-8111-111111111111";
const secondProfile = "22222222-2222-4222-8222-222222222222";

test("persists one browser profile id and reuses it across checkouts", () => {
  const storage = new MemoryStorage();
  let generated = 0;
  const create = () => {
    generated += 1;
    return generated === 1 ? firstProfile : secondProfile;
  };

  assert.equal(getOrCreateBrowserProfileId(storage, create), firstProfile);
  assert.equal(getOrCreateBrowserProfileId(storage, create), firstProfile);
  assert.equal(storage.getItem(PRAVA_BROWSER_PROFILE_STORAGE_KEY), firstProfile);
  assert.equal(generated, 1);
  assert.equal(PRAVA_BROWSER_PROFILE_HEADER, "X-Prava-Browser-Profile-Id");
});

test("blocks checkout when durable browser profile storage is unavailable", () => {
  const storage = {
    getItem(): string | null {
      throw new Error("storage denied");
    },
    setItem(): void {},
  };
  assert.throws(
    () => getOrCreateBrowserProfileId(storage, () => firstProfile),
    BrowserProfileStorageError,
  );
});

test("rejects embedded webviews and devices without a platform authenticator", async () => {
  const electron = await assessCheckoutEnvironment({
    userAgent: "Mozilla/5.0 Electron/30.0 Code/1.90",
    isSecureContext: true,
    platformAuthenticatorAvailable: async () => true,
  });
  assert.equal(electron.ok, false);
  assert.equal(electron.code, "EMBEDDED_WEBVIEW_UNSUPPORTED");

  const unavailable = await assessCheckoutEnvironment({
    userAgent: "Mozilla/5.0 AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15",
    isSecureContext: true,
    platformAuthenticatorAvailable: async () => false,
  });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.code, "PLATFORM_AUTHENTICATOR_UNAVAILABLE");

  const supported = await assessCheckoutEnvironment({
    userAgent: "Mozilla/5.0 AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15",
    isSecureContext: true,
    platformAuthenticatorAvailable: async () => true,
  });
  assert.deepEqual(supported, { ok: true });
});

test("keeps Prava error codes and distinguishes expired from incorrect OTP", () => {
  const expired = presentPravaFailure({
    code: "OTP_EXPIRED",
    message: "The verification code expired",
  });
  assert.equal(expired.category, "otp_expired");
  assert.match(expired.displayMessage, /^OTP_EXPIRED: The verification code expired/);
  assert.match(expired.displayMessage, /request a new code/i);
  assert.doesNotMatch(expired.displayMessage, /incorrect code/i);
  assert.equal(expired.retryAllowed, true);

  const incorrect = presentPravaFailure({
    error: { code: "OTP_INCORRECT", message: "The code you entered is incorrect" },
  });
  assert.equal(incorrect.category, "otp_incorrect");
  assert.match(incorrect.displayMessage, /^OTP_INCORRECT: The code you entered is incorrect/);
  assert.equal(incorrect.retryAllowed, true);

  const timedOut = presentPravaFailure({
    code: "PRAVA_STATUS_TIMEOUT",
    message: "No terminal result after 90 seconds",
  });
  assert.equal(timedOut.retryAllowed, false);
  assert.match(timedOut.displayMessage, /do not start another transaction/i);
});

test("gives specific storage, binding, and rate-limit recovery without transaction retry", () => {
  const storage = presentPravaFailure({
    code: "STORAGE_ACCESS_DENIED",
    message: "Third-party cookies are blocked",
  });
  assert.equal(storage.category, "storage");
  assert.match(storage.displayMessage, /normal Safari or Chrome window/i);
  assert.match(storage.displayMessage, /third-party cookies/i);

  const binding = presentPravaFailure({
    code: "TOKEN_BINDING_LIMIT",
    message: "Maximum binding for token exceeded",
  });
  assert.equal(binding.category, "binding");
  assert.equal(binding.retryAllowed, false);
  assert.match(binding.displayMessage, /do not retry/i);

  const limited = presentPravaFailure({ code: "HTTP_429", message: "Too many requests" });
  assert.equal(limited.category, "rate_limited");
  assert.match(limited.displayMessage, /same transaction/i);
});

test("mirrors Prava validation without reading raw card fields", () => {
  const validField = { isEmpty: false, isValid: true, isFocused: false };
  const emptyField = { isEmpty: true, isValid: false, isFocused: false };
  assert.equal(
    isSecureCardFormComplete({
      cardNumber: validField,
      expiry: validField,
      cvv: validField,
      isComplete: true,
    }),
    true,
  );
  assert.equal(
    isSecureCardFormComplete({
      cardNumber: validField,
      expiry: emptyField,
      cvv: validField,
      isComplete: true,
    }),
    false,
  );
  assert.equal(
    isSecureCardFormComplete({
      cardNumber: validField,
      expiry: validField,
      cvv: validField,
      isComplete: false,
    }),
    false,
  );
});

test("payment status polling is bounded and never tighter than three seconds", () => {
  assert.ok(PRAVA_POLL_INTERVAL_MS >= 3_000);
  assert.ok(PRAVA_POLL_TIMEOUT_MS >= PRAVA_POLL_INTERVAL_MS);
  assert.ok(PRAVA_POLL_TIMEOUT_MS <= 120_000);
});

test("cancel uses a bodyless POST without a JSON content type and no client prefetches OTP", () => {
  const source = readFileSync(new URL("../web/main.ts", import.meta.url), "utf8");
  const revokeRequest = source.slice(
    source.indexOf("/revoke`"),
    source.indexOf("window.addEventListener", source.indexOf("/revoke`")),
  );
  assert.match(revokeRequest, /method:\s*"POST"/);
  assert.doesNotMatch(revokeRequest, /Content-Type|application\/json/i);
  assert.doesNotMatch(source, /fetch\([^)]*(?:otp|one-time-code|verification-code)/i);
});

test("renders sandbox validation as merchant-attempt proof rather than an order", () => {
  const source = readFileSync(new URL("../web/main.ts", import.meta.url), "utf8");
  const start = source.indexOf("function showSandboxValidated");
  const end = source.indexOf("function setValidation", start);
  const presentation = source.slice(start, end);

  assert.ok(start >= 0);
  assert.match(presentation, /sandbox_validated/);
  assert.match(presentation, /one-time card was issued/i);
  assert.match(presentation, /checkout was attempted/i);
  assert.match(presentation, /expected sandbox decline was recorded/i);
  assert.match(presentation, /No merchant order or reimbursable expense was created/i);
  assert.doesNotMatch(presentation, /Order placed|reimbursement packet/i);
});
