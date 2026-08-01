# DEMO POLICY — Reimbursement Evidence Requirements 2026

This synthetic internal policy describes the evidence Tavra should collect for
a claim-ready Recovery Receipt. The MVP prepares evidence; it does not submit an
airline, insurer, card-benefit, or employer reimbursement claim.

## Required internal evidence

- Employee ID and applicable policy version.
- Incident description, business objective, destination, and deadline.
- Airline name and arrival airport.
- Baggage irregularity or delayed-baggage reference when available.
- Itemized merchant receipt.
- Exact items, sizes, quantities, condition, taxes, fees, and final total.
- Approval or reauthorization record.
- Reason each purchased item was necessary and reasonable.

## External policy evidence

Airline and regulator requirements must come from an official source retrieved
during the workflow. Store the source URL, title, retrieved timestamp, effective
date when available, content hash, and relevant quoted facts in a Senso policy
snapshot. If current requirements cannot be verified, mark reimbursement status
as `incomplete` and tell the employee what is missing.

## Truth boundary

Checkout completion and an order ID prove only that the merchant accepted the
order. They do not prove delivery, reimbursement eligibility, claim submission,
or reimbursement payment.
