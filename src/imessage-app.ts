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

function firstImage(media: readonly ResolvedProductMedia[]): string | undefined {
  return media[0]?.url;
}

export function createCheckoutIMessageAppCard(input: {
  identity: IMessageAppIdentity;
  checkoutId: string;
  approvalUrl: string;
  totalAmount: string;
  currency: string;
  products: readonly PravaProduct[];
  productMedia: readonly ResolvedProductMedia[];
}): IMessageAppCard {
  const identity = validateIMessageAppIdentity(input.identity);
  const count = totalQuantity(input.products);
  const imageUrl = firstImage(input.productMedia);
  return {
    checkoutId: input.checkoutId,
    identity,
    url: input.approvalUrl,
    fallbackText: "Open secure Tavra approval",
    interactive: true,
    layout: {
      caption: "Tavra recovery",
      subcaption: `${count} ${count === 1 ? "item" : "items"} ready for review`,
      trailingCaption: `${input.currency} ${input.totalAmount}`,
      trailingSubcaption: "Secure approval",
      ...(imageUrl
        ? {
            imageUrl,
            imageTitle: "Recovery essentials",
            imageSubtitle: "Review inside Messages",
          }
        : {}),
    },
  };
}

export function createCheckoutIMessageAppUpdate(input: {
  approvalUrl: string;
  totalAmount: string;
  currency: string;
  status: "completed" | "failed" | "reconciliation_required";
  merchantOutcome: "simulated" | "live" | "not_attempted";
  productMedia: readonly ResolvedProductMedia[];
}): IMessageAppCardUpdate {
  const imageUrl = firstImage(input.productMedia);
  const completed = input.status === "completed";
  const caption = completed
    ? input.merchantOutcome === "live"
      ? "Merchant order confirmed"
      : "Sandbox approval complete"
    : input.status === "reconciliation_required"
      ? "Approval needs review"
      : "Approval not completed";
  const subcaption = completed
    ? input.merchantOutcome === "live"
      ? "Open for the latest fulfillment status"
      : "No live merchant order was created"
    : input.status === "reconciliation_required"
      ? "No order is being claimed"
      : "Nothing was ordered by Tavra";
  return {
    url: input.approvalUrl,
    fallbackText: "Tavra approval status",
    interactive: true,
    layout: {
      caption,
      subcaption,
      trailingCaption: `${input.currency} ${input.totalAmount}`,
      trailingSubcaption: "Status updated",
      ...(imageUrl ? { imageUrl } : {}),
    },
  };
}
