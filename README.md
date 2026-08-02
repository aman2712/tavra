# Tavra

Tavra is a message-native travel recovery service. This vertical slice is
deliberately focused: when the configured Linq number receives text or a supported
image over iMessage, Tavra resolves the sender through a private exact mapping,
retrieves that employee's allowlisted company context from Senso, and uses
OpenAI for interpretation and natural language. Deterministic services own the
recovery state, live product selection, quote validation, approval, checkout,
and evidence record.

## What is implemented

- Linq Partner API V3 and the pinned `2026-02-03` webhook format.
- Standard Webhooks signature verification using Linq's official SDK.
- iMessage-only handling: SMS and RCS events are ignored.
- Exact E.164 sender resolution through a private, gitignored identity map.
- Intent-aware message harness with separate social, capability, profile,
  policy, active-recovery, and out-of-scope routes.
- Fast-path greetings that never retrieve company context, plus a low-cost
  structured OpenAI router for ambiguous messages.
- Strictly scoped Senso context retrieval using explicit employee and policy
  content IDs selected for the current intent; out-of-scope results fail closed.
- OpenAI Responses API generation grounded in the retrieved context, with no
  model tools or web access.
- Durable per-chat conversation revisions and recovery state in a
  permission-restricted SQLite database. Duplicate Linq events are ignored,
  chat work is serialized, and late asynchronous replies are dropped if a newer
  turn has advanced the case.
- An evidence-bound delayed-baggage flow that first asks what help is wanted,
  where it is needed, and by when. Saved sizes are shown only after replacement
  essentials are requested, and product sourcing waits for explicit confirmation.
- Exact delivery-address confirmation before checkout. A recent Linq location
  share can propose an address, but Tavra never treats location permission as a
  deliverable address or purchase consent.
- Multimodal baggage-notice intake for trusted Linq-hosted PNG, JPEG, WebP, and
  still-GIF files up to 15 MB. OpenAI extracts visible incident facts into a
  strict schema, and Tavra asks the employee to confirm them before use.
- A Prava MCP commerce provider for UCP discovery, exact variant inspection,
  address-bound quotes, Prava payment sessions, status polling, and Browser
  Harness checkout. The deterministic selector searches a confirmed T-shirt
  size first, toiletries second, and trousers only when both measurements exist.
- Exact live merchant image, variant, masked destination, delivery information,
  quote expiry, subtotal, shipping, tax, and total in one mutable Linq
  `imessage_app` card. Merchant images are fetched through a checkout-scoped
  same-origin proxy and are suppressed if they fail the HTTPS and content checks.
- Separate explicit confirmations for the selected live offer and its exact
  address-bound quote. The all-in cap is AED 250 or USD 68. A missing or
  unverified delivery estimate is shown honestly and never converted into a
  promised deadline.
- A native Apple Wallet-like review in the signed Tavra Messages extension.
  Prava and Visa verification remain in `SFSafariViewController`, which preserves
  their trusted origin instead of exposing protected payment UI to Tavra.
- Server-only payment polling followed by exactly one `shop_checkout` call after
  Prava approval. Payment approval alone is not treated as an order. Unknown
  checkout outcomes enter `reconciliation_required` and block blind retries.
- Explicit runtime isolation. `TAVRA_COMMERCE_MODE=live` uses OAuth-linked Prava
  MCP commerce. `sandbox` discovers an actual UAE merchant product, creates a
  purchase-specific Prava approval, retrieves the one-time credential, attempts
  the reviewed end-merchant checkout once, and records the expected test-card
  decline. `disabled` performs no commerce. Tavra never silently changes modes.
- Durable SQLite commerce workflows, checkout-to-card mappings, notification
  outbox, and Linq event revisions. A separate permission-restricted recovery
  ledger stores the confirmed incident, selected merchant variant, quote,
  sanitized payment state, merchant order evidence, and claim packet state.
- A permission-restricted JSONL recovery ledger containing the confirmed
  incident, delivery address, planned items, sanitized payment state,
  fulfillment truth disclosure, claim evidence, actual expenses, versioned
  claim packets, explicit handoff authorization, and externally confirmed
  submission references.
- Recovery replies use a short human lead-in, one fact per plain-text bullet,
  and one natural next-step question so they remain scannable in iMessage.
- Strict structured extraction for short recovery replies plus deterministic
  response contracts that prevent early option disclosure, rejected-candidate
  selection, unsupported purchase claims, internal labels, and em dashes.
- Same-chat text reply with a deterministic Linq idempotency key.
- Persistent inbound event and attachment deduplication in `data/tavra.sqlite`.
- A webhook setup command scoped to the configured Linq phone number.
- Health endpoints and structured logs without message bodies or phone numbers.

## Requirements

- Node.js 22 or newer.
- A Linq Partner API V3 token and provisioned iMessage number.
- An OpenAI API key with API billing enabled.
- A Senso API key and a populated private identity map.
- A Prava account authorized for the MCP commerce scopes `payments:read`,
  `payments:write`, and `checkout:run` for live commerce.
- macOS Keychain and a browser for the current one-time Prava OAuth linker.
- Prava sandbox publishable and secret keys for the end-to-end sandbox
  capability check.
- Playwright Chromium for the server-side end-merchant checkout attempt.
- A public HTTPS URL forwarding to the local port. The current setup uses a
  Microsoft dev tunnel.

### Product media

Merchant-backed modes accept only the exact HTTPS image returned with the
selected UCP offer. The UAE sandbox path allowlists the reviewed Shopify CDN and
never substitutes generated artwork. Redirects, private hosts, unsafe content
types, oversized files, and missing images are rejected.

The following local assets exist only for the explicitly selected sandbox mode:

- `web/public/products/b-shirt-001.png`
- `web/public/products/b-trouser-001.png`
- `web/public/products/b-toiletry-001.png`

Vite publishes them at the matching
`/checkout-assets/products/<filename>` paths. The existing
`recovery-bundle.png` is reserved for the single aggregate fallback line item;
it is never substituted for one of the three SKU images. Demo imagery is always
captioned as illustrative and is not merchant SKU evidence.
They must never be shown as evidence for a live merchant product.

## Configure

Copy `.env.example` to `.env` and set:

```dotenv
LINQ_API_KEY=...
LINQ_MODE=live
LINQ_FROM_NUMBER=+12025551234
LINQ_WEBHOOK_SECRET=...
PUBLIC_BASE_URL=https://your-public-tunnel.example
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5-mini
OPENAI_ROUTER_MODEL=gpt-4o-mini
SENSO_API_KEY=...
SENSO_BASE_URL=https://apiv2.senso.ai/api/v1/
SENSO_IDENTITY_MAP_PATH=senso/demo-config/identity-map.local.json
# Live commerce is disabled until OAuth linking and address setup are complete.
TAVRA_COMMERCE_MODE=disabled
PRAVA_MCP_URL=https://mcp.pay.prava.space/mcp
# Set these only after installing the signed Tavra Messages extension.
TAVRA_MESSAGES_APP_TEAM_ID=
TAVRA_MESSAGES_APP_BUNDLE_ID=com.yourcompany.tavra.MessagesExtension
TAVRA_MESSAGES_APP_NAME=Tavra
PORT=3000
```

The end-to-end sandbox path needs `PRAVA_API_KEY`,
`PRAVA_SECRET_KEY`, `PRAVA_MODE=sandbox`, `PRAVA_BACKEND_URL`, and
`PRAVA_CHECKOUT_MODE`. Live MCP commerce uses the OAuth token stored in Keychain
and does not require those SDK credentials.

`OPENAI_MODEL` is optional and defaults to the cost-efficient `gpt-5-mini`.
`OPENAI_ROUTER_MODEL` defaults to `gpt-4o-mini`; exact greetings bypass it.
Secret keys remain server-side and are never sent through Linq or included in
logs. The identity map is also gitignored and must never be uploaded to Senso.
The sandbox approval page receives only the Prava publishable key, short-lived
session token, and trusted iframe URL. In live mode, the native card receives a
sanitized Tavra summary and the short Tavra approval URL redirects to the exact
server-stored Prava payment target. MCP OAuth tokens never reach the extension,
browser, chat, or public summary.

`PRAVA_MODE` configures the Prava SDK path. `TAVRA_COMMERCE_MODE` selects
the commerce runtime and is the authoritative live-versus-sandbox switch. Never
set the commerce runtime to `sandbox` as a fallback for an unavailable live
merchant.

Never commit `.env`. When a subscription is created by the setup command, its
one-time signing secret is saved to `.env` without being printed.

### One-time Prava live-commerce setup

The linker uses OAuth 2.1 discovery, dynamic client registration, PKCE, and the
three required commerce scopes. It stores the resulting token set in macOS
Keychain under `space.tavra.prava-mcp`, not in `.env` or Git.

```bash
npm run prava:link-commerce
```

The command opens Prava sign-in, verifies `ping`, `list_agents`,
`shop_list_addresses`, `shop_search`, and, when a result exists, `shop_product`.
It does not request a quote, create a payment session, or place an order.

Before enabling live mode, the linked Prava account must contain a delivery
address for the destination you will test. Tavra compares the user-confirmed
address with Prava's masked saved-address summaries and quotes only against the
selected Prava address ID. Add the address through an approved Prava surface or
API using Prava's accepted UAE address format. Do not invent a postal code for
MBZUAI, Masdar City, or any UAE destination.

After linking and confirming that the masked address appears, set:

```dotenv
TAVRA_COMMERCE_MODE=live
PRAVA_MCP_URL=https://mcp.pay.prava.space/mcp
```

Start Tavra and verify the access gate:

```bash
npm run dev:imessage
curl https://your-public-tunnel.example/health/commerce
```

A ready response reports `status: "ready"`, live mode, and no missing scopes.
For the live demo, also require `connectedAgents` to be at least one. A 503
response is a hard stop for live commerce. Relink if scopes or tokens are
missing. Add or select a valid saved address if discovery cannot match the
confirmed destination.

## Run

```bash
npm install
npm run typecheck
npm test
npm run dev:imessage
```

`dev:imessage` starts Tavra and the saved VS Code-compatible public tunnel in one
terminal. Configure the Linq subscription once before the first message test:

```bash
npm run linq:subscriptions
npm run linq:subscribe
```

### Scripted VS Code port forwarding

VS Code's Ports view uses Microsoft Dev Tunnels. To host the existing
`PUBLIC_BASE_URL` from a script, install and authenticate the matching CLI once:

```bash
brew install --cask devtunnel
devtunnel user login -g
```

Then start Tavra and its existing public port forward together:

```bash
npm run dev:imessage
```

To verify the saved tunnel mapping without starting the server or tunnel:

```bash
npm run tunnel:vscode:check
```

This supervises both long-running processes in one terminal. Pressing Ctrl+C
stops both, and if either process fails the other is shut down as well.

The tunnel script validates that the hostname and `PORT` match, resolves VS
Code's public hostname to the authenticated account's actual tunnel ID, and
hosts it with anonymous access because LINQ webhooks cannot complete an
interactive tunnel login. Keep the webhook signature enabled: the public route
is reachable by anyone who knows its URL, while Tavra accepts only requests
signed with `LINQ_WEBHOOK_SECRET`.

`linq:subscribe` creates or updates this target:

```text
https://your-public-tunnel.example/webhooks/linq?version=2026-02-03
```

It subscribes to `message.received`, `location.sharing.started`, and
`location.sharing.stopped`, and filters events to
`LINQ_FROM_NUMBER`.

## Verify from Messages

1. Start Tavra and the tunnel with `npm run dev:imessage`.
2. Confirm `https://your-public-tunnel.example/health` returns `{"status":"ok"}`.
3. From an iMessage-capable Apple account, send a short travel question to the
   provisioned Linq number.
4. The same blue-bubble thread should receive a concise reply grounded in the
   matched employee profile and company policy.

### Standalone payment UI preview

To inspect the payment page without Tavra, Senso, Linq, or a live Prava session:

```bash
npm run preview:payment
```

This opens a localhost-only design preview with realistic recovery details and
a clearly disabled representation of the protected Prava form. Press Ctrl+C to
stop it. No card data is accepted and no sandbox transaction is created.

Useful local checks:

```bash
curl http://localhost:3000/health
npm run smoke:openai
npm run smoke:senso-openai
npm run smoke:prava
npm run smoke:webhook
npm run build
npm run test:ios
```

`smoke:openai` makes one small Responses API request without using Linq.
`smoke:senso-openai` performs the complete greeting, context triage, size
confirmation, option review, exact-address confirmation, incident correction,
email confirmation, and checkout-card authorization flow through real scoped
Senso and OpenAI without sending an iMessage or creating a real Prava session.
`smoke:prava` creates one sandbox session with synthetic identity data, validates
the browser-safe handoff, and immediately revokes the session.

In live mode, Tavra follows Prava's documented sequence:
`shop_search -> shop_product -> shop_quote -> create_payment_session ->
get_payment_status -> shop_checkout`. Only the final call creates an order.
Tavra records a merchant order ID only when `shop_checkout` returns one with the
approved amount. It records the order as incurred expense evidence, but it marks
an itemized receipt verified only when the merchant returns one or the traveler
uploads one. Airline submission and employer reimbursement remain external
handoffs until those systems return independent confirmation.

In explicit sandbox mode, Tavra uses Meddu UCP for product discovery
and an address-bound checkout draft. After Prava approval it uses the returned
one-time card in exactly one merchant checkout attempt. An insufficient-funds
or test-card decline is the expected successful capability result, is reported
back to Prava as declined, and is never recorded as an order or reimbursable
expense. Unknown post-submit outcomes require reconciliation and are not retried.

Plain iMessage cannot safely replace Prava's protected card/passkey ceremony.
The default path is a rich preview card followed by Prava's hosted card/passkey
ceremony. Tavra intentionally does not preselect an old card for the first Meddu
proof, because Prava cards can be merchant-scoped. The implemented signed Tavra Messages extension path renders the
redacted itemized review and exact product thumbnails natively, then presents
Prava in a Safari-controlled modal. It still cannot move Prava's protected
card/passkey ceremony into a mutable message bubble. Setup and platform limits
are documented in
[`docs/IMESSAGE_EXTENSION.md`](docs/IMESSAGE_EXTENSION.md).
`smoke:webhook` sends a correctly signed SMS fixture through the public tunnel
and repeats it to verify persistent deduplication. Because SMS is ignored, that
test never calls OpenAI or sends an outbound message.

The webhook request stays open while the Linq send completes. A send failure
returns HTTP 500 so Linq can retry. A bad signature returns HTTP 401 and is not
retried. Duplicate webhook deliveries either share the in-flight result or are
ignored after the first successful send.

## Routes

- `GET /` - Tavra landing page.
- `GET /health` - liveness check.
- `GET /health/commerce` - live MCP readiness, granted-scope, and connected-agent check.
- `GET /pay/:checkoutId` - short-lived handoff to the exact Prava approval URL
  for live commerce, or the sandbox approval page in explicit sandbox mode.
- `GET /api/prava/checkouts/:checkoutId/session` - browser-safe Prava session data.
- `GET /api/prava/checkouts/:checkoutId/summary` - redacted checkout summary for
  the Tavra Messages extension; it excludes Prava keys, session tokens, and iframe URLs.
- `GET /api/prava/checkouts/:checkoutId/status` - sanitized approval status.
- `GET /api/prava/checkouts/:checkoutId/products/:index/image` - guarded
  same-origin proxy for the exact selected UCP product image.
- `POST /api/prava/checkouts/:checkoutId/revoke` - cancel a secure session.
- `POST /webhooks/linq` - signed Linq webhook receiver.

Linq documentation: [Quickstart](https://docs.linqapp.com/getting-started/quickstart/),
[webhooks](https://docs.linqapp.com/guides/webhooks/), and
[sending messages](https://docs.linqapp.com/guides/messaging/sending-messages/).

OpenAI documentation: [text generation](https://developers.openai.com/api/docs/guides/text)
[image inputs](https://developers.openai.com/api/docs/guides/images-vision), and
[model guidance](https://developers.openai.com/api/docs/guides/latest-model).

Prava live-commerce documentation: [MCP connection](https://docs.prava.space/mcp/connect),
[MCP tools](https://docs.prava.space/mcp/tools),
[UCP integration](https://docs.prava.space/integration/ucp), and
[Browser Harness](https://docs.prava.space/integration/browser-harness).

Hackathon readiness and production gaps are tracked in
[`docs/HACKATHON_REQUIREMENTS.md`](docs/HACKATHON_REQUIREMENTS.md),
[`docs/PRODUCT_AUDIT.md`](docs/PRODUCT_AUDIT.md), and
[`docs/DEMO_AND_SUBMISSION.md`](docs/DEMO_AND_SUBMISSION.md).
