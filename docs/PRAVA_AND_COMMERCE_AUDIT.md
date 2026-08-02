# Prava and live commerce audit

Verified on August 2, 2026 against Tavra's installed package, Prava's public
documentation, the published OpenAPI document, and the current Tavra code.

## Decision for the hackathon build

Keep the native recovery-kit review inside the Tavra Messages extension. Present
Prava in `SFSafariViewController` for the protected payment ceremony. Describe
this accurately as:

> Review and approve from the Messages experience, with card-network
> verification on its own trusted surface.

Do not claim that card entry, passkey verification, or Visa verification stays
inside an iMessage bubble.

## Why the Visa page is visible

Prava documents the card-network page as an intentional trust boundary. On a new
device, the user completes issuer OTP and then passkey registration. On a
returning device, the user verifies the existing passkey. That passkey step is
hosted by the card network, not by Tavra or Prava.

Tavra currently uses hosted checkout. Its payment page redirects to the exact
Prava `iframe_url`, and the Messages extension presents the Tavra URL in a modal
`SFSafariViewController`. This keeps the journey visually attached to Messages,
but the verified origin is allowed to change to Prava or the card network.

Prava also supports an embedded card iframe. Embedded mode can keep the initial
card form inside Tavra's web page, but it does not remove the card-network
verification handoff. The published `@prava-sdk/core` version is still `0.1.2`.
That runtime handles `PRAVA_REDIRECT` as top-level navigation and does not expose
a redirect override or native passkey API. A `WKWebView` therefore cannot be
used to promise a Tavra-controlled end-to-end ceremony. Prava would also need
to certify the WebAuthn relying-party and Associated Domains path for Tavra's
signed Messages extension.

Primary references:

- [Prava integration modes](https://docs.prava.space/sdk/integration-modes)
- [Prava checkout verification sequence](https://docs.prava.space/concepts/checkout-flow)
- [Apple SFSafariViewController](https://developer.apple.com/documentation/safariservices/sfsafariviewcontroller/)

## What is already low-friction

- Tavra lists the employee's saved cards server-side and preselects the default
  active card when one exists.
- The user reviews all recovery items in one native Messages panel.
- The user performs one explicit secure approval.
- Tavra polls payment status, reconciles the merchant result, updates the same
  chat, and mutates the original app card.

## Future lower-friction approval

Prava's current public REST documentation includes standing mandates. A user can
approve a merchant, amount cap, frequency, validity window, and charge count
once with a passkey. Later charges within those exact constraints can mint a
single-use merchant-scoped credential without another passkey.

This is a good later design for employer-approved travel recovery, but Tavra does
not implement it yet. It must be presented as an explicit bounded mandate, not
as silent payment permission.

- [Prava mandates](https://docs.prava.space/concepts/mandates)
- [Charge a mandate](https://docs.prava.space/api-reference/mandate-charge)

## Real products and merchants

Prava's public Agentic Commerce documentation now describes a real commerce
pipeline:

1. UCP searches participating Shopify catalogs and returns products, variants,
   availability, price estimates, and merchant images.
2. A quote opens a checkout for the selected variant and delivery destination.
3. Browser Harness reconciles subtotal, shipping, and tax against the live
   Shopify checkout.
4. The harness uses Prava's single-use merchant-scoped credential and returns a
   real order ID and status.

This means real merchants and products are possible on the Prava platform.
Coverage is currently Shopify and participating UCP merchants, and pricing must
remain an estimate until the live checkout is reconciled.

However, Tavra does not use that pipeline today. The current public Prava REST
OpenAPI exposes payments and mandates, but not UCP search, quote, or Browser
Harness endpoints. Those commerce capabilities are documented through Prava Pay
CLI and MCP. Tavra therefore needs one of the following before replacing its
demo catalog:

- Prava grants Tavra application access to its Agentic Commerce API or a
  supported server-side MCP integration.
- Tavra links a dedicated Prava agent account and integrates the documented MCP
  shopping tool chain.
- Tavra builds its own allowlisted merchant adapters, then uses Prava only for
  payment authorization and one-time credentials.

Primary references:

- [Prava Agentic Commerce](https://docs.prava.space/integration/overview)
- [Prava UCP integration](https://docs.prava.space/integration/ucp)
- [Prava Browser Harness](https://docs.prava.space/integration/browser-harness)
- [Prava MCP tool chain](https://docs.prava.space/mcp/tools)
- [Prava go-live checklist](https://docs.prava.space/guides/go-live-checklist)

## Required Tavra production changes

1. Replace the static Senso demo catalog with UCP or verified merchant search.
2. Carry the exact merchant, SKU, variant, image, inventory state, quote expiry,
   shipping option, tax, and final total through the approval record.
3. Save delivery addresses in a private address vault and show only masked
   summaries until exact confirmation is required.
4. Create the Prava session only after the live quote is locked.
5. Execute exactly one merchant checkout with durable idempotency.
6. Persist the real order ID, receipt, ETA, tracking, cancellation, refund, and
   reimbursement evidence.
7. Report every approved or declined merchant outcome back to Prava.

## Current truth boundary

The current Tavra server uses a synthetic Boston catalog and
`createSandboxMerchantCheckoutAdapter`. It produces a genuine Prava sandbox
approval, but it does not create a live merchant order, charge, dispatch, or
delivery. Live mode correctly refuses to start without a real merchant adapter.
