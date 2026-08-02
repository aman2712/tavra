# Tavra Demo and Submission Runbook

This is a recording and submission plan, not evidence that the listed features work. Check off an item only after preserving a real artifact. The supplied handbook requires a working demo, short demo video, repository or judge-access link, product explanation, Prava transaction outcome, partner-track evidence, pre-existing-work disclosure, and a summary of what worked, failed, and was learned (H2, lines 197-201; H3, lines 311-329).

Repository verification on 2026-08-02: `npm test` passed 50 of 50 tests and
`npm run build` passed. This proves local contracts and HTTP behavior, not a
real-device Linq delivery, live Senso/OpenAI transcript, merchant order, claim
submission, demo recording, or Devfolio submission. Preserve those separately.

Before using this runbook, resolve the deadline conflict in `HACKATHON_REQUIREMENTS.md`. Use the earlier stated cutoff until the live Devfolio page or organizer announcement confirms the official time.

## The one-sentence story

**Tavra turns a baggage-delay message or notice into a policy-aware essentials purchase and claim-ready recovery record, with the traveler approving the bounded payment through Prava from an iMessage-first flow.**

This story is valid only when each visible action in the demo has corresponding evidence. If merchant fulfillment remains simulated, say so in the sentence and on screen.

## Recommended demo scope

Keep the judged path narrow:

- One known employee.
- One delayed-baggage incident.
- One image notice plus a short natural-language need.
- One confirmed delivery address or pickup point.
- Two merchant candidates, one rejected by traceable trust evidence.
- One exact product option with honest images and current quote.
- One explicit bounded authorization.
- One successful Prava sandbox approval.
- One truthful merchant outcome.
- One recovery receipt and claim-ready evidence packet.

Do not add another disruption type to the recorded path unless the delayed-baggage flow is repeatably complete.

## Two outcome modes

Choose one before recording and use its wording consistently.

### Mode A: Real merchant sandbox or test checkout

Use only if an actual merchant endpoint accepts the transaction and returns its own order reference.

- Say: `Prava approval completed. The merchant accepted test order [merchant reference].`
- Show: redacted Prava transaction evidence, merchant response/receipt, delivery or pickup status, and the recovery receipt.
- Do not say delivered until a merchant/carrier event proves delivery.

### Mode B: Labeled commerce simulation

Use if the current simulated merchant adapter remains in place.

- Say: `Prava sandbox payment approval completed. Merchant fulfillment is simulated for this demo, so no real order was placed.`
- Show: the Prava sandbox result separately from the simulated fulfillment event.
- Keep a visible `Simulation` label on the result and claim packet.
- Never call a generated `SIM-*` value a merchant order ID.

Mode B is honest, but it remains a serious judging gap because the handbook says a created payment session alone is not a completed order and warns against mocked payment presented as a transaction (H2, lines 123 and 197; H3, lines 171-177 and 301-309).

## 2 to 3 minute demo script

Do not record this script until each bracketed proof item exists.

### 0:00 to 0:15, problem and interface

**Visual:** iMessage thread with Tavra. Optional one-slide title for no more than five seconds.

**Narration:**

> A delayed bag creates two urgent jobs: replace essentials now and assemble evidence for reimbursement later. Tavra handles both from the conversation the employee is already using.

**Evidence:** Real Linq iMessage number and webhook event. Hide personal phone numbers.

### 0:15 to 0:40, multimodal incident intake

**Action:** Send a baggage-delay notice image and one truthful sentence, such as “My bag is delayed and I need to be ready for an 8 AM client meeting.” Do not mention a meeting if it is not actually part of the test input.

**Expected behavior:** Typing indicator appears. Tavra extracts airline/airport/reference/date only from the notice, acknowledges the disruption, states uncertain fields, and asks the highest-value missing question without dumping the employee profile.

**Narration:**

> OpenAI reads the notice into a strict schema. Tavra treats extraction as proposed evidence, never as permission to act, and asks me to correct anything uncertain.

**Evidence:** Inbound media event ID, attachment hash, redacted extraction JSON, confidence values, and the user correction event.

### 0:40 to 1:05, context and address

**Action:** State what essentials are needed and by when. If location sharing is implemented, share location and then confirm the exact hotel or delivery address Tavra proposes. Otherwise type the address.

**Expected behavior:** Tavra retrieves only relevant saved sizes and company policy, asks for confirmation, and separately confirms the full delivery destination. It never equates a location coordinate with a deliverable address.

**Narration:**

> Senso supplies the allowlisted employee and policy context. Tavra asks me to confirm saved data and the exact destination before it searches for an option.

**Evidence:** Scoped Senso request content IDs, returned source metadata, address confirmation event, and consent timestamp. Redact exact home or hotel-room details in the recording.

### 1:05 to 1:30, discovery and trust

**Visual:** Tavra sends a compact option and product media.

**Expected behavior:** Show exact merchant, items, sizes, itemized total, allowance, delivery estimate, substitution/return terms, and address summary. Tavra should send one adjacent, clearly illustrative image for each exact proposed line item: T-shirt, trousers, and toiletry kit. No unselected or aggregate bundle image should appear. Show why one candidate was rejected and why the selected merchant is trusted.

**Narration:**

> Senso is not just profile memory here. Verified merchant evidence changes the decision: Tavra rejects an option with stale or unverifiable delivery terms, then selects the option with current stock, returns, and delivery evidence.

**Evidence:** Candidate set, official source URLs/content IDs, retrieval timestamps, hashes, rejection reason, selected offer, quote timestamp, and the three mappings `b-shirt-001`, `b-trouser-001`, and `b-toiletry-001` to their exact media messages. State that the current images are illustrative synthetic-catalog media, not official merchant SKU evidence.

### 1:30 to 1:55, bounded authorization and Prava

**Action:** Approve the unchanged option. Open the secure Prava surface and complete the sandbox passkey/payment flow.

**Expected behavior:** Before handoff, Tavra shows merchant, items, total/ceiling, delivery address summary, and what will happen. After approval, the chat updates without the user sending another message.

**Narration:**

> I authorize this merchant, this total, and this destination. Card data and biometric verification stay inside Prava. Tavra receives only the one-time result needed for the approved action.

**Evidence:** Redacted authorization record, Prava session reference, transaction reference, state sequence, report-status response, and same-chat notification event. Never show test card, CVV, OTP, raw token, dynamic CVV, passkey detail, API key, email, or phone.

### 1:55 to 2:20, truthful result

**Mode A expected behavior:** Display merchant-issued order reference, receipt, delivery status, and support/cancel path.

**Mode B expected behavior:** Display `Prava sandbox approval complete` and `Merchant fulfillment simulated`, with no claim of a real order.

**Narration for Mode A:**

> The merchant accepted the test order and Tavra reports the merchant's actual reference. Payment approval, order acceptance, dispatch, and delivery remain separate states.

**Narration for Mode B:**

> The Prava sandbox approval is real. Merchant fulfillment is a clearly labeled simulation in this build, so no real order or delivery is claimed.

**Evidence:** Merchant response if Mode A. If Mode B, simulation flag in stored case, UI, chat, and logs.

### 2:20 to 2:45, reimbursement outcome

**Visual:** Same-thread recovery receipt and claim status.

**Expected behavior:** Tavra uses airline, airport, reference, receipt, and company policy to show an airline checklist and employer expense packet. It either shows an external submission reference or says `claim-ready, not submitted` and asks permission.

**Narration:**

> The incident facts are reused instead of collected and discarded. Tavra creates separate airline and employer evidence packets and does not claim reimbursement until the receiving system confirms it.

**Evidence:** Official airline source provenance, packet version/hash, missing-evidence result, user consent, and external claim/expense reference only if one actually exists.

### 2:45 to 3:00, close

**Narration:**

> Tavra reduces a stressful travel disruption to one evidence-grounded conversation, one bounded approval, and a recoverable record of every action.

**Visual:** Final case timeline with explicit states and partner attribution.

## Recording checklist

### Before recording

- [ ] Confirm the official deadline in Devfolio/Discord.
- [ ] Choose Mode A or Mode B and remove the other narration from the cue sheet.
- [ ] Start from a clean demo employee and a new recovery case.
- [ ] Use synthetic, non-personal phone, email, address, flight, and baggage details where possible.
- [ ] Confirm all environment values point to sandbox/test systems.
- [ ] Confirm no API key or credential can appear in browser URL, terminal, logs, or source window.
- [ ] Hide notifications and unrelated Messages conversations.
- [ ] Disable password-manager and OTP previews during recording.
- [ ] Warm the tunnel and verify health, Linq webhook, OpenAI, Senso, Prava, and merchant adapter.
- [ ] Verify the three SKU assets return HTTP 200 at `/checkout-assets/products/b-shirt-001.png`, `/checkout-assets/products/b-trouser-001.png`, and `/checkout-assets/products/b-toiletry-001.png`.
- [ ] Confirm the proposed item list and media captions match exactly and that `recovery-bundle.png` is not sent for the three-item option.
- [ ] Run the exact script successfully twice from a clean state.
- [ ] Have a prerecorded backup and screenshots, but be ready for a live judge run.

### Capture quality

- [ ] Record the iPhone/iMessage view at readable scale.
- [ ] Keep terminal evidence as short inserts, not the main product experience.
- [ ] Keep typing/waiting sections short; speed up only if clearly disclosed.
- [ ] Add captions and verify every partner name is spelled correctly: Tavra, Prava, Linq, OpenAI, Senso, Visa.
- [ ] Avoid em dashes in Tavra chat output.
- [ ] Do not show card number, CVV, OTP, raw token, dynamic CVV, secret, personal phone/email/address, or biometric detail.
- [ ] Keep a visible sandbox indicator throughout the payment segment.
- [ ] Make the final action and its evidence readable without narration.

### After recording

- [ ] Watch once with audio muted to confirm the flow is understandable.
- [ ] Watch once at 1x to verify no misleading cut, hidden failure, or exposed secret.
- [ ] Verify the video link works in a signed-out browser.
- [ ] Capture a cover screenshot that shows the product outcome, not only the payment form.
- [ ] Record the video file hash and final duration in the evidence manifest.

## Evidence manifest

Create a private, redacted evidence directory or judge-access bundle. Do not commit secrets or personal data.

| Evidence | Minimum artifact | State |
|---|---|---|
| Build provenance | Commit SHA(s), timestamps, participant list | [ ] |
| Linq | Inbound event ID, attachment metadata, outbound message IDs, typing/completion events | [ ] |
| OpenAI | Model/version, schema name, redacted request/response IDs, evaluation results, latency/cost | [ ] |
| Senso | Scoped content IDs, source metadata, candidate decision trace, freshness/hash | [ ] |
| Authorization | User confirmation event, merchant/items/amount/address scope, expiry | [ ] |
| Prava | Environment, session/transaction references, state timeline, report-status response | [ ] |
| Merchant | Merchant-issued test receipt and order reference, or explicit simulation record | [ ] |
| Fulfillment | Delivery/pickup event or `not implemented` disclosure | [ ] |
| Airline | Official source snapshot, packet hash, submission reference or `not submitted` state | [ ] |
| Employer | Policy version, expense packet hash, external reference or `not submitted` state | [ ] |
| Reliability | Test output for duplicate events, restart, timeouts, declines, expired link, unreadable image | [ ] |
| Security | Secret scan, dependency scan, redaction review | [ ] |
| Demo | Final video URL/hash and screenshots | [ ] |

## Devfolio writeup template

Replace every bracket. Delete unsupported track claims.

### Project name

Tavra

### Tagline

[One sentence naming the traveler, disruption, action, and outcome.]

### The problem

[Who experiences delayed baggage during work travel, what they must coordinate, what it costs in time/stress/claim leakage, and any real interview or pilot evidence.]

### What Tavra does

[Describe the narrow end-to-end flow in six sentences or fewer. State whether merchant fulfillment is real test checkout or simulation.]

### Why this is agentic commerce

[Explain which facts Tavra discovers, which decision it makes, which constraints it applies, what the user authorizes, what transaction occurs, and what visible result follows.]

### Prava integration and transaction outcome

[SDK/API choice and why. Environment. Permission scope. Session and result flow. Exact truthful outcome. Failure handling. Never paste credentials.]

### Linq implementation

[Why iMessage is the product interface. Webhooks, typing, image intake, product media, payment handoff, same-thread status. Mention only features shown working.]

### OpenAI implementation

[Model/tool use for multimodal evidence extraction, intent/slot interpretation, grounded planning, and natural language. Describe schemas, deterministic guards, and evaluation.]

### Senso implementation

[Verified sources, strict employee scope, merchant candidates, provenance, rejection/selection evidence, and how the Senso result changed the Prava-bound decision.]

### Visa Intelligent Commerce evidence

[Transaction completion, user permissions, spending controls, trust signals, authentication, actual confirmations, and failure behavior. Do not infer network claims absent from partner evidence.]

### Startup potential

[Buyer and user, launch wedge, distribution, pricing hypothesis, integration path, market/pilot evidence, and 90-day roadmap.]

### Technology used

Prava; Linq; OpenAI API; Senso; [real data store]; [merchant integration]; [airline/expense integration]. Remove anything not materially used.

### What worked

- [Verified outcome with evidence.]
- [Verified partner integration behavior.]
- [Verified reliability or UX result.]

### What did not work

- [Specific limitation or failure, including any simulation.]
- [Why it happened.]
- [How the product handles it honestly.]

### What we learned

- [Technical learning.]
- [User/product learning.]
- [Payment/trust learning.]

### What happens next

[Concrete production work, pilot target, partner needs, and safety/compliance work.]

## Pre-existing work disclosure

This section is mandatory. The handbook permits existing products only when the new workflow built during the event is clearly disclosed (H1, lines 25-40; H2, line 197; H3, lines 301-305).

> **Before the official build window:** [List every existing repository, feature, design, integration, document, and reusable component. Include commit SHAs or dated evidence.]
>
> **Built during the official build window:** [List exact new Tavra workflows and meaningful Prava/partner work. Include commits and contributors.]
>
> **External services, templates, and AI tools used:** [List Prava, Linq, OpenAI, Senso, Codex, libraries, generated assets, and their roles.]
>
> **Simulated or synthetic elements:** [List synthetic employee/policy/catalog data, simulated merchant fulfillment, generated product images, and any unconnected claim packet.]
>
> **Contributors:** [Only accepted registered team members, plus proper attribution for third-party code/assets.]

Do not submit with placeholders left in this section.

## Final submission checklist

- [ ] Devfolio project name and tagline are final.
- [ ] Problem, user, product, and outcome are understandable without a live explanation.
- [ ] Technologies Used names Prava and only the partner tracks materially implemented.
- [ ] Repository or judge-access link works from a clean account.
- [ ] Setup instructions reproduce the demo without personal credentials.
- [ ] Short demo video and screenshots load while signed out.
- [ ] Prava integration and exact transaction outcome are explained.
- [ ] Partner-track evidence is linked, not merely asserted.
- [ ] Pre-existing/new-work disclosure is complete.
- [ ] “Worked, did not work, learned” section is candid and specific.
- [ ] No restricted personal/payment data is present.
- [ ] Every participant is accepted, added, RSVP'd, and checked in as required.
- [ ] Team admin selects `Publish Project`.
- [ ] Devfolio status visibly reads `Submitted` before the verified deadline (H3, lines 323-329).
- [ ] Final page and confirmation are captured for the team's records.

## Judge Q&A preparation

Be ready to answer, with artifacts:

1. What exactly did Prava authorize, and what happened after authorization?
2. Which identifier came from Prava, which came from the merchant, and which was generated by Tavra?
3. Why did Senso choose one merchant over another, and where did each fact come from?
4. What prevents OpenAI from inventing a meeting, address, policy, order, or claim?
5. What happens on restart, duplicate webhook, payment decline, stock change, or claim rejection?
6. Why is iMessage essential instead of a web chat wrapper?
7. What was built during the hackathon?
8. Which parts are synthetic, simulated, or not yet connected?
9. What would be required for a real employer pilot and production Prava access?

Honest boundaries strengthen Tavra's trust story. If a judge asks whether the current sandbox result is a real merchant order, the correct answer is determined by Mode A or Mode B above, not by the desired narrative.
