# Tavra

Tavra is a message-native travel recovery service. This vertical slice is
deliberately small: when the configured Linq number receives text or a supported
image over iMessage, Tavra resolves the sender through a private exact mapping, retrieves
that employee's allowlisted company context from Senso, and uses OpenAI to
produce one concise, sensible reply in the same chat.

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
- Short in-process conversation history per Linq chat so terse follow-ups can be
  interpreted in the preceding recovery context without becoming durable memory.
- An evidence-bound delayed-baggage flow that first asks what help is wanted,
  where it is needed, and by when. Saved sizes are shown only after replacement
  essentials are requested, and product sourcing waits for explicit confirmation.
- Exact delivery-address confirmation before checkout. A recent Linq location
  share can propose an address, but Tavra never treats location permission as a
  deliverable address or purchase consent.
- Multimodal baggage-notice intake for trusted Linq-hosted PNG, JPEG, WebP, and
  still-GIF files up to 15 MB. OpenAI extracts visible incident facts into a
  strict schema, and Tavra asks the employee to confirm them before use.
- Selection-driven product media sent as native iMessage content when the
  synthetic option is presented. Every proposed checkout line carries a stable
  catalog reference and resolves to its own image, exact line-item caption,
  alt-text metadata, source label, and illustrative-sandbox disclosure. If any
  selected item is unmapped or its asset is absent, Tavra sends no partial or
  substitute gallery.
- Explicit item, total, address, incident, and email authorization in iMessage.
  With a signed Tavra Messages extension configured, Linq sends a mutable
  `imessage_app` checkout card; otherwise it fails back to the existing rich-link
  Prava card rather than exposing a raw URL in the text.
- A responsive, Apple Wallet-like secure approval page that mounts Prava's
  protected iframe immediately, supports first-use passkey enrollment and repeat
  biometric approval, and reports completion back into the same chat.
- Server-only polling for Prava's one-time payment credential. Network tokens,
  dynamic CVVs, secret keys, and raw card details are never returned to the
  browser, chat, case ledger, or logs.
- A mode-bound merchant checkout adapter. Sandbox emits explicit `SIM-*`
  evidence; `PRAVA_MODE=live` refuses to start without a real live adapter.
  Ambiguous completions, multiple credentials, invalid report acknowledgements,
  and cancel races fail closed or enter reconciliation instead of claiming an order.
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
- Persistent inbound event deduplication in `data/processed-events.jsonl`.
- A webhook setup command scoped to the configured Linq phone number.
- Health endpoints and structured logs without message bodies or phone numbers.

## Requirements

- Node.js 22 or newer.
- A Linq Partner API V3 token and provisioned iMessage number.
- An OpenAI API key with API billing enabled.
- A Senso API key and a populated private identity map.
- Prava sandbox publishable and secret keys.
- A public HTTPS URL forwarding to the local port. The current setup uses a
  Microsoft dev tunnel.

### Product media assets

The current eligible synthetic catalog requires these exact source assets:

- `web/public/products/b-shirt-001.png`
- `web/public/products/b-trouser-001.png`
- `web/public/products/b-toiletry-001.png`

Vite publishes them at the matching
`/checkout-assets/products/<filename>` paths. The existing
`recovery-bundle.png` is reserved for the single aggregate fallback line item;
it is never substituted for one of the three SKU images. Demo imagery is always
captioned as illustrative and is not merchant SKU evidence.
Live merchant adapters should pass each verified catalog image as its original
HTTPS URL and configure a merchant-host allowlist; they must not copy live
catalog media into these synthetic filenames.

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
PRAVA_API_KEY=pk_test_...
PRAVA_SECRET_KEY=sk_test_...
PRAVA_MODE=sandbox
PRAVA_BACKEND_URL=https://sandbox.api.prava.space
PRAVA_CHECKOUT_MODE=hosted
# Set these only after installing the signed Tavra Messages extension.
TAVRA_MESSAGES_APP_TEAM_ID=
TAVRA_MESSAGES_APP_BUNDLE_ID=com.yourcompany.tavra.MessagesExtension
TAVRA_MESSAGES_APP_NAME=Tavra
PORT=3000
```

`OPENAI_MODEL` is optional and defaults to the cost-efficient `gpt-5-mini`.
`OPENAI_ROUTER_MODEL` defaults to `gpt-4o-mini`; exact greetings bypass it.
Secret keys remain server-side and are never sent through Linq or included in
logs. The identity map is also gitignored and must never be uploaded to Senso.
Only the Prava publishable key, short-lived session token, and trusted iframe URL
are exposed to the approval page.

Never commit `.env`. When a subscription is created by the setup command, its
one-time signing secret is saved to `.env` without being printed.

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
```

`smoke:openai` makes one small Responses API request without using Linq.
`smoke:senso-openai` performs the complete greeting, context triage, size
confirmation, option review, exact-address confirmation, incident correction,
email confirmation, and checkout-card authorization flow through real scoped
Senso and OpenAI without sending an iMessage or creating a real Prava session.
`smoke:prava` creates one sandbox session with synthetic identity data, validates
the browser-safe handoff, and immediately revokes the session.

After passkey verification, Prava returns the one-time credential while the
session is `awaiting_result`. Tavra passes it to the configured sandbox merchant
simulator, validates and reports that simulated result to Prava, then records a
same-chat update. This creates no live merchant order, charge, dispatch, or
delivery. Tavra can build and hash an airline claim packet from verified
incident evidence and incurred expenses, record explicit handoff authorization,
and open a reviewed official airline claim form. It does not claim external
submission until an airline confirmation ID plus independent confirmation
evidence is recorded. Employer-expense submission still requires a connector.

Plain iMessage cannot safely replace Prava's protected card/passkey ceremony.
The default path is a rich preview card plus a preselected saved card when Prava
has one. The implemented signed Tavra Messages extension path renders the
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

- `GET /` - service identity and active feature.
- `GET /health` - liveness check.
- `GET /pay/:checkoutId` - short-lived secure approval page.
- `GET /api/prava/checkouts/:checkoutId/session` - browser-safe Prava session data.
- `GET /api/prava/checkouts/:checkoutId/summary` - redacted checkout summary for
  the Tavra Messages extension; it excludes Prava keys, session tokens, and iframe URLs.
- `GET /api/prava/checkouts/:checkoutId/status` - sanitized approval status.
- `POST /api/prava/checkouts/:checkoutId/revoke` - cancel a secure session.
- `POST /webhooks/linq` - signed Linq webhook receiver.

Linq documentation: [Quickstart](https://docs.linqapp.com/getting-started/quickstart/),
[webhooks](https://docs.linqapp.com/guides/webhooks/), and
[sending messages](https://docs.linqapp.com/guides/messaging/sending-messages/).

OpenAI documentation: [text generation](https://developers.openai.com/api/docs/guides/text)
[image inputs](https://developers.openai.com/api/docs/guides/images-vision), and
[model guidance](https://developers.openai.com/api/docs/guides/latest-model).

Hackathon readiness and production gaps are tracked in
[`docs/HACKATHON_REQUIREMENTS.md`](docs/HACKATHON_REQUIREMENTS.md),
[`docs/PRODUCT_AUDIT.md`](docs/PRODUCT_AUDIT.md), and
[`docs/DEMO_AND_SUBMISSION.md`](docs/DEMO_AND_SUBMISSION.md).
