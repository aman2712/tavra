# Tavra Senso Retrieval Playbook

This playbook defines bounded retrieval behavior for the Team Recovery demo.

## Identity resolution

Do not query Senso for a phone number. Tavra normalizes the Linq sender to E.164,
performs an exact private lookup, and obtains the employee profile content ID and
allowed company policy content IDs. An unknown or ambiguous number receives no
employee data and no Personal Recovery fallback.

## Employee context

Retrieve only the exact employee profile document. Return every known, missing,
stale, and conflicting size field with its source and confirmation timestamp.
Never infer a missing size from a prior order.

## Policy context query

Query: "For employee category client_facing_traveller and delayed baggage before
a client meeting, return the incident allowance, allowed categories, approval
threshold, prohibited changes, and required evidence. Preserve source IDs."

Restrict retrieval to the employee's allowed policy content IDs.

## Delta-only clarification

Compare the incident requirements with retrieved profile and policy fields:

- Report known values and ask for confirmation when they affect item variants.
- Ask for missing values only.
- Ask again for stale values when the policy-defined freshness window has passed.
- Surface conflicts instead of choosing one value.
- Bundle related missing fields into one concise message.

Example: "I have a medium T-shirt and 32-inch waist on file, but no inseam. Your
policy allows up to $175 for essential clothing and toiletries. What inseam
should I use, and which airline and arrival airport were involved?"

## Airline context

After the employee provides airline and airport, Tavra retrieves only official
airline or regulator pages from an allowlist, fills the airline-policy snapshot,
ingests it, waits for compilation, and queries only that snapshot. If freshness
or provenance fails, label the requirement unknown.

## Candidate evaluation

Query: "For Boston, an arrival deadline before 08:00, budget USD 175, medium
T-shirt, waist 32 and confirmed inseam, return merchant evidence and prior
outcomes. Separate verified checkout evidence from unverified delivery."

The backend, not the model, checks price ceilings and prohibited changes.

## Outcome query

Query: "Return previously verified checkout outcomes for the selected merchant,
destination Boston, and delayed-baggage context. State exactly what was observed
and whether delivery was independently verified."
