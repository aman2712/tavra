import { PravaSDK, type CardValidationState, type PravaError } from "@prava-sdk/core";

import "./styles.css";

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

type PublicStatus =
  | { status: "pending" | "awaiting_result" }
  | {
      status: "completed";
      merchantOrderId: string;
      merchantOutcome: "simulated" | "live";
    }
  | { status: "reconciliation_required"; message: string }
  | { status: "failed"; message: string };

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
const paymentStatus = requiredElement<HTMLElement>("payment-status");
const timer = requiredElement<HTMLElement>("session-timer");
const retryButton = requiredElement<HTMLButtonElement>("retry-button");
const cancelButton = requiredElement<HTMLButtonElement>("cancel-button");
let sdk: PravaSDK | null = null;
let pollTimer: number | null = null;
let countdownTimer: number | null = null;
let observerTimer: number | null = null;
let frameObserver: MutationObserver | null = null;
let stopped = false;

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
  paymentStatus.textContent = state.isComplete
    ? "Ready for secure approval"
    : "Card details stay protected by Prava";
}

function showError(message: string): void {
  stopTimers();
  errorMessage.textContent = message;
  showOnly(errorState);
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
    if (remaining === 0) showError("This secure session expired. Ask Tavra for a fresh link.");
  };
  update();
  countdownTimer = window.setInterval(update, 1_000);
}

async function pollStatus(): Promise<void> {
  if (stopped) return;
  try {
    const response = await fetch(`/api/prava/checkouts/${encodeURIComponent(checkoutId)}/status`, {
      cache: "no-store",
    });
    if (!response.ok) throw new Error("Unable to verify approval status");
    const result = (await response.json()) as PublicStatus;
    if (result.status === "completed") {
      stopped = true;
      stopTimers();
      sdk?.destroy();
      showOnly(successState);
      return;
    }
    if (result.status === "failed") {
      showError(result.message || "Secure approval failed. Please try again.");
      return;
    }
    if (result.status === "reconciliation_required") {
      showError(result.message);
      return;
    }
  } catch {
    paymentStatus.textContent = "Reconnecting securely…";
  }
  pollTimer = window.setTimeout(pollStatus, 3_000);
}

async function start(): Promise<void> {
  stopped = false;
  stopTimers();
  sdk?.destroy();
  sdk = null;
  frame.removeAttribute("data-ready");
  showOnly(loadingState);
  try {
    const response = await fetch(
      `/api/prava/checkouts/${encodeURIComponent(checkoutId)}/session`,
      { cache: "no-store" },
    );
    const payload = (await response.json().catch(() => ({}))) as ClientSession & {
      error?: string;
    };
    if (!response.ok) throw new Error(payload.error || "This secure link is invalid or expired.");
    renderOrder(payload);
    startCountdown(payload.expiresAt);

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
      if (frame.querySelector("iframe")) markSecureFormReady();
    }, 5_000);

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
      onError: (error: PravaError) => showError(error.message),
    }).catch((error: unknown) => {
      showError(error instanceof Error ? error.message : "Unable to load the protected form");
    });
    void pollStatus();
  } catch (error) {
    showError(error instanceof Error ? error.message : "Unable to start secure checkout");
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
    iframeUrl: "https://preview.invalid",
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
    if (!response.ok || result.revoked !== true) {
      throw new Error("The payment state changed before cancellation completed.");
    }
    showError("This checkout was canceled. Return to Messages if you want a new link.");
  } catch (error) {
    showError(
      error instanceof Error
        ? `${error.message} Check Messages for the latest status.`
        : "Cancellation could not be verified. Check Messages for the latest status.",
    );
  }
});
window.addEventListener("beforeunload", () => {
  stopped = true;
  stopTimers();
  sdk?.destroy();
});

if (isPreview) startPreview();
else void start();
