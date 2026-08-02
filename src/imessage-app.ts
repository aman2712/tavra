import type { PravaProduct } from "./prava.js";
import type { ResolvedProductMedia } from "./product-media.js";

export interface IMessageAppIdentity {
  name: string;
  teamId: string;
  bundleId: string;
  appStoreId?: number;
}

export interface IMessageAppCardLayout {
  caption?: string;
  subcaption?: string;
  trailingCaption?: string;
  trailingSubcaption?: string;
  imageUrl?: string;
  imageTitle?: string;
  imageSubtitle?: string;
}

export interface IMessageAppCard {
  /** Internal correlation value. It is not serialized into the Linq card. */
  checkoutId: string;
  identity: IMessageAppIdentity;
  url: string;
  fallbackText: string;
  interactive: true;
  layout: IMessageAppCardLayout;
}

export interface IMessageAppCardUpdate {
  url: string;
  fallbackText: string;
  interactive: true;
  layout: IMessageAppCardLayout;
}

export type IMessageAppCardState =
  | "review"
  | "approval_pending"
  | "authorized"
  | "sandbox_validated"
  | "order_placed"
  | "failed"
  | "reconciliation_required";

const TEAM_ID = /^[A-Z0-9]{10}$/;
const BUNDLE_ID = /^(?!\.)(?!.*\.\.)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

export function validateIMessageAppIdentity(
  identity: IMessageAppIdentity,
): IMessageAppIdentity {
  if (!identity.name.trim() || identity.name.trim().length > 64) {
    throw new Error("Tavra Messages app name must contain 1 to 64 characters");
  }
  if (!TEAM_ID.test(identity.teamId)) {
    throw new Error("Tavra Messages Apple Team ID must be 10 uppercase characters");
  }
  if (!BUNDLE_ID.test(identity.bundleId) || identity.bundleId.length > 255) {
    throw new Error("Tavra Messages extension bundle ID is invalid");
  }
  if (
    identity.appStoreId !== undefined &&
    (!Number.isSafeInteger(identity.appStoreId) || identity.appStoreId <= 0)
  ) {
    throw new Error("Tavra Messages App Store ID must be a positive integer");
  }
  return {
    name: identity.name.trim(),
    teamId: identity.teamId,
    bundleId: identity.bundleId,
    ...(identity.appStoreId === undefined
      ? {}
      : { appStoreId: identity.appStoreId }),
  };
}

function totalQuantity(products: readonly PravaProduct[]): number {
  return products.reduce((sum, product) => sum + product.quantity, 0);
}

function firstMedia(
  media: readonly ResolvedProductMedia[],
): ResolvedProductMedia | undefined {
  return media[0];
}

function compactLabel(
  value: string | undefined,
  maximum: number,
): string | undefined {
  const normalized = value
    ?.replace(/[—–]/g, "-")
    .replace(/--+/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return undefined;
  return normalized.length <= maximum
    ? normalized
    : `${normalized.slice(0, maximum - 1).trimEnd()}\u2026`;
}

function cardStateLabel(
  state: IMessageAppCardState,
): string {
  switch (state) {
    case "review":
      return "Review, not purchased";
    case "approval_pending":
      return "Approval pending";
    case "authorized":
      return "Authorized, confirming order";
    case "sandbox_validated":
      return "Expected decline recorded";
    case "order_placed":
      return "Order placed";
    case "failed":
      return "No order confirmed";
    case "reconciliation_required":
      return "Order status under review";
  }
}

export function createCheckoutIMessageAppCard(input: {
  identity: IMessageAppIdentity;
  checkoutId: string;
  approvalUrl: string;
  totalAmount: string;
  currency: string;
  products: readonly PravaProduct[];
  productMedia: readonly ResolvedProductMedia[];
  /** Merchant and variant are optional so existing sandbox callers remain valid. */
  merchantName?: string;
  primaryVariant?: string;
  state?: IMessageAppCardState;
}): IMessageAppCard {
  const identity = validateIMessageAppIdentity(input.identity);
  const count = totalQuantity(input.products);
  const media = firstMedia(input.productMedia);
  const imageUrl = media?.url;
  const state = input.state ?? "review";
  const merchantName = compactLabel(
    input.merchantName ??
      (media?.source.kind === "official_merchant_asset"
        ? media.source.label
        : undefined),
    64,
  );
  const primaryProduct = input.products[0];
  const primaryVariant = compactLabel(input.primaryVariant, 90);
  const productLabel = compactLabel(
    primaryVariant ?? primaryProduct?.description,
    100,
  );
  return {
    checkoutId: input.checkoutId,
    identity,
    url: input.approvalUrl,
    fallbackText: "Open secure Tavra approval",
    interactive: true,
    layout: {
      caption: merchantName ?? "Tavra recovery",
      subcaption:
        productLabel ??
        `${count} ${count === 1 ? "item" : "items"} ready for review`,
      trailingCaption: `${input.currency} ${input.totalAmount}`,
      trailingSubcaption: cardStateLabel(state),
      ...(imageUrl
        ? {
            imageUrl,
            imageTitle: compactLabel(
              primaryProduct?.description ?? media?.lineItemDescription,
              100,
            ),
            imageSubtitle:
              merchantName ?? `${count} ${count === 1 ? "item" : "items"}`,
          }
        : {}),
    },
  };
}

export function createCheckoutIMessageAppUpdate(input: {
  approvalUrl: string;
  totalAmount: string;
  currency: string;
  status:
    | "completed"
    | "sandbox_validated"
    | "failed"
    | "reconciliation_required";
  merchantOutcome:
    | "simulated"
    | "sandbox_merchant"
    | "live"
    | "not_attempted";
  productMedia: readonly ResolvedProductMedia[];
  merchantName?: string;
  primaryVariant?: string;
  merchantOrderId?: string | null;
}): IMessageAppCardUpdate {
  const media = firstMedia(input.productMedia);
  const imageUrl = media?.url;
  const completed = input.status === "completed";
  const sandboxValidated = input.status === "sandbox_validated";
  const state: IMessageAppCardState = sandboxValidated
    ? "sandbox_validated"
    : completed
      ? "order_placed"
      : input.status === "reconciliation_required"
        ? "reconciliation_required"
        : "failed";
  const merchantName = compactLabel(
    input.merchantName ??
      (media?.source.kind === "official_merchant_asset"
        ? media.source.label
        : undefined),
    64,
  );
  const caption = sandboxValidated
    ? merchantName ?? "Merchant checkout tested"
    : completed
      ? input.merchantOutcome === "live"
        ? merchantName ?? "Merchant order confirmed"
        : "Approval complete"
      : input.status === "reconciliation_required"
        ? "Approval needs review"
        : "Approval not completed";
  const subcaption = sandboxValidated
    ? "Approval complete, checkout attempted"
    : completed
      ? input.merchantOutcome === "live"
        ? "Open for the latest fulfillment status"
        : "Order placed"
      : input.status === "reconciliation_required"
        ? "No order is being claimed"
        : "Nothing was ordered by Tavra";
  const primaryVariant = compactLabel(input.primaryVariant, 90);
  return {
    url: input.approvalUrl,
    fallbackText: "Tavra approval status",
    interactive: true,
    layout: {
      caption,
      subcaption:
        primaryVariant ??
        (input.merchantOrderId && input.merchantOutcome === "live"
          ? `Order ${compactLabel(input.merchantOrderId, 48)}`
          : subcaption),
      trailingCaption: `${input.currency} ${input.totalAmount}`,
      trailingSubcaption: cardStateLabel(state),
      ...(imageUrl
        ? {
            imageUrl,
            imageTitle: compactLabel(media?.lineItemDescription, 100),
            imageSubtitle: merchantName,
          }
        : {}),
    },
  };
}
