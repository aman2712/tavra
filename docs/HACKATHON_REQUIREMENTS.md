# Tavra Hackathon Requirements Tracker

Status as of 2026-08-02, based on the repository and the three supplied hackathon text exports. This is an evidence tracker, not a claim of eligibility or completion. Rewards, dates, track rules, and judging details must be checked against the live Devfolio page and Discord before submission.

## Immediate deadline risk

The supplied handbook exports contradict each other:

- Handbook export H2 gives a submission deadline of **August 2, 2026 at 3:00 PM PT / August 3 at 3:30 AM IST** in its header, timeline, and hard-deadline section (H2, lines 21-23 and 223-235).
- Handbook export H3 gives **7:00 PM PT / 7:30 AM IST** in its header, Devfolio instructions, and timeline (H3, lines 23-26, 323-329, and 346-356), but the same file later says **3:00 PM PT / 3:30 AM IST** (H3, lines 362-371).

Until the organizers confirm otherwise, Tavra should use the earlier **3:00 PM PT** time as the internal cutoff. The team must verify the live Devfolio countdown and the pinned Discord announcement immediately. Do not rely on either export alone.

## Status vocabulary

| Status | Meaning |
|---|---|
| Implemented | Repository evidence exists for the stated scope. This does not imply production readiness. |
| Partial | A meaningful portion exists, but the required outcome or evidence is incomplete. |
| Missing | No repository evidence was found. |
| External verification | Depends on organizer, partner, account, live dashboard, or submission state. |
| Not targeted | Tavra is not currently built for this optional track. |

## Core eligibility and judging tracker

| Requirement or criterion | Handbook basis | Current Tavra evidence | Status | Gap or risk | Next action and proof |
|---|---|---|---|---|---|
| Use Prava meaningfully in the core commercial action | H2, lines 91-123; H3, lines 133-177 | Prava creates the protected session, returns the one-time credential server-side, receives the bounded downstream result, and updates the same chat. A dedicated adapter now separates Prava approval, simulated merchant outcome, and live merchant outcome. | Partial | The configured hackathon adapter is deliberately a labeled simulator. It creates `SIM-*` evidence only, not a merchant purchase. Live mode fails closed without a real adapter. | Connect a compatible merchant sandbox and retain its order/receipt evidence, or demo the existing path only as a labeled commerce simulation. |
| Working end-to-end experience, not screens only | H2, lines 33-45; H3, lines 52-89 | Text or image intake, scoped context, delivery goal/deadline, confirmed sizes, exact product media, address confirmation, incident evidence, Prava approval, same-chat result, and a durable claim packet/manual airline handoff are wired together. | Partial | No live merchant accepted an order, no dispatch exists, Tavra cannot submit the passenger-authenticated airline form, and no employer expense connector exists. | Connect one merchant and employer system. For airlines, demo the truthful official handoff and record submission only from independent confirmation evidence. |
| Clear user and problem | H2, lines 39-45 | `PRODUCT.md` identifies employees facing urgent work-travel disruption and a message-native recovery workflow. | Implemented | Evidence of demand is absent. | Add 2 to 3 short user interviews or a pilot statement if available. Do not fabricate traction. |
| Complete, visible action | H2, lines 41-45 | Secure approval can finish and notify the chat. | Partial | Current action ends before a verifiable merchant order, delivery, or reimbursement submission. | Show outcome-specific states: `payment authorized`, `merchant order accepted`, `delivery scheduled`, `claim packet ready`, `claim submitted`. Only show reached states. |
| Trust, permissions, controls, and clear outcome | H2, lines 41-45 and 173-175 | Explicit item/amount/address approval, user-confirmed location proposal, allowance display, server-side credentials, strict identity scope, exact-cent cart validation, payment idempotency, outcome reconciliation, durable case snapshots, and a packet-bound airline handoff authorization event exist. | Partial | Checkout state/outbox and app-card mappings are still in memory; substitution and employer submission permissions are absent; external airline submission still needs independent proof. | Persist authorization scope, checkout state, idempotency, cancellation, app-card state, and notification outbox in a transactional store. Add employer filing consent. |
| Original insight and product coherence | H2, lines 39-45 | Tavra separates incident understanding, recovery intent, deadline, profile confirmation, option review, delivery, payment, claim evidence, packet readiness, handoff authorization, and externally proven submission instead of dumping a fixed bundle. | Partial | Merchant discovery remains a Boston synthetic catalog, airline handoff is manual, and employer reimbursement stops at a draft. | Add live merchant trust evidence and show it changing the selected Prava-bound offer. |
| Product can be explained and defended | H2, line 39; H3, lines 60-67 | Architecture and local setup are documented in `README.md`. | Partial | Current truth boundary and production gaps were not collected in one concise artifact. | Use `PRODUCT_AUDIT.md` during judge Q&A and rehearse answers on model decisions, payment security, synthetic data, and failure handling. |
| New work built during hackathon is disclosed | H1, lines 25-40; H2, lines 197-201; H3, lines 301-320 | No completed disclosure was found. | Missing | Undisclosed pre-existing work may disqualify the submission. | Fill the disclosure in `DEMO_AND_SUBMISSION.md` with commit or timestamp evidence. |
| No fake transaction or misleading demo | H2, lines 39-45, 123, and 197; H3, lines 171-177 and 301-309 | Chat, checkout, ledger, logs, IDs, and runbook consistently call the downstream sandbox result simulated and say no live order, charge, dispatch, or delivery exists. Product media is mapped per synthetic SKU and labeled illustrative. | Implemented for current sandbox scope | A presenter can still overstate the outcome verbally, and illustrative per-SKU art is not official merchant evidence. | Keep the sandbox disclosure visible, preserve each product caption, and use the Mode B narration in `DEMO_AND_SUBMISSION.md`. |
| Complete checkout result shown when claiming an order | H2, line 123; H3, lines 171-177 | Prava polling, adapter invocation, report acknowledgement validation, same-chat notification, and reconciliation states are implemented. | Partial | `SIM-*` is simulation evidence, not a merchant order. The product therefore does not claim an order. | Integrate a real merchant adapter and capture its receipt before switching to order language. |
| Reliability and failure handling | H2, lines 45 and 187; H3, lines 276-282 | Tests cover webhook deduplication, deadline gates, image intake, address confirmation, notification retries, multiple credentials, report acknowledgement, environment/adapter mismatch, cancellation race, and reconciliation. | Partial | Checkout/session state and the notification outbox remain in memory, so restart recovery is incomplete. | Persist payment orchestration atomically, add webhook-based reconciliation, and run a clean-device end-to-end rehearsal. |
| Repository and secrets safe for judges | H2, line 197; H3, lines 301-309 | `.env` secrets are intended to stay local; raw card details remain in Prava. | Partial | A complete secret scan and demo privacy pass is not recorded. Personal phone/email and test-card details must not appear in video, logs, fixtures, or git history. | Run a secret scanner, use demo identities, redact logs and screenshots, and record the scan output as submission evidence. |

## Partner track tracker

| Track | What the handbook says judges want | Current implementation | Status | Highest-value gap | Evidence required before claiming the track |
|---|---|---|---|---|---|
| Prava overall | Working transaction, usefulness, originality, trust, future potential (H2, lines 167-169) | Prava is central to the secure authorization path. | Partial | No real merchant completion or durable commerce record. | Successful sandbox transaction identifiers, result/report-status logs, a truthful downstream merchant outcome, and demo video. |
| Visa Intelligent Commerce, $5,000 cash listed | Transaction completion, permissions, trust, controls, usefulness (H2, lines 173-175) | Prava issues/returns a one-time credential and the app reports an outcome. | Partial | The simulated merchant authorization is not proof of Visa commerce. Controls are not represented as a durable authorization object. | Show approved spending scope, amount, merchant/category, expiry, user confirmation, actual Prava/Visa confirmation supplied by the API, failure behavior, and truthful transaction outcome. |
| Linq iMessage Agent, $1,000 cash plus credits listed | Linq as the core interface, message-native UX, reliability, working transaction (H2, lines 177-180; H3, lines 249-265) | Signed webhook, typing indicator, inbound media, selection-driven per-line-item product media, consent-based location request/retrieval, same-chat completion, mutable Linq `imessage_app` payloads, terminal card updates, and a signed native Messages extension installed on the physical demo iPhone are implemented. | Partial | The installed extension has not yet been proven through the complete live Linq card, native review, Prava approval, and same-chat result sequence. Secure Prava approval remains a Safari-controlled modal rather than protected fields in the bubble. | Record the exact three-image/native-review/Prava flow on the physical iPhone, retain transaction and message-update evidence, and describe it accurately as payment from the Messages experience, not payment fields in a mutable bubble. |
| OpenAI | Model/tools must materially improve the experience and be reliable (H2, lines 169-171; H3, lines 232-239) | Responses API handles intent, constrained turn extraction, natural phrasing, and multimodal baggage-notice extraction. Deterministic contracts reject unsupported meetings, early sourcing, stale deadlines, and action claims. | Partial | There is no persisted evaluation corpus, latency/cost report, or model fallback policy; most commerce evidence remains synthetic. | Save redacted eval fixtures and metrics, then test corrections, OCR uncertainty, prompt injection in images, and provider failures. |
| Senso Discovery and Trust | Verified context must materially influence brand or merchant choice; judges assess source quality, traceability, relevance, and effect (H2, lines 189-191; H3, lines 284-289) | Employee profile and policy retrieval use exact scoped content IDs. Synthetic merchant documents influence the demo option. | Partial | Employee sizing alone does not satisfy this track. Merchant evidence is synthetic and current replies hide source traceability. | Retrieve current official/merchant evidence into Senso with URL, timestamp, hash, effective date, and trust class. Show a candidate rejected and another selected because of that evidence, then connect the selection to Prava. |
| Localhost Startup-Ready Product | Problem clarity, readiness, demand, distribution, founder commitment (H2, lines 181-183) | Focused use case, phone interface, and payment UX exist. | Partial | No durable backend, real fulfillment partner, employer pilot, unit economics, or traction evidence. | Add production architecture, narrow launch wedge, target buyer, pricing hypothesis, interview/pilot evidence, and roadmap. |
| Project NANDA adapter | Reusable Prava adapter, sandbox transaction, failures, docs, relevant pull request (H2, lines 185-187) | No NANDA adapter or pull request was found. | Not targeted | Entering would dilute the core product unless a reusable adapter is built separately. | Only claim if an installable adapter, failure suite, documentation, simulation, sandbox evidence, and required PR actually exist. |

Reward amounts above reproduce the supplied handbook and are not verified payout guarantees. H2 says published values remain subject to current partner rules (H2, lines 131-165).

## Recommended track priority

1. **Prava overall and Visa:** Make the authorization and resulting commerce outcome real, constrained, and independently verifiable.
2. **Linq:** Make the whole recovery feel native to Messages using image intake, typing, rich product media, and same-thread state updates.
3. **Senso:** Upgrade from profile lookup to traceable merchant discovery and trust selection.
4. **OpenAI:** Use multimodal extraction and evidence-aware planning to remove the rigid script without allowing unsupported assumptions.
5. **Localhost:** Frame the same narrow flow as a credible employee-benefits and travel-operations wedge.
6. **NANDA:** Do not target unless the required reusable adapter can be completed without weakening the main demo.

## Submission gates

Do not mark Tavra submission-ready until every applicable gate has named evidence:

- [ ] Live Devfolio deadline confirmed against Discord.
- [ ] One clean end-to-end run recorded from inbound iMessage to truthful final outcome.
- [ ] Prava sandbox transaction identifiers and redacted logs retained.
- [ ] Real merchant receipt retained, or every surface and narration clearly says `simulation`.
- [ ] No claim of delivery, airline filing, or reimbursement unless an external system accepted it.
- [ ] Senso source provenance visible for the merchant trust decision.
- [ ] Image notice extraction and correction flow demonstrated.
- [ ] Recovery case survives a server restart and repeated webhook delivery.
- [ ] Failure cases demonstrated: declined payment, expired link, unreadable image, unavailable merchant, and missing address.
- [ ] Personal data, API keys, payment credentials, and test-card data absent from repository and video.
- [ ] Demo video, judge-access link, screenshots, track evidence, writeup, and disclosure completed.
- [ ] Devfolio project status visibly says `Submitted`, not only saved as a draft (H3, lines 323-329).

## Source notes

- **H1:** `Build agents that act, shop, book, renew and pay. 48 hours. Online. $65,000 in …`, especially lines 1-50 for the event brief, lines 230-320 for rewards and tracks, and lines 25-40 for existing-work rules.
- **H2:** `AGENTIC COMMERCE HACKATHON / BUILDER HANDBOOK …` from attachment `eef2ab24-eab6-410f-a84a-1a29fca1fa5c`, especially lines 33-45 for expectations, 91-129 for Prava, 131-191 for tracks, 193-201 for merchant/rule/submission requirements, and 203-245 for timing and support.
- **H3:** `AGENTIC COMMERCE HACKATHON / BUILDER HANDBOOK …` from attachment `1842e3fd-11e0-4f03-851c-0beeab2cf81e`, especially lines 52-89, 133-185, 187-289, and 301-374. This export contains the internal deadline conflict described above.
- **Repository evidence:** `README.md`; `PRODUCT.md`; `src/openai.ts`; `src/message-reply.ts`; `src/linq.ts`; `src/prava.ts`; `src/senso.ts`; `src/event-store.ts`; and `senso/demo-corpus/README.md`.
