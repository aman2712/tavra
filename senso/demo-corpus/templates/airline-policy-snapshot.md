# RUNTIME TEMPLATE — Official Airline Policy Snapshot

Do not ingest this empty template as evidence.

- Airline legal name: `{{AIRLINE_NAME}}`
- Airline code: `{{AIRLINE_CODE}}`
- Arrival airport: `{{AIRPORT_CODE}}`
- Official source URL: `{{OFFICIAL_SOURCE_URL}}`
- Source page title: `{{SOURCE_PAGE_TITLE}}`
- Retrieved at: `{{RETRIEVED_AT_ISO8601}}`
- Effective date: `{{EFFECTIVE_DATE_OR_UNKNOWN}}`
- Content hash: `{{SHA256}}`
- Retrieval allowlist result: `{{PASSED_OR_FAILED}}`

## Verified relevant facts

- Delayed-baggage reference required: `{{VALUE_WITH_SOURCE_TEXT}}`
- Purchase reasonableness rule: `{{VALUE_WITH_SOURCE_TEXT}}`
- Eligible emergency categories: `{{VALUE_WITH_SOURCE_TEXT}}`
- Receipt requirements: `{{VALUE_WITH_SOURCE_TEXT}}`
- Claim deadline: `{{VALUE_WITH_SOURCE_TEXT}}`
- Submission channel: `{{VALUE_WITH_SOURCE_TEXT}}`

## Confidence and gaps

- Verified facts: `{{LIST}}`
- Missing or ambiguous facts: `{{LIST}}`
- Tavra behavior when incomplete: prepare a claim-ready receipt, mark the claim
  status incomplete, and ask only for the missing incident evidence. Do not claim
  that a reimbursement request was filed.
