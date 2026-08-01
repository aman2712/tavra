# RUNTIME TEMPLATE — Official Merchant Evidence Snapshot

Do not ingest this empty template as evidence.

- Merchant legal/domain identity: `{{MERCHANT_ID}}`
- Official product URL: `{{PRODUCT_URL}}`
- Official delivery/returns URL: `{{POLICY_URL}}`
- Retrieved at: `{{RETRIEVED_AT_ISO8601}}`
- Content hash: `{{SHA256}}`
- Destination: `{{DESTINATION}}`

## Verified product facts

- Product ID and title: `{{VALUE}}`
- Exact variant and size: `{{VALUE}}`
- Condition: `{{VALUE}}`
- Unit price and currency: `{{VALUE}}`
- Inventory state: `{{VALUE}}`
- Delivery promise and cutoff: `{{VALUE}}`
- Return terms: `{{VALUE}}`
- Subscription or add-on state: `{{VALUE}}`

## Selection boundary

Only facts visible on allowlisted official merchant pages may be marked verified.
Cart tax, shipping, fees, seller identity, inventory, and delivery must be
reconciled again immediately before checkout.
