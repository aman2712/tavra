# Tavra Senso Demo Corpus

This corpus is generated specifically for Tavra's Team Recovery hackathon demo.
It is safe to use as synthetic sandbox data, but it must never be represented as
a real employer, airline, regulator, merchant, airport, inventory, delivery, or
reimbursement policy.

## Trust classes

- `synthetic_org_authority`: company-owned demo facts, such as the employee
  profile and internal spending policy. These are authoritative only inside the
  sandbox story.
- `synthetic_demo_evidence`: fictional merchant and product evidence used to
  keep the offline demo deterministic. It must never drive a production order.
- `official_external_snapshot`: airline, regulator, airport, and real merchant
  evidence fetched from an allowlisted official URL during the workflow. The
  templates in this corpus are not evidence until populated.
- `verified_outcome`: facts observed from Tavra's own completed checkout. A
  checkout result does not prove delivery.

## Seed into Senso

Ingest these documents before the demo:

1. `employees/emp_demo_001.md`
2. `policies/team-recovery-policy.md`
3. `policies/reimbursement-evidence-policy.md`
4. `merchants/demo-merchant-a.md`
5. `merchants/demo-merchant-b.md`
6. `products/boston-delayed-baggage-catalog.md`
7. `outcomes/demo-prior-merchant-outcome.md`

The matching JSON files remain the deterministic application-side records. The
Markdown equivalents exist because the current Senso CLI upload path rejects
`application/json`. Do not ingest `queries/retrieval-playbook.md`; it contains
Tavra retrieval instructions, not company facts.

Do not ingest the files under `templates/` as facts. Tavra fills them from
official sources at runtime and ingests the completed snapshot with provenance.

## Identity boundary

The Linq sender number is resolved by Tavra through an exact private mapping to
`employee_id`. Senso is then queried using the exact employee profile content
ID plus the permitted company policy content IDs. Never use semantic search to
guess a person from a phone number, and never query across all employee
profiles. `../demo-config/identity-map.example.json` is backend configuration,
not Senso knowledge.

## Demo scenario

The synthetic traveller reports delayed baggage before an 08:00 client meeting
in Boston. The profile contains a medium T-shirt and a 32-inch trouser waist,
but no inseam. The company policy permits up to USD 175 for essential clothing
and toiletries. Demo Merchant A is cheaper but lacks verifiable delivery and
return terms. Demo Merchant B is selected because the sandbox evidence is
complete and a prior verified checkout outcome exists.

## Runtime source policy

Use web retrieval only against allowlisted official domains. Record the source
URL, page title, retrieval timestamp, effective date when available, content
hash, and the exact facts extracted. If a fact cannot be verified or the source
is stale, Tavra must ask the employee, exclude the option, or label the fact as
unknown instead of filling the gap with model knowledge.
