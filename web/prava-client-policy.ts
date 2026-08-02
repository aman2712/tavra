import type { CardValidationState, PravaError } from "@prava-sdk/core";

export const PRAVA_BROWSER_PROFILE_STORAGE_KEY = "prava_bpid";
export const PRAVA_BROWSER_PROFILE_HEADER = "X-Prava-Browser-Profile-Id";
export const PRAVA_POLL_INTERVAL_MS = 3_000;
export const PRAVA_POLL_TIMEOUT_MS = 90_000;

const BROWSER_PROFILE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface BrowserProfileStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export class BrowserProfileStorageError extends Error {
  readonly code = "BROWSER_STORAGE_UNAVAILABLE";

  constructor() {
    super(
      "This browser is blocking the storage Prava needs to recognize this device. Open the checkout in a normal Safari or Chrome window and allow site storage and third-party cookies.",
    );
    this.name = "BrowserProfileStorageError";
  }
}

/**
 * Creates one stable Prava device identifier per browser profile. If durable
 * storage is unavailable, checkout is blocked instead of burning a new card
 * network device binding on every page load.
 */
export function getOrCreateBrowserProfileId(
  storage: BrowserProfileStorage,
  randomUUID: () => string,
): string {
  try {
    const stored = storage.getItem(PRAVA_BROWSER_PROFILE_STORAGE_KEY)?.trim();
    if (stored && BROWSER_PROFILE_PATTERN.test(stored)) return stored;

    const created = randomUUID();
    if (!BROWSER_PROFILE_PATTERN.test(created)) throw new BrowserProfileStorageError();
    storage.setItem(PRAVA_BROWSER_PROFILE_STORAGE_KEY, created);
    if (storage.getItem(PRAVA_BROWSER_PROFILE_STORAGE_KEY) !== created) {
      throw new BrowserProfileStorageError();
    }
    return created;
  } catch (error) {
    if (error instanceof BrowserProfileStorageError) throw error;
    throw new BrowserProfileStorageError();
  }
}

export interface CheckoutEnvironment {
  userAgent: string;
  isSecureContext: boolean;
  platformAuthenticatorAvailable?: () => Promise<boolean>;
}

export interface CheckoutEnvironmentAssessment {
  ok: boolean;
  code?: string;
  message?: string;
}

export function isEmbeddedCheckoutUserAgent(userAgent: string): boolean {
  const ua = userAgent.trim();
  if (/Electron\/|\bCode\/|HeadlessChrome\/|;\s*wv\)|\bwv\b|FBAN\/|FBAV\/|Instagram\//i.test(ua)) {
    return true;
  }
  const isIOSWebKit = /iP(?:hone|ad|od).*AppleWebKit/i.test(ua);
  const isKnownIOSBrowser = /Safari\/|CriOS\/|FxiOS\/|EdgiOS\/|OPiOS\//i.test(ua);
  return isIOSWebKit && !isKnownIOSBrowser;
}

export async function assessCheckoutEnvironment(
  environment: CheckoutEnvironment,
): Promise<CheckoutEnvironmentAssessment> {
  const browserGuidance =
    "Open this checkout in a normal Safari or Chrome window on a device with Face ID, Touch ID, Windows Hello, or Android biometrics.";
  if (isEmbeddedCheckoutUserAgent(environment.userAgent)) {
    return {
      ok: false,
      code: "EMBEDDED_WEBVIEW_UNSUPPORTED",
      message: `Prava passkey approval cannot run inside an embedded app, editor, or headless webview. ${browserGuidance}`,
    };
  }
  if (!environment.isSecureContext) {
    return {
      ok: false,
      code: "SECURE_CONTEXT_REQUIRED",
      message: `Prava passkey approval requires HTTPS. ${browserGuidance}`,
    };
  }
  if (!environment.platformAuthenticatorAvailable) {
    return {
      ok: false,
      code: "PLATFORM_AUTHENTICATOR_UNAVAILABLE",
      message: `This browser cannot verify a platform passkey. ${browserGuidance}`,
    };
  }
  try {
    if (!(await environment.platformAuthenticatorAvailable())) {
      return {
        ok: false,
        code: "PLATFORM_AUTHENTICATOR_UNAVAILABLE",
        message: `This device does not have an available platform authenticator. ${browserGuidance}`,
      };
    }
  } catch {
    return {
      ok: false,
      code: "PLATFORM_AUTHENTICATOR_CHECK_FAILED",
      message: `Tavra could not confirm that this browser can complete a passkey approval. ${browserGuidance}`,
    };
  }
  return { ok: true };
}

export interface PravaFailurePresentation {
  code: string;
  message: string;
  displayMessage: string;
  title: string;
  retryAllowed: boolean;
  category:
    | "otp_expired"
    | "otp_incorrect"
    | "storage"
    | "device"
    | "binding"
    | "validation"
    | "rate_limited"
    | "transient"
    | "unknown";
}

interface FailureShape {
  code?: unknown;
  message?: unknown;
  error?: unknown;
}

function failureShape(value: unknown): FailureShape {
  if (value instanceof Error) {
    const withCode = value as Error & { code?: unknown };
    return { code: withCode.code, message: value.message };
  }
  if (!value || typeof value !== "object") {
    return { message: typeof value === "string" ? value : undefined };
  }
  const object = value as FailureShape;
  if (object.error && typeof object.error === "object") {
    const nested = object.error as FailureShape;
    return {
      code: nested.code ?? object.code,
      message: nested.message ?? object.message,
    };
  }
  return object;
}

/** Keeps Prava's exact code and message visible while adding actionable help. */
export function presentPravaFailure(
  value: unknown,
  fallback: { code?: string; message?: string } = {},
): PravaFailurePresentation {
  const shape = failureShape(value);
  const code =
    typeof shape.code === "string" && shape.code.trim()
      ? shape.code.trim()
      : fallback.code ?? "PRAVA_CHECKOUT_ERROR";
  const message =
    typeof shape.message === "string" && shape.message.trim()
      ? shape.message.trim()
      : typeof shape.error === "string" && shape.error.trim()
        ? shape.error.trim()
        : fallback.message ?? "Prava could not complete this checkout.";
  const searchable = `${code} ${message}`.toLowerCase();
  let category: PravaFailurePresentation["category"] = "unknown";
  let title = "Secure checkout needs attention";
  let guidance = "Return to Messages before starting another transaction.";
  let retryAllowed = false;

  if (/prava_status_timeout/i.test(searchable)) {
    title = "Approval status needs confirmation";
    guidance = "Return to Messages and do not start another transaction while Tavra reconciles this approval.";
  } else if (/(otp|one.?time|verification code).*(expired|timeout)|expired.*(otp|code)/i.test(searchable)) {
    category = "otp_expired";
    title = "Your verification code expired";
    guidance = "Request a new code inside Prava and use the newest code. Do not re-enter the expired code.";
    retryAllowed = true;
  } else if (/(otp|one.?time|verification code).*(incorrect|invalid)|incorrect.*(otp|code)/i.test(searchable)) {
    category = "otp_incorrect";
    title = "That verification code was not accepted";
    guidance = "Check the newest code and enter it again before it expires. If it has expired, request a new code.";
    retryAllowed = true;
  } else if (/(cookie|storage|securityerror|cross.?origin|iframe.*(?:load|init)|initiali[sz].*iframe)/i.test(searchable)) {
    category = "storage";
    title = "Browser privacy settings blocked Prava";
    guidance = "Open this checkout in a normal Safari or Chrome window, allow site storage and third-party cookies, and temporarily disable strict privacy extensions for this checkout.";
    retryAllowed = true;
  } else if (/(maximum.*binding|binding.*(?:limit|exceed)|token.*binding)/i.test(searchable)) {
    category = "binding";
    title = "This card cannot be bound to another device";
    guidance = "Do not retry or delete and re-add the card. Use another Prava test card assigned to this browser or contact Prava support.";
  } else if (/(passkey|platform authenticator|device.*not supported|browser.*not supported|webview|webauthn)/i.test(searchable)) {
    category = "device";
    title = "This browser cannot complete passkey approval";
    guidance = "Open the checkout in a normal Safari or Chrome window on a device with Face ID, Touch ID, Windows Hello, or Android biometrics.";
  } else if (/(card verification|invalid request|validation|malformed|val_[0-9]+)/i.test(searchable)) {
    category = "validation";
    title = "Prava rejected the checkout details";
    guidance = "Review the exact error below. Do not retry the same card or request unchanged.";
  } else if (/(rate.?limit|too many requests|\b429\b)/i.test(searchable)) {
    category = "rate_limited";
    title = "Status checks are temporarily limited";
    guidance = "Tavra will wait before checking this same transaction again. Do not start another transaction.";
    retryAllowed = true;
  } else if (/(network|fetch|temporar|timeout|\b50[0234]\b|service unavailable)/i.test(searchable)) {
    category = "transient";
    title = "The secure service is temporarily unreachable";
    guidance = "You can explicitly reload this same checkout. Tavra will not create or retry a transaction automatically.";
    retryAllowed = true;
  }

  return {
    code,
    message,
    displayMessage: `${code}: ${message} ${guidance}`,
    title,
    retryAllowed,
    category,
  };
}

type ExtendedCardValidationState = CardValidationState & {
  cardholderName?: { isEmpty: boolean; isValid: boolean };
};

/**
 * Prava owns the PCI form and its submit control. This mirrors its validation
 * signal without reading raw PAN, expiry, or CVV values in Tavra.
 */
export function isSecureCardFormComplete(state: CardValidationState): boolean {
  const extended = state as ExtendedCardValidationState;
  const fields = [state.cardNumber, state.expiry, state.cvv];
  if (extended.cardholderName) fields.push(extended.cardholderName as typeof state.cardNumber);
  return state.isComplete && fields.every((field) => !field.isEmpty && field.isValid);
}

export function pravaErrorValue(error: PravaError): { code: string; message: string } {
  return { code: error.code, message: error.message };
}
