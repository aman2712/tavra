# DEMO POLICY — Northstar Consulting Team Recovery Policy 2026

This synthetic policy exists only for the Tavra hackathon sandbox. It is not a
real employer policy and has no production authority.

## Purpose

Support employees whose trip continuity is at risk because checked baggage is
delayed before a time-sensitive business obligation.

## Eligible employee category

Category: `client_facing_traveller`

- Incident allowance: USD 175 inclusive of tax, shipping, and fees.
- Self-approval: allowed at or below USD 175 when all other rules pass.
- Manager reauthorization: required above USD 175 and at or below USD 300.
- Above USD 300: denied for the delayed-baggage workflow.

## Allowed categories

- One basic client-appropriate shirt or T-shirt.
- One basic pair of trousers.
- Essential toiletries in travel-size or ordinary non-luxury quantities.
- One presentation adapter or charger only when required for the stated
  business objective and not otherwise available.

## Prohibited categories and changes

- Luxury, designer, collectible, used, refurbished, or open-box items.
- Alcohol, tobacco, jewelry, gifts, subscriptions, memberships, or warranties.
- Merchant substitution after approval.
- Product, size, condition, quantity, or delivery-window substitution after
  approval.
- Delivery after the employee's stated continuity deadline.

## Required decision inputs

- Confirmed incident type and business objective.
- Deadline and destination.
- Employee category and remaining incident allowance.
- Exact size or variant for every sized item.
- Verifiable merchant, price, condition, return terms, and delivery evidence.

## Deterministic enforcement

Senso provides this policy as evidence. Tavra code calculates totals and returns
`ALLOW`, `REAUTHORIZE`, or `DENY`. OpenAI may explain the result but may not
override it.
