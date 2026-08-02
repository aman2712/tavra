# Prava and live commerce audit

Verified on August 2, 2026 against the Tavra repository and Prava's public
Agentic Commerce documentation. Repository support and external proof are listed
separately so that an implemented integration is never presented as a completed
merchant order.

## Current decision

Tavra now has a server-side Prava MCP commerce integration for UCP product
discovery and Browser Harness checkout. Live mode is the primary implementation.
The legacy catalog remains available only as a visibly labeled, explicitly
selected rehearsal and is never an automatic fallback. In sandbox mode its
basket and price are illustrative for any retained destination; live inventory,
fulfillment, and delivery timing remain explicitly unverified.

The native recovery review stays inside the Tavra Messages extension. The user
then completes Prava and card-network verification in `SFSafariViewController`.
The accurate product statement is:

> Review the exact live order inside Messages, then approve it on Prava's trusted
> payment surface. Tavra updates the same card and chat after merchant checkout.

Do not claim that card entry, passkey verification, or Visa verification takes
place inside a mutable iMessage bubble.

## Implemented live call sequence

The provider implements the documented Prava chain:

```text
shop_search
-> shop_product
-> shop_quote
-> create_payment_session
-> get_payment_status
-> shop_checkout
```

Only `shop_checkout` creates an order. Payment approval by itself changes the
Tavra state to authorized, not ordered. Tavra stores a merchant order ID only
when checkout returns one with the exact approved amount.

The implementation provides:

- OAuth-linked Streamable HTTP access to `https://mcp.pay.prava.space/mcp`.
- Required-scope checks for `payments:read`, `payments:write`, and
  `checkout:run` before discovery begins.
- Typed operations for health, addresses, search, product detail, quote,
  payment session, payment status, and checkout.
- Deterministic category order: confirmed-size T-shirt, toiletries fallback,
  then trousers only when waist and inseam are both known.
- Exact variant matching, availability checks, UCP HTTPS image binding, and
  rejection of unsupported or incomplete offers.
- Quote validation for product, variant, address, currency, subtotal, shipping,
  tax, total, expiry, and the AED 250 or USD 68 ceiling.
- Separate user authorization records for the offer and address-bound estimate.
- One checkout idempotency key and no blind retry after an unknown outcome.
- Durable SQLite workflow, card mapping, Linq event revision, and notification
  outbox state.
- Merchant order evidence added to the recovery case without fabricating an
  itemized receipt, dispatch event, delivery event, airline submission, or
  employer reimbursement.

Primary references:

- [Prava MCP connection](https://docs.prava.space/mcp/connect)
- [Prava MCP tools](https://docs.prava.space/mcp/tools)
- [Prava UCP integration](https://docs.prava.space/integration/ucp)
- [Prava Browser Harness](https://docs.prava.space/integration/browser-harness)

## One-time OAuth and access gate

Run this from the Tavra repository on macOS:

```bash
npm run prava:link-commerce
```

The linker discovers Prava's OAuth metadata, dynamically registers the local
client, uses PKCE S256, requests the three required scopes, opens the browser,
and stores the resulting token set in macOS Keychain. It never writes OAuth
tokens to `.env` or Git.

After sign-in, the command verifies `ping`, `list_agents`,
`shop_list_addresses`, `shop_search`, and, when search returns a candidate,
`shop_product`. It intentionally does not request a quote, create a payment
session, or place an order.

Enable live commerce only after linking:

```dotenv
TAVRA_COMMERCE_MODE=live
PRAVA_MCP_URL=https://mcp.pay.prava.space/mcp
```

Then start Tavra and inspect the access gate:

```bash
npm run dev:imessage
curl https://your-public-tunnel.example/health/commerce
```

The access gate returns HTTP 200 with `status: "ready"` when the required scopes,
`ping`, and `list_agents` calls succeed. The demo acceptance rule additionally
requires `connectedAgents` to be at least one. An unlinked account, an expired
token that cannot refresh, a missing scope, or MCP failure returns HTTP 503 and
blocks discovery.

## Address prerequisite

A typed address or Linq location share is only a proposal. Tavra requires the
traveler to confirm the exact building, hotel, room, unit, desk, or front-desk
instruction before quoting.

The confirmed destination must match a saved address in the linked Prava
account. Tavra receives and stores the Prava address ID plus a masked summary;
the full address is not sent to OpenAI, placed in card URLs, or exposed through
the public checkout summary.

If the MBZUAI or other Abu Dhabi address is not already present, add it through
an approved Prava address surface or API before the demo. Use Prava's accepted
UAE address format. Do not invent a UAE postal code. A missing address match is
a setup blocker, not permission to substitute Boston or construct address data.

## Live quote and approval boundary

Discovery does not spend money. Tavra first presents the actual merchant,
product, exact variant, and UCP image. The user must explicitly approve that
offer before `shop_quote` is called.

The returned quote is then shown with:

- masked destination
- subtotal, shipping, tax, currency, and total
- quote expiry
- delivery option and ETA when Prava verifies them
- employee allowance when its currency matches the quote
- a clear `Not purchased yet` state

If the live ETA misses the requested deadline, Tavra asks whether to relax the
deadline. If Prava returns no ETA, Tavra labels delivery timing unverified. It
never converts an estimate into an 8 AM promise.

The user must explicitly approve the unchanged quote before Tavra calls
`create_payment_session`. A real payment card must not be used until the exact
merchant, item, variant, address summary, delivery information, and total are
visible and accepted.

## Messages card and trusted payment surface

The live Linq `imessage_app` bubble carries one selected product rather than
three separate illustrative images. It shows the UCP merchant image, merchant,
variant, total, and current state. Opening it renders a native itemized review.

The extension fetches the merchant image only through this same-origin route:

```text
/api/prava/checkouts/{checkoutId}/products/0/image
```

The proxy accepts the exact image stored with the selected UCP offer, refuses
redirects and private hosts, validates the content type, and enforces a size
limit. A missing or invalid image is suppressed rather than replaced with
synthetic artwork.

`SFSafariViewController` opens Tavra's short approval URL, which redirects to
the exact Prava payment URL stored for that checkout. The extension keeps
polling Tavra's sanitized status endpoint, dismisses the secure modal after a
terminal result, and renders the merchant result. Tavra does not use
`WKWebView`, cannot inspect the protected ceremony, and cannot remove an issuer
or Visa verification page that Prava requires.

## Checkout and restart behavior

After Prava reports completed approval, Tavra calls `shop_checkout` exactly
once with the stored quote, payment session, purchase authorization, and stable
idempotency key.

Terminal states are distinct:

- `authorized`: Prava approval completed, but no merchant order is claimed yet.
- `ordered`: Browser Harness returned a real merchant order ID and matching
  amount.
- `reconciliation_required`: checkout may have started, but its outcome is not
  independently known. Tavra blocks retry and claims no order.
- `failed` or `canceled`: Tavra claims no order.
- `dispatched` and `delivered`: reserved for later merchant evidence. They are
  not inferred from checkout completion.

If Tavra restarts while approval is pending, polling resumes. If it restarts
after checkout began but before the result was saved, the workflow enters
`reconciliation_required`. The server does not repeat checkout or fall back to
the sandbox.

## Runtime truth boundary

| `TAVRA_COMMERCE_MODE` | Allowed behavior | Required user-facing truth |
|---|---|---|
| `live` | OAuth Prava MCP, UCP offer, live quote, Prava approval, Browser Harness checkout | Claim an order only with the returned merchant order ID. |
| `sandbox` | Meddu UAE UCP product discovery, address-bound AED total, purchase-specific Prava approval, one-time card, and one reviewed merchant checkout attempt | Show the expected sandbox-card decline and Prava outcome report. Claim no order or incurred expense. |
| `disabled` | No product quote, payment session, or checkout | State that commerce is unavailable. |

No code path may silently move a live Abu Dhabi case to the Boston sandbox. If
UCP cannot quote Abu Dhabi, keep the recovery and claim evidence in Abu Dhabi.
A separate supported-market live proof requires the user's explicit approval of
that different address.

## External blockers and unverified facts

The repository contains the integration, but the following remain external
until preserved evidence proves them:

1. The team's Prava account grants all required MCP scopes and exposes a
   connected commerce agent.
2. A valid MBZUAI or Abu Dhabi delivery address exists in Prava using an
   accepted UAE address convention.
3. A participating UCP merchant returns an orderable product and live quote for
   that address.
4. The selected payment instrument is valid for that live merchant. The Prava
   sandbox test card must not be assumed to work for a real merchant.
5. Browser Harness returns a real merchant order ID for the approved amount.
6. The merchant returns an itemized receipt, dispatch, and delivery evidence.
7. A physical iPhone completes the native card, Prava approval, same-card
   mutation, same-chat message, and recovery-evidence sequence.

Until items 1 through 5 are observed in one controlled run, describe the code
as live-commerce capable, not as proof that Tavra has placed a live order.

## Acceptance checklist

- [ ] `npm run prava:link-commerce` completes and prints no token or address.
- [ ] `/health/commerce` returns HTTP 200, no missing scopes, and a connected agent.
- [ ] Prava lists the intended masked delivery address without a fabricated postal code.
- [ ] UCP returns an available exact variant with an HTTPS merchant image.
- [ ] The user approves the offer before quoting.
- [ ] The quote is bound to that product, variant, address ID, currency, and total.
- [ ] Total is at or below AED 250 or USD 68.
- [ ] Delivery timing is shown as verified, late, or unverified without embellishment.
- [ ] The native card shows the selected merchant image, variant, quote, and destination summary.
- [ ] The user approves the exact unchanged quote before Prava payment begins.
- [ ] Prava approval alone is not displayed as an order.
- [ ] One `shop_checkout` call returns a real merchant order ID, or Tavra enters a truthful failure state.
- [ ] The original app card and same chat update with the same outcome.
- [ ] The recovery case contains the merchant order evidence and leaves receipt verification pending unless a receipt exists.
- [ ] A restart and duplicate Linq event do not repeat checkout or send a stale reply.
- [ ] Redacted logs and a physical-iPhone recording preserve the final proof.
