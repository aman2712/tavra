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
| Use Prava meaningfully in the core commercial action | H2, lines 91-123; H3, lines 133-177 | Sandbox mode now performs UCP product discovery, an address-bound AED total, purchase-specific Prava approval, one-time-card retrieval, exactly one end-merchant checkout attempt, expected-decline classification, and Prava outcome reporting. Live mode retains the OAuth MCP order path. | Implemented; device proof pending | The repository path is complete, but the physical-iPhone approval and expected merchant decline must still be preserved as external evidence. | Run one clean sandbox transaction and retain the redacted Prava session, merchant attempt, decline, and outcome-report evidence for the production request. |
| Working end-to-end experience, not screens only | H2, lines 33-45; H3, lines 52-89 | Text or image intake, scoped context, confirmed sizes and destination, live discovery, exact UCP image, quote review, Prava approval, Browser Harness checkout, same-chat result, and merchant evidence in the claim packet are wired together. | Partial | Physical-iPhone completion, UAE merchant coverage, a real merchant order, dispatch, airline acceptance, and employer reimbursement still require external proof. | Record one complete device run. Treat order, dispatch, airline submission, and reimbursement as separate states and claim only those independently confirmed. |
| Clear user and problem | H2, lines 39-45 | `PRODUCT.md` identifies employees facing urgent work-travel disruption and a message-native recovery workflow. | Implemented | Evidence of demand is absent. | Add 2 to 3 short user interviews or a pilot statement if available. Do not fabricate traction. |
| Complete, visible action | H2, lines 41-45 | The live workflow distinguishes offer review, quote review, approval pending, merchant checkout, order confirmed, failure, cancellation, and reconciliation. A returned merchant order ID updates the same card and chat. | Partial | No preserved live merchant result or physical-device recording exists yet. Dispatch and reimbursement are later external actions. | Capture one returned merchant order ID and show the exact state transitions. Only narrate states reached in that run. |
| Trust, permissions, controls, and clear outcome | H2, lines 41-45 and 173-175 | Exact offer and quote confirmations, a confirmed Prava address ID, allowance display, server-side OAuth and payment state, exact-cent validation, caps, idempotency, reconciliation, durable SQLite checkout/card/outbox state, and packet-bound evidence exist. | Partial | Substitution, refund, and employer submission permissions are absent. External airline and fulfillment states still need independent proof. | Run security and restart acceptance tests, then add explicit substitution, refund, and employer filing consent before production. |
| Original insight and product coherence | H2, lines 39-45 | Tavra separates incident understanding, recovery intent, deadline, profile confirmation, live UCP discovery, offer approval, address-bound quote, payment approval, merchant order, claim evidence, packet readiness, and externally proven submission. | Partial | Live UCP coverage and a merchant order have not yet been proven for Abu Dhabi. Airline handoff is manual and employer reimbursement stops at a draft. | Preserve a live candidate, quote, and order or truthfully demonstrate the supported-market fallback with a separately approved address. |
| Product can be explained and defended | H2, line 39; H3, lines 60-67 | Architecture and local setup are documented in `README.md`. | Partial | Current truth boundary and production gaps were not collected in one concise artifact. | Use `PRODUCT_AUDIT.md` during judge Q&A and rehearse answers on model decisions, payment security, synthetic data, and failure handling. |
| New work built during hackathon is disclosed | H1, lines 25-40; H2, lines 197-201; H3, lines 301-320 | No completed disclosure was found. | Missing | Undisclosed pre-existing work may disqualify the submission. | Fill the disclosure in `DEMO_AND_SUBMISSION.md` with commit or timestamp evidence. |
| No fake transaction or misleading demo | H2, lines 39-45, 123, and 197; H3, lines 171-177 and 301-309 | Runtime modes are explicit. Live mode claims an order only from `shop_checkout`; sandbox mode treats only a verified test-card or insufficient-funds merchant decline as the successful capability result and records no order or expense. | Implemented in repository | A presenter can still overstate the expected decline as an order. | Use the mode-specific narration in `DEMO_AND_SUBMISSION.md` and show the expected-decline evidence when requesting production access. |
| Complete checkout result shown when claiming an order | H2, line 123; H3, lines 171-177 | Payment approval and merchant order are separate states. Tavra calls `shop_checkout` once, validates the returned amount and order ID, updates the same card/chat, and otherwise fails or requires reconciliation. | Partial | External live order and receipt evidence have not yet been recorded. | Complete one approved low-value run and preserve both the Prava state timeline and returned merchant order ID. |
| Reliability and failure handling | H2, lines 45 and 187; H3, lines 276-282 | Tests cover MCP response parsing, scopes, variants, money, cap, quote binding and expiry, duplicate checkout, unknown outcomes, restart reconciliation, webhook and attachment deduplication, chat revisions, location, image intake, and card trust boundaries. SQLite persists workflows, card mappings, conversation state, and the outbox. | Partial | A clean physical-device restart run and real MCP failure rehearsal still need evidence. Multi-node locking is not implemented. | Run the acceptance matrix on the linked account and physical iPhone, including restart during approval and forced unknown checkout. |
| Repository and secrets safe for judges | H2, line 197; H3, lines 301-309 | `.env` secrets are intended to stay local; raw card details remain in Prava. | Partial | A complete secret scan and demo privacy pass is not recorded. Personal phone/email and test-card details must not appear in video, logs, fixtures, or git history. | Run a secret scanner, use demo identities, redact logs and screenshots, and record the scan output as submission evidence. |

## Partner track tracker

| Track | What the handbook says judges want | Current implementation | Status | Highest-value gap | Evidence required before claiming the track |
|---|---|---|---|---|---|
| Prava overall | Working transaction, usefulness, originality, trust, future potential (H2, lines 167-169) | Prava MCP is central to discovery, quote, payment approval, and Browser Harness checkout. The workflow, authorization records, merchant result, card mapping, and outbox are durable. | Partial | The linked account, live quote, and real merchant order still need external proof. | Preserve OAuth readiness, the address-bound estimate, Prava approval state, one `shop_checkout` result, merchant order ID, and device recording. |
| Visa Intelligent Commerce, $5,000 cash listed | Transaction completion, permissions, trust, controls, usefulness (H2, lines 173-175) | Tavra records user approval for the exact merchant, variant, address, currency, and total, then delegates payment authorization to Prava and blocks ambiguous checkout retries. | Partial | No preserved live Visa or merchant result exists, and the sandbox card is not proof of live card acceptance. | Show the exact bounded authorization, trusted network ceremony, returned merchant order ID, and truthful failure or reconciliation behavior. |
| Linq iMessage Agent, $1,000 cash plus credits listed | Linq as the core interface, message-native UX, reliability, working transaction (H2, lines 177-180; H3, lines 249-265) | Signed webhook, typing indicator, text and image intake, consent-based location retrieval, durable stale-event suppression, one native live-product card, exact UCP image proxy, Prava modal, same-card mutation, and same-chat result are implemented. | Partial | The complete live sequence has not yet been recorded on the physical demo iPhone. Secure Prava approval correctly remains in a Safari-controlled modal. | Record location confirmation, UCP offer, quote review, native card, Prava approval, merchant order ID, card mutation, and same-chat result on the iPhone. |
| OpenAI | Model/tools must materially improve the experience and be reliable (H2, lines 169-171; H3, lines 232-239) | Responses API handles intent, constrained turn extraction, natural phrasing, and multimodal baggage-notice extraction. Deterministic state owns address, product, price, approval, checkout, and success claims. Contract violations use a natural fallback instead of failing the webhook. | Partial | A persisted evaluation report, latency and cost report, and physical-device OCR run remain missing. | Save redacted eval fixtures and metrics, then test corrections, OCR uncertainty, prompt injection in images, stale turns, and provider failures. |
| Senso Discovery and Trust | Verified context must materially influence brand or merchant choice; judges assess source quality, traceability, relevance, and effect (H2, lines 189-191; H3, lines 284-289) | Employee identity, sizes, email, allowance, and policy retrieval use exact scoped content IDs. Product stock, price, image, and delivery now come from Prava UCP rather than Senso. | Partial | Employee and policy context is material, but Senso-backed merchant trust comparison is not yet demonstrated. | Add current merchant-policy evidence with URL, timestamp, hash, effective date, and trust class, then show it rejecting or preferring a UCP candidate. |
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
- [ ] `npm run prava:link-commerce` succeeds and `/health/commerce` proves the required scopes and connected agent.
- [ ] Intended masked Prava address is present without a fabricated UAE postal code.
- [ ] Live UCP product, exact variant, merchant image, address-bound quote, and redacted logs retained.
- [ ] Real merchant order ID retained, or every surface and narration clearly says no order was created.
- [ ] Itemized merchant receipt retained, or the reimbursement packet visibly says receipt pending.
- [ ] No claim of delivery, airline filing, or reimbursement unless an external system accepted it.
- [ ] Senso source provenance visible for the merchant trust decision.
- [ ] Image notice extraction and correction flow demonstrated.
- [ ] Recovery case, conversation revision, card mapping, and checkout state survive a server restart and repeated webhook delivery.
- [ ] Failure cases demonstrated: declined payment, expired link, unreadable image, unavailable merchant, and missing address.
- [ ] Personal data, API keys, payment credentials, and test-card data absent from repository and video.
- [ ] Demo video, judge-access link, screenshots, track evidence, writeup, and disclosure completed.
- [ ] Devfolio project status visibly says `Submitted`, not only saved as a draft (H3, lines 323-329).

## Source notes

- **H1:** `Build agents that act, shop, book, renew and pay. 48 hours. Online. $65,000 in …`, especially lines 1-50 for the event brief, lines 230-320 for rewards and tracks, and lines 25-40 for existing-work rules.
- **H2:** `AGENTIC COMMERCE HACKATHON / BUILDER HANDBOOK …` from attachment `eef2ab24-eab6-410f-a84a-1a29fca1fa5c`, especially lines 33-45 for expectations, 91-129 for Prava, 131-191 for tracks, 193-201 for merchant/rule/submission requirements, and 203-245 for timing and support.
- **H3:** `AGENTIC COMMERCE HACKATHON / BUILDER HANDBOOK …` from attachment `1842e3fd-11e0-4f03-851c-0beeab2cf81e`, especially lines 52-89, 133-185, 187-289, and 301-374. This export contains the internal deadline conflict described above.
- **Repository evidence:** `README.md`; `PRODUCT.md`; `src/openai.ts`;
  `src/message-reply.ts`; `src/linq.ts`; `src/commerce.ts`;
  `src/prava-commerce.ts`; `src/prava-mcp.ts`; `src/live-commerce.ts`;
  `src/checkout-state-store.ts`; `src/recovery-state-store.ts`;
  `src/recovery-case.ts`; `src/senso.ts`; `src/event-store.ts`; and
  `senso/demo-corpus/README.md`.
