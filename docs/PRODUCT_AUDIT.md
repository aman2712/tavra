# Tavra Product Audit

Audit date: 2026-08-02. This document distinguishes the current repository from the product Tavra should become. It intentionally does not treat a Prava sandbox approval, a generated identifier, or a synthetic catalog as a real order.

## Executive assessment

Tavra has a credible vertical slice: a known employee can message an iMessage number, receive a company-context-aware response, confirm a recovery option, and complete a protected Prava sandbox approval. The strongest foundations are identity scoping, payment credential isolation, webhook verification, and explicit pre-purchase language.

The flow is now a truthful recovery prototype rather than the earlier fixed bundle script. It asks what the traveler wants, where and when it is needed, confirms saved sizes, rejects a late option, confirms an exact address, reads baggage notices, and persists incident, payment, evidence, expense, and airline claim-packet state. It still uses synthetic merchant evidence and a simulated downstream merchant result. No live order, dispatch, airline claim submission, or employer reimbursement is created.

The production product should be organized around a durable **recovery case and evidence ledger**, not around a linear prompt stage. The model may interpret and plan, but every consequential action must be gated by verified facts, user authorization, policy, and an idempotent tool result.

## Current truth boundary

| Surface | What is true today | What must not be claimed |
|---|---|---|
| Linq intake | Signed text and media events are processed. Tavra shows typing, sends selection-driven per-line-item product media, can request/retrieve a recent shared location as an address proposal, and can send/update a Linq `imessage_app` checkout card. The native Messages container and extension are signed and installed on the physical demo iPhone. | That the extension is installed on a judge's device, that the complete native card-to-payment flow has already been recorded, that Prava's protected fields live in the bubble, or that SMS/RCS recipients get the interactive experience. |
| Identity | A private exact E.164 mapping resolves a sender to an allowlisted employee and Senso content IDs. | That Senso identifies a person from an arbitrary phone number or that semantic retrieval is an identity system. |
| Senso | Tavra queries real Senso APIs using strict content-ID scope. Employee/profile/policy facts and synthetic demo merchant documents can be returned. | That the synthetic merchant catalog proves live stock, price, delivery, returns, or merchant trust. |
| OpenAI | OpenAI routes intent, extracts structured turns, reads supported baggage-notice images, and writes constrained replies. Deterministic checks block unsupported meetings, early options, infeasible deadlines, and action claims. | That the model accessed live travel or merchant systems, verified facts not present in tools, or independently completed an action. |
| Conversation | Recent turns and recovery stages are held in process memory. | Durable case memory, restart recovery, cross-device consistency, or a complete audit history. |
| Prava | Tavra creates a Prava sandbox session, keeps payment credentials server-side, polls through session expiry, calls a mode-bound merchant adapter, validates Prava's acknowledgement, and reports the exact result. | That a sandbox approval alone charged a production card, placed a live merchant order, or established delivery. |
| Merchant result | The configured adapter emits explicit `SIM-*` references and `simulated: true`. Live mode refuses to start without a live adapter, ambiguous completion becomes `reconciliation_required`, and cancel races are fail-closed. | That the simulated value came from a merchant. It is test evidence only. |
| Recovery and reimbursement | A local permission-restricted JSONL ledger stores the case, confirmed address, incident facts, verified evidence, actual expenses, payment outcome, fulfillment disclosure, blockers, a hashed claim packet, explicit manual-handoff authorization, and externally confirmed submission references. Reviewed official handoffs exist for Delta, American, and Emirates. | That Tavra itself submitted an airline form, that an airline accepted the packet without independent confirmation, or that an employer expense was submitted, reviewed, approved, or paid. |

Repository anchors: `src/message-reply.ts` and `src/linq.ts` for text/media/location presentation; `src/product-media.ts` for selection-driven SKU/media resolution; `src/openai.ts` for evidence-bound dialogue and vision; `src/prava.ts` for the payment state machine; `src/recovery-case.ts` for case snapshots; `src/senso.ts` for scoped retrieval; and `senso/demo-corpus/README.md` for the synthetic-data boundary.

## Why the old conversation felt hardcoded, and what changed

The earlier behavior was not only a prompting issue. Its state model dictated the wrong conversation. The following defects are now fixed in the prototype:

- Bare baggage reports now enter recovery-context triage, not size confirmation.
- Meeting, city, deadline, and product needs must come from the user or confirmed image evidence.
- Need, deadline, delivery area, exact address/source/confirmation, notice evidence, incident facts, and case ID are explicit state.
- Claim-only users can bypass shopping, and a location share is only proposed until the traveler confirms the exact address.
- Product sourcing waits for goal, area, deadline, and size confirmation; an estimate later than the required deadline is rejected.
- Airline, airport, reference, address, products, and payment outcome are written to a recovery case rather than discarded.

The remaining rigidity is the demo catalog itself: one Boston essentials configuration and a fixed item mapping. A production planner still needs category-level needs, pickup, substitutions, multiple merchants, interruptions, durable conversation state, and verified live tools.

The fix is a case model with slot confidence and action prerequisites. Prompts should decide phrasing and interpret evidence, while application logic decides what may happen next.

## Target end-to-end flow

This is the realistic happy path. Tavra should skip already-known steps and branch when the user's need differs.

1. **Receive intent and evidence.** Accept text, image, or both. For an image, preserve the original, extract visible fields with confidence, and ask the user to correct only uncertain or consequential values.
2. **Acknowledge without inventing context.** “I’m sorry, that’s frustrating. I can help with essentials and the paperwork.” Ask the most useful question based on what is missing, such as what they need and by when. Do not assume a meeting, city, urgency, or desired products.
3. **Open a durable recovery case.** Record the employee, disruption type, source message IDs, evidence hashes, extracted facts, confidence, and current state. Resume the same case after restarts and deduplicate repeated images/webhooks.
4. **Establish need and deadline.** Determine whether the user wants replacement essentials, baggage tracking/claim help, reimbursement, or a combination. Capture the actual need-by time and business purpose only when policy requires it.
5. **Resolve location safely.** A location share can suggest city/airport and nearby merchants, but is not a delivery address. Ask permission before using precise location. Resolve it to a candidate and ask the user to confirm the full deliverable address, hotel/venue name, room or desk instructions, phone/contact constraints, and delivery window.
6. **Retrieve only relevant company context.** Use the exact employee mapping, then fetch necessary profile and policy records. Confirm saved values before purchase. Treat stale/conflicting values as unknown.
7. **Build the incident record.** Extract or ask for airline, flight/date, arrival airport, bag or PIR reference, passenger name, and notice timestamp only as needed. An absent optional reference should not block emergency essentials unless a verified policy says it must.
8. **Discover and verify merchants.** Query real merchant inventory and delivery promises. Use Senso as the traceable context layer for official merchant terms, live snapshot provenance, policy fit, and prior verified outcomes. Reject candidates with stale or unverifiable evidence.
9. **Present a grounded option.** Show merchant, exact products, sizes, quantities, honest product images, itemized total, policy allowance, expected delivery/pickup window, address summary, return/substitution rules, and evidence freshness. Ask for changes.
10. **Authorize the bounded action.** Record consent for merchant, total ceiling, address, substitutions, and claim behavior. Explain what will happen next and what has not happened.
11. **Approve securely with Prava.** Keep card entry and passkey inside Prava. Prefer a native Linq iMessage App/Payments handoff only if both partners confirm a supported PCI-safe integration. Otherwise use the current one-tap secure link with prefilled non-sensitive data and a saved-card/passkey path.
12. **Execute merchant fulfillment.** Use the one-time credential against a real merchant checkout, capture the merchant's response, and report the true result to Prava. Never manufacture approval. If unavailable, run a visibly labeled simulation and stop short of order claims.
13. **Return a recovery receipt.** Send a same-thread result with merchant order status, delivery address summary, ETA, itemized receipt, amount, policy allocation, and cancellation/support path. Separate `authorized`, `ordered`, `dispatched`, and `delivered` states.
14. **Prepare two reimbursement paths.** Build an airline claim packet from official airline/regulator requirements and an employer expense packet from company policy. Reuse the receipt and incident evidence. Ask explicit permission before filing either one.
15. **Track outcomes.** Persist airline claim reference, employer expense reference, requests for more evidence, reimbursement decisions, delivery events, and user-visible status. Notify in chat without making the user repeat facts.

## Minimum case state

| Domain | Required fields |
|---|---|
| Identity | `case_id`, company ID, employee ID, verified sender handle, access scope |
| Incident | disruption type, reported time, airline, flight/date when needed, arrival airport, bag/PIR reference, business purpose when required |
| Evidence | source message/attachment ID, media type, storage reference, SHA-256, extraction result, confidence, user corrections, provenance |
| Need | requested categories, sizes/preferences, quantities, need-by time, acceptable substitutions |
| Delivery | consented location source, normalized address, user confirmation timestamp, access instructions, delivery/pickup window |
| Policy | policy version, allowance, eligible categories, evidence requirements, approval result |
| Merchant decision | candidates, source URLs/content IDs, retrieval time, trust class, stock/price/ETA, rejection reasons, selected offer |
| Authorization | item/merchant scope, amount ceiling, currency, expiry, address, substitution rule, confirmation event ID |
| Payment | Prava environment/session/reference, sanitized status, attempt count, timestamps, idempotency key |
| Fulfillment | merchant order ID from merchant, status, receipt, delivery events, cancellation/refund state |
| Claims | airline and employer packet versions, consent, submission references, status, missing evidence, reimbursements |
| Audit | actor, action, input evidence, tool result, state transition, timestamp, correlation ID |

Sensitive values should be tokenized or encrypted, access-controlled per employer, and retained only as long as a documented purpose requires.

## Priority backlog

### P0: Required for an honest end-to-end demo

1. **Conversation triage: implemented for the delayed-baggage slice.** The invented meeting fallback is gone, missing values remain unknown, and deterministic prerequisites govern sourcing and checkout. Broad interruption and category support remain partial.
2. **Need, urgency, and delivery: implemented for delivery.** Deadline and area precede sourcing; exact typed/shared-location address requires confirmation. Pickup and merchant address validation remain missing.
3. **Inbound image handling: implemented for trusted Linq-hosted PNG, JPEG, WebP, and still GIF files up to 15 MB.** Extraction is schema-bound and user-confirmed. Durable original-file hashing, malware isolation, and field confidence remain missing.
4. **Product media: implemented for the synthetic catalog as exact SKU-to-asset resolution.** Each proposed line item resolves to its own URL, caption, alt-text metadata, and source disclosure; incomplete coverage suppresses the whole gallery instead of substituting a bundle image. The three current files are illustrative demo assets, not official merchant SKU evidence.
5. **Create durable orchestration.** Recovery cases, claim evidence, claim state, and processed event IDs are persisted in JSONL. Conversation sessions, active Prava checkouts, the checkout-to-app-card mapping, and notification outbox still disappear on restart and need a transactional store.
6. **Merchant truth boundary: implemented for simulation, not fulfillment.** UI, chat, logs, case data, and demo copy distinguish the simulator from a live merchant. A real merchant remains the largest hackathon gap.
7. **Incident reuse: partial.** Details now feed airline-specific reviewed destinations, required-field/evidence blockers, incurred expenses, a hashed claim packet, explicit handoff authorization, and externally confirmed submission state. Tavra does not submit authenticated airline forms, auto-ingest the returned confirmation yet, or connect an employer expense system.
8. **Post-payment state: partial.** Payment, merchant, reconciliation, cancellation, and chat outcomes are separate and notification retries preserve one event. Checkout persistence and a durable outbox remain missing.
9. **Evidence-backed tests: partial.** Automated tests cover the main gates and payment edge cases. A real-device image/location/Prava run, restart test, and external claim proof still need recording.

### P1: Required for production-quality behavior

1. **Verified discovery pipeline.** Fetch allowlisted official airline, airport, regulator, and merchant sources; record URL, title, retrieved time, effective date, content hash, extracted facts, trust class, and expiry. Feed those snapshots to Senso and surface concise provenance.
2. **Real merchant integrations.** Build an adapter interface for quote, reserve, purchase, status, cancel, and refund. Add idempotency and reconcile Prava with the merchant ledger.
3. **Airline claim connector.** Prefer official APIs/forms where permitted. Otherwise prepare the packet and hand off to the official claim page. Never automate around authentication, CAPTCHA, terms, or consent.
4. **Employer expense connector.** Map policy and receipt data to the employer's expense system, obtain submission consent, capture the external expense ID, and track status.
5. **Policy engine.** Move eligibility, approval thresholds, and action prerequisites into versioned deterministic rules. Use the model to interpret ambiguous language, not to invent or enforce spend policy.
6. **Conversation planner.** Rank the next question by user value, dependency, and sensitivity. Answer the user's direct question before returning to the workflow. Avoid repeating confirmed values.
7. **Human escalation.** Provide review queues for policy ambiguity, expensive orders, unavailable inventory, claim rejection, suspected fraud, and low-confidence image extraction.
8. **Observability and evaluation.** Trace every turn and tool call with redacted correlation IDs. Measure task success, unsupported assumptions, repeated questions, time to recovery, payment conversion, claim completeness, latency, and cost.
9. **Security program.** Add secret scanning, dependency scanning, media isolation, encryption, least-privilege service accounts, tenant isolation, signed asset URLs, audit export, retention/deletion, incident response, and privacy notices.

### P2: Differentiation after the core is reliable

1. Extend the implemented Linq iMessage App card beyond its checkout and terminal-payment update to durable ordered, en-route, delivered, and claim states, with delivery-aware retries and a signed physical-device acceptance run.
2. Linq reactions as explicit low-risk controls, such as a thumbs-up to approve a previously displayed unchanged option. Never use a reaction as consent after price, address, merchant, or items change.
3. Group-chat coordination for traveler, travel manager, and host, with role-aware privacy.
4. Multi-merchant split recovery with one policy budget and deterministic optimization across delivery confidence, returns, cost, and user preference.
5. Proactive flight disruption intake from authorized travel systems, with the user still controlling purchase and claim filing.
6. Learning from verified outcomes such as actual on-time delivery and successful reimbursements, not from model-generated summaries.
7. Multilingual conversation and accessibility testing across iMessage, RCS, and SMS fallbacks.

## Image notice ingestion contract

The model output should be schema-bound and treated as a proposal:

```text
document_type
airline
passenger_name
flight_number
flight_date
arrival_airport
baggage_reference
notice_timestamp
stated_next_steps[]
field_confidence{}
evidence_spans{}
unreadable_regions[]
```

Rules:

- Never use image metadata alone as proof of where the traveler is.
- Never infer a missing baggage reference from a barcode or partial number without confirmation.
- Ask the user to confirm identity, airport, and reference before an external filing.
- Store the original attachment separately from normalized extracted values.
- Do not send unrelated image content or hidden metadata to the model.
- Delete or redact evidence according to employer policy and applicable privacy law.

## Product image contract

Every displayed product image needs a merchant/SKU association, source, retrieval timestamp, descriptive alt text, and a clear label if color or appearance may vary. Price, inventory, ETA, and return terms must be checked independently from the image. Generated visuals can illustrate the hackathon's synthetic catalog, but they must carry a visible illustrative-sandbox label and cannot serve as proof of a real item.

The current resolver keys the exact proposed line items to:

- `b-shirt-001` -> `/checkout-assets/products/b-shirt-001.png`
- `b-trouser-001` -> `/checkout-assets/products/b-trouser-001.png`
- `b-toiletry-001` -> `/checkout-assets/products/b-toiletry-001.png`

The source files belong at the matching names below `web/public/products/`.
`recovery-bundle.png` is valid only for the single aggregate fallback product
reference `demo-recovery-essentials`; it must not stand in for a missing SKU
image. The Linq API's media part has no alt-text field in the installed SDK, so
Tavra keeps alt text in presentation metadata and sends the exact line-item
label plus the illustrative disclosure as the adjacent text caption.

Live catalog media remains URL-driven: an official merchant asset definition
uses the merchant's exact HTTPS image URL and can be restricted by a verified
hostname allowlist. It is not rewritten to a Tavra demo filename, and its source
label travels with the resolved media metadata.

## Can payment happen directly inside iMessage?

Possibly, but it is a partner-capability and compliance question, not a prompt change.

- The supplied Linq handbook says its platform supports iMessage Apps and Payments (H3, lines 256-265).
- Tavra now sends Prava as a Linq rich-link card. Linq's official [rich-link guide](https://docs.linqapp.com/guides/messaging/rich-link-previews/) confirms that a link must be its own message part, which is why Tavra sends a short conversational message followed by the card.
- Linq's official [iMessage Apps guide](https://docs.linqapp.com/guides/messaging/imessage-apps/) can keep an interactive checkout inside Messages, but only through a real signed Messages extension identified by its Apple team and bundle IDs. Recipients need the shipping app for the live extension experience; an API payload alone is only a static card/fallback.
- Linq Agent Pay is a different payment rail: its official [payment-request guide](https://docs.linqapp.com/api/go/resources/payment_requests/) uses a hosted Apple Pay/card checkout and Stripe merchant-of-record settlement. Replacing Prava with it would weaken the required Prava integration rather than make Prava native.
- Prava's protected card/passkey ceremony must remain inside a Prava-approved secure surface. Tavra must never collect card number, CVV, dynamic credential, or passkey response in chat.
- Prava's official [intent invocation guide](https://docs.prava.space/sdk/intents/invoke) describes a lower-friction repeat path: a previously passkey-authorized, merchant/amount/time-bounded intent can issue a one-time credential without another prompt. The installed `@prava-sdk/core` 0.1.2 package exposes card collection but not those intent methods, and Tavra has not implemented or sandbox-verified that newer flow.

The lowest-risk current experience is one rich-link card, with employee identity and order context prefilled, followed by a default saved-card/passkey approval and a same-thread result. The next credible reduction in clicks is a Prava intent/mandate for repeat purchases, not card data in chat. A native Messages card is worth pursuing only after building and distributing the signed extension and confirming Prava's secure-surface behavior. Until that is proven, do not promise “pay in the bubble.”

## Reimbursement architecture

Treat purchase recovery and reimbursement as related but separate workflows:

For U.S.-covered travel, the Department of Transportation says passengers
should file with the airline promptly and that delayed-bag incidental expenses
must be reasonable, verifiable, and actual, subject to applicable limits. Its
[baggage guidance](https://www.transportation.gov/lost-delayed-or-damaged-baggage)
and [Fly Rights guidance](https://www.transportation.gov/airconsumer/fly-rights)
also emphasize retaining the baggage report and receipts. Tavra therefore must
not turn a planned cart or simulated authorization into reimbursement evidence.

### Airline reimbursement

1. Retrieve current official airline and regulator requirements using airline, airport/jurisdiction, date, and disruption type.
2. Compare the case evidence to those requirements.
3. Produce `ready`, `incomplete`, `submitted`, `needs_more_information`, `approved`, `rejected`, or `paid` status.
4. Show missing evidence and official source provenance.
5. Obtain explicit filing consent.
6. Submit only through an authorized integration or hand off a prefilled packet to the official portal.
7. Save the external claim reference and track future updates.

### Employer reimbursement

1. Resolve the exact employee policy version and allowance.
2. Attach the itemized merchant receipt, business purpose, incident evidence, approval, and policy decision.
3. Allocate amounts between company allowance, airline claim, and employee responsibility without double reimbursement.
4. Obtain submission consent and record the expense-system reference.
5. Reconcile approved/paid amounts and surface exceptions.

Tavra should never say “reimbursable” based only on general model knowledge. It should say what the company policy permits, what an official airline source currently requires, and what remains subject to review.

## Production acceptance criteria

Tavra is ready for a limited pilot only when:

- No unsupported meeting, city, product need, address, delivery, purchase, or reimbursement claim appears in the evaluation suite.
- A user can start with text or an image, correct extraction, change course, ask a question, or cancel without corrupting case state.
- A checkout cannot start without confirmed item, total, merchant, delivery destination/pickup, and authorization scope.
- Restarting the service does not lose a case, checkout, or unsent completion notification.
- Every external action is idempotent and reconciled.
- Every user-visible state has evidence and a truthful verb.
- A real merchant result is distinguishable from a sandbox simulation in data, UI, logs, and narration.
- Airline and employer claim paths produce either a verified external reference or a clearly labeled claim-ready packet.
- Security, privacy, retention, accessibility, and operational runbooks have named owners.
