import { PravaSDK, type CardValidationState, type PravaError } from "@prava-sdk/core";

import "./styles.css";
import {
  BrowserProfileStorageError,
  PRAVA_BROWSER_PROFILE_HEADER,
  PRAVA_POLL_INTERVAL_MS,
  PRAVA_POLL_TIMEOUT_MS,
  assessCheckoutEnvironment,
  getOrCreateBrowserProfileId,
  isSecureCardFormComplete,
  presentPravaFailure,
  pravaErrorValue,
  type PravaFailurePresentation,
} from "./prava-client-policy.js";

interface ClientSession {
  checkoutMode: "embedded" | "hosted";
  publishableKey: string;
  sessionToken: string;
  iframeUrl: string;
  expiresAt: string;
  order: {
    description: string;
    totalAmount: string;
    currency: string;
    products: Array<{ description: string; unitPrice: string; quantity: number }>;
  };
}

interface CheckoutSummary {
  checkoutId: string;
  expiresAt: string;
  order: ClientSession["order"] & {
    merchant?: {
      name?: string;
      provenance?: string;
    };
  };
}

interface MerchantAttempt {
  merchantName: string;
  merchantUrl: string;
  attemptedAt: string;
  responseText: string;
  responseCode: string;
  reference: string | null;
}

type PublicStatus =
  | { status: "pending" | "awaiting_result" }
  | {
      status: "completed";
      merchantOrderId: string;
      merchantOutcome: "simulated" | "sandbox_merchant" | "live";
    }
  | { status: "sandbox_validated"; merchantAttempt: MerchantAttempt }
  | { status: "reconciliation_required"; code?: string; message: string }
  | { status: "failed"; code?: string; message: string };

const checkoutId = decodeURIComponent(location.pathname.split("/").filter(Boolean).at(-1) ?? "");
const searchParams = new URLSearchParams(location.search);
const isPreview = searchParams.get("preview") === "1";
const isPravaReturn = searchParams.get("prava_return") === "1";
const loadingState = requiredElement<HTMLDivElement>("loading-state");
const errorState = requiredElement<HTMLDivElement>("error-state");
const successState = requiredElement<HTMLDivElement>("success-state");
const cardStage = requiredElement<HTMLDivElement>("card-stage");
const frame = requiredElement<HTMLDivElement>("prava-card-form");
const orderItems = requiredElement<HTMLUListElement>("order-items");
const orderSkeleton = requiredElement<HTMLDivElement>("order-skeleton");
const orderTotal = requiredElement<HTMLElement>("order-total");
const errorMessage = requiredElement<HTMLElement>("error-message");
const errorTitle = requiredElement<HTMLElement>("error-title");
const paymentStatus = requiredElement<HTMLElement>("payment-status");
const timer = requiredElement<HTMLElement>("session-timer");
const successEyebrow = requiredElement<HTMLElement>("success-eyebrow");
const successTitle = requiredElement<HTMLElement>("success-title");
const successCopy = requiredElement<HTMLElement>("success-copy");
const environmentLabel = requiredElement<HTMLElement>("environment-label");
const retryButton = requiredElement<HTMLButtonElement>("retry-button");
const cancelButton = requiredElement<HTMLButtonElement>("cancel-button");
let sdk: PravaSDK | null = null;
let pollTimer: number | null = null;
let countdownTimer: number | null = null;
let observerTimer: number | null = null;
let frameObserver: MutationObserver | null = null;
let stopped = false;
let pollStartedAt = 0;
let browserProfileId: string | null = null;

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing checkout element: ${id}`);
  return element as T;
}

function showOnly(target: HTMLElement): void {
  for (const element of [loadingState, errorState, successState, cardStage]) {
    element.hidden = element !== target;
  }
}

function formatMoney(amount: string, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
  }).format(Number(amount));
}

function renderOrder(session: ClientSession): void {
  orderItems.replaceChildren();
  for (const product of session.order.products) {
    const item = document.createElement("li");
    const details = document.createElement("span");
    const price = document.createElement("strong");
    details.textContent = product.description;
    price.textContent = formatMoney(
      String(Number(product.unitPrice) * product.quantity),
      session.order.currency,
    );
    item.append(details, price);
    orderItems.append(item);
  }
  orderTotal.textContent = formatMoney(session.order.totalAmount, session.order.currency);
  orderSkeleton.hidden = true;
  orderItems.hidden = false;
}

function showCompleted(result: Extract<PublicStatus, { status: "completed" }>): void {
  stopped = true;
  stopTimers();
  sdk?.destroy();
  if (result.merchantOutcome === "live") {
    environmentLabel.textContent = "Live merchant checkout";
    successEyebrow.textContent = "Order confirmed";
    successTitle.textContent = "Your order is placed.";
    successCopy.textContent = `Merchant order ${result.merchantOrderId} is confirmed. Tavra has updated Messages and added the order evidence to your reimbursement case.`;
  } else {
    environmentLabel.textContent = "Secure payment";
    successEyebrow.textContent = "Approval complete";
    successTitle.textContent = "Order placed.";
    successCopy.textContent = `Order ${result.merchantOrderId} is confirmed. Tavra has updated your iMessage thread and prepared the reimbursement packet.`;
  }
  showOnly(successState);
}

function showSandboxValidated(
  result: Extract<PublicStatus, { status: "sandbox_validated" }>,
): void {
  stopped = true;
  stopTimers();
  sdk?.destroy();
  environmentLabel.textContent = "Sandbox commerce validation";
  successEyebrow.textContent = "End-to-end check complete";
  successTitle.textContent = "Merchant attempt verified.";
  successCopy.textContent = `Prava approval completed, a one-time card was issued, and checkout was attempted at ${result.merchantAttempt.merchantName}. The expected sandbox decline was recorded. No merchant order or reimbursable expense was created.`;
  showOnly(successState);
}

function setValidation(state: CardValidationState): void {
  const values = {
    card: state.cardNumber,
    expiry: state.expiry,
    cvv: state.cvv,
  };
  for (const [field, fieldState] of Object.entries(values)) {
    const element = document.querySelector<HTMLElement>(`[data-field="${field}"]`);
    if (!element) continue;
    element.dataset.state = fieldState.isValid ? "valid" : fieldState.isFocused ? "active" : "idle";
  }
  paymentStatus.textContent = isSecureCardFormComplete(state)
    ? "Ready for secure approval"
    : "Prava is validating the cardholder name, card number, expiry, and security code";
}

function showFailure(failure: PravaFailurePresentation): void {
  stopped = true;
  stopTimers();
  errorTitle.textContent = failure.title;
  errorMessage.textContent = failure.displayMessage;
  retryButton.hidden = !failure.retryAllowed;
  retryButton.textContent =
    failure.category === "otp_expired"
      ? "Reopen Prava to request a code"
      : failure.category === "otp_incorrect"
        ? "Reopen Prava"
        : "Reload this checkout";
  showOnly(errorState);
}

function showError(message: string, code = "TAVRA_CHECKOUT_ERROR"): void {
  showFailure(presentPravaFailure({ code, message }));
}

function failureFromCaught(
  error: unknown,
  fallback: { code: string; message: string },
): PravaFailurePresentation {
  return typeof error === "object" && error && "displayMessage" in error
    ? (error as PravaFailurePresentation)
    : presentPravaFailure(error, fallback);
}

async function responseFailure(
  response: Response,
  fallbackMessage: string,
): Promise<PravaFailurePresentation> {
  const payload = await response.clone().json().catch(() => ({}));
  return presentPravaFailure(payload, {
    code: `HTTP_${response.status}`,
    message: fallbackMessage,
  });
}

function markSecureFormReady(): void {
  frame.dataset.ready = "true";
  paymentStatus.textContent = "Card details stay protected by Prava";
  frameObserver?.disconnect();
  frameObserver = null;
  if (observerTimer !== null) window.clearTimeout(observerTimer);
  observerTimer = null;
}

function stopTimers(): void {
  if (pollTimer !== null) window.clearTimeout(pollTimer);
  if (countdownTimer !== null) window.clearInterval(countdownTimer);
  if (observerTimer !== null) window.clearTimeout(observerTimer);
  frameObserver?.disconnect();
  pollTimer = null;
  countdownTimer = null;
  observerTimer = null;
  frameObserver = null;
}

function startCountdown(expiresAt: string): void {
  const update = () => {
    const remaining = Math.max(0, Date.parse(expiresAt) - Date.now());
    const minutes = Math.floor(remaining / 60_000);
    const seconds = Math.floor((remaining % 60_000) / 1_000);
    timer.textContent = remaining > 0 ? `${minutes}:${seconds.toString().padStart(2, "0")}` : "Expired";
    if (remaining === 0) {
      showError("This secure session expired. Ask Tavra for a fresh link.", "SESSION_EXPIRED");
    }
  };
  update();
  countdownTimer = window.setInterval(update, 1_000);
}

async function pollStatus(): Promise<void> {
  if (stopped) return;
  if (pollStartedAt === 0) pollStartedAt = Date.now();
  if (Date.now() - pollStartedAt >= PRAVA_POLL_TIMEOUT_MS) {
    showFailure(
      presentPravaFailure({
        code: "PRAVA_STATUS_TIMEOUT",
        message:
          "Tavra stopped checking after 90 seconds without a terminal Prava result. The transaction was not retried.",
      }),
    );
    return;
  }
  try {
    const response = await fetch(`/api/prava/checkouts/${encodeURIComponent(checkoutId)}/status`, {
      cache: "no-store",
    });
    if (!response.ok) {
      const failure = await responseFailure(response, "Unable to verify approval status.");
      if (response.status === 429 || response.status >= 500) {
        paymentStatus.textContent = `Status check delayed: ${failure.code}: ${failure.message}`;
      } else {
        showFailure(failure);
        return;
      }
    } else {
    const result = (await response.json()) as PublicStatus;
    if (result.status === "completed") {
      showCompleted(result);
      return;
    }
    if (result.status === "sandbox_validated") {
      showSandboxValidated(result);
      return;
    }
    if (result.status === "failed") {
      showFailure(
        presentPravaFailure({
          code: result.code ?? "PRAVA_STATUS_FAILED",
          message: result.message || "Secure approval failed.",
        }),
      );
      return;
    }
    if (result.status === "reconciliation_required") {
      showFailure(
        presentPravaFailure({
          code: result.code ?? "RECONCILIATION_REQUIRED",
          message: result.message,
        }),
      );
      return;
    }
    }
  } catch (error) {
    const failure = presentPravaFailure(error, {
      code: "STATUS_NETWORK_ERROR",
      message: "The approval status check was interrupted.",
    });
    paymentStatus.textContent = `Status check delayed: ${failure.code}: ${failure.message}`;
  }
  pollTimer = window.setTimeout(pollStatus, PRAVA_POLL_INTERVAL_MS);
}

async function start(): Promise<void> {
  stopped = false;
  pollStartedAt = 0;
  stopTimers();
  sdk?.destroy();
  sdk = null;
  frame.removeAttribute("data-ready");
  showOnly(loadingState);
  try {
    if (!isPravaReturn) {
      const credential = globalThis.PublicKeyCredential as
        | (typeof PublicKeyCredential & {
            isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean>;
          })
        | undefined;
      const environment = await assessCheckoutEnvironment({
        userAgent: navigator.userAgent,
        isSecureContext: globalThis.isSecureContext,
        platformAuthenticatorAvailable:
          credential?.isUserVerifyingPlatformAuthenticatorAvailable?.bind(credential),
      });
      if (!environment.ok) {
        showFailure(
          presentPravaFailure({
            code: environment.code,
            message: environment.message,
          }),
        );
        return;
      }
      browserProfileId = getOrCreateBrowserProfileId(
        localStorage,
        crypto.randomUUID.bind(crypto),
      );
    }

    const summaryResponse = await fetch(
      `/api/prava/checkouts/${encodeURIComponent(checkoutId)}/summary`,
      { cache: "no-store" },
    );
    if (summaryResponse.ok) {
      const summary = (await summaryResponse.json()) as CheckoutSummary;
      renderOrder(summary as ClientSession);
      startCountdown(summary.expiresAt);
      if (summary.order.merchant?.provenance === "Prava UCP live merchant") {
        environmentLabel.textContent = "Live merchant checkout";
      }
    }

    const statusResponse = await fetch(
      `/api/prava/checkouts/${encodeURIComponent(checkoutId)}/status`,
      { cache: "no-store" },
    );
    if (statusResponse.ok) {
      const status = (await statusResponse.json()) as PublicStatus;
      if (status.status === "completed") {
        showCompleted(status);
        return;
      }
      if (status.status === "sandbox_validated") {
        showSandboxValidated(status);
        return;
      }
      if (status.status === "failed") {
        showFailure(
          presentPravaFailure({
            code: status.code ?? "PRAVA_STATUS_FAILED",
            message: status.message || "Secure approval failed.",
          }),
        );
        return;
      }
      if (status.status === "reconciliation_required") {
        showFailure(
          presentPravaFailure({
            code: status.code ?? "RECONCILIATION_REQUIRED",
            message: status.message,
          }),
        );
        return;
      }
    }

    const response = await fetch(
      `/api/prava/checkouts/${encodeURIComponent(checkoutId)}/session`,
      {
        cache: "no-store",
        headers: browserProfileId
          ? { [PRAVA_BROWSER_PROFILE_HEADER]: browserProfileId }
          : undefined,
      },
    );
    const payload = (await response.json().catch(() => ({}))) as ClientSession & {
      error?: string;
    };
    if (!response.ok) {
      throw presentPravaFailure(payload, {
        code: `HTTP_${response.status}`,
        message: payload.error || "This secure link is invalid or expired.",
      });
    }
    renderOrder(payload);
    if (countdownTimer === null) startCountdown(payload.expiresAt);

    if (payload.checkoutMode === "hosted") {
      const loadingCopy = loadingState.querySelector("p");
      if (loadingCopy) {
        loadingCopy.textContent = isPravaReturn
          ? "Finalizing your secure approval..."
          : "Opening Prava's secure checkout...";
      }
      showOnly(loadingState);
      if (!isPravaReturn) {
        window.location.assign(payload.iframeUrl);
        return;
      }
      void pollStatus();
      return;
    }

    showOnly(cardStage);

    sdk = new PravaSDK({ publishableKey: payload.publishableKey });
    frameObserver = new MutationObserver(() => {
      if (frame.querySelector("iframe")) {
        markSecureFormReady();
      }
    });
    frameObserver.observe(frame, { childList: true, subtree: true });
    observerTimer = window.setTimeout(() => {
      if (frame.querySelector("iframe")) {
        markSecureFormReady();
        return;
      }
      showFailure(
        presentPravaFailure({
          code: "PRAVA_IFRAME_INIT_TIMEOUT",
          message: "Prava's protected form did not initialize.",
        }),
      );
    }, 10_000);

    void sdk.collectPAN({
      sessionToken: payload.sessionToken,
      iframeUrl: payload.iframeUrl,
      container: frame,
      styles: {
        base: {
          fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
          fontSize: "16px",
          color: "#20201e",
          backgroundColor: "#ffffff",
          borderColor: "#dedbd2",
          borderRadius: "14px",
          padding: "14px",
        },
        focus: { borderColor: "#3276e8", boxShadow: "0 0 0 3px #e5efff" },
        invalid: { borderColor: "#b7463f", color: "#943b35" },
      },
      onReady: markSecureFormReady,
      onChange: setValidation,
      onSuccess: () => {
        paymentStatus.textContent = "Card secured. Completing approval…";
      },
      onDismiss: () => {
        paymentStatus.textContent = "Approval paused";
      },
      onError: (error: PravaError) => showFailure(presentPravaFailure(pravaErrorValue(error))),
    }).catch((error: unknown) => {
      showFailure(
        presentPravaFailure(error, {
          code: "PRAVA_FORM_LOAD_FAILED",
          message: "Unable to load the protected form.",
        }),
      );
    });
    void pollStatus();
  } catch (error) {
    if (error instanceof BrowserProfileStorageError) {
      showFailure(presentPravaFailure({ code: error.code, message: error.message }));
      return;
    }
    showFailure(
      failureFromCaught(error, {
        code: "CHECKOUT_START_FAILED",
        message: "Unable to start secure checkout.",
      }),
    );
  }
}

function startPreview(): void {
  document.body.dataset.preview = "true";
  document.title = "Payment UI preview | Tavra";
  const secureLabel = document.querySelector<HTMLElement>(".secure-label");
  if (secureLabel) secureLabel.lastChild!.textContent = " UI preview";
  renderOrder({
    checkoutMode: "embedded",
    publishableKey: "preview",
    sessionToken: "preview",
    iframeUrl: "https://example.com/",
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    order: {
      description: "Tavra delayed-baggage recovery essentials",
      totalAmount: "154.00",
      currency: "USD",
      products: [
        { description: "Neutral basic T-shirt, size M", unitPrice: "54.00", quantity: 1 },
        { description: "Basic trousers, 32x30", unitPrice: "78.00", quantity: 1 },
        { description: "Essential toiletry kit", unitPrice: "22.00", quantity: 1 },
      ],
    },
  });
  timer.textContent = "Preview";
  paymentStatus.textContent = "Design preview only, payments are disabled";
  cancelButton.disabled = true;
  for (const chip of document.querySelectorAll<HTMLElement>("[data-field]")) {
    chip.dataset.state = "valid";
  }
  const preview = document.createElement("div");
  preview.className = "preview-form";
  preview.setAttribute("aria-label", "Disabled preview of the Prava secure card form");
  preview.innerHTML = `
    <div class="preview-notice">
      <span class="preview-lock" aria-hidden="true">✓</span>
      <div><strong>Prava secure form</strong><small>Preview mode, no card data is accepted</small></div>
    </div>
    <div class="preview-field preview-field-wide"><span>Card number</span><strong>•••• •••• •••• ••••</strong></div>
    <div class="preview-field-row">
      <div class="preview-field"><span>Expiry</span><strong>MM / YY</strong></div>
      <div class="preview-field"><span>Security code</span><strong>CVV</strong></div>
    </div>
    <div class="preview-passkey"><span aria-hidden="true">◎</span><div><strong>Passkey protected</strong><small>Repeat approvals can use your saved card and biometrics.</small></div></div>
    <button class="preview-approve" type="button" disabled>Approve securely</button>
  `;
  frame.replaceChildren(preview);
  frame.classList.add("is-preview");
  showOnly(cardStage);
}

retryButton.addEventListener("click", () => void start());
cancelButton.addEventListener("click", async () => {
  stopped = true;
  stopTimers();
  sdk?.destroy();
  try {
    const response = await fetch(
      `/api/prava/checkouts/${encodeURIComponent(checkoutId)}/revoke`,
      { method: "POST" },
    );
    const result = (await response.json().catch(() => ({}))) as { revoked?: boolean };
    if (!response.ok) {
      throw presentPravaFailure(result, {
        code: `HTTP_${response.status}`,
        message: "Cancellation could not be verified.",
      });
    }
    if (result.revoked !== true) {
      throw presentPravaFailure({
        code: "CANCEL_NOT_CONFIRMED",
        message: "The payment state changed before cancellation completed.",
      });
    }
    showError("This checkout was canceled. Return to Messages if you want a new link.");
  } catch (error) {
    const failure = failureFromCaught(error, {
      code: "CANCEL_STATUS_UNKNOWN",
      message: "Cancellation could not be verified. Check Messages for the latest status.",
    });
    showFailure({
      ...failure,
      displayMessage: `${failure.code}: ${failure.message} Check Messages for the latest status. Do not start another transaction until the current status is known.`,
      retryAllowed: false,
    });
  }
});
window.addEventListener("beforeunload", () => {
  stopped = true;
  stopTimers();
  sdk?.destroy();
});

if (isPreview) startPreview();
else void start();
