# T4 Checklist: reviewing AI-written documents

> Status: **Draft 0.1**, awaiting approval

| Item | Value |
|---|---|
| Use when | Reviewing specs, designs, reports, release notes or client deliverables that AI drafted |
| Filled by | Person B, or the document owner; PM/BrSE for Japanese text |
| Stored in | Review comment or the document's review record |
| Gate | G2, G3, G8 (client deliverables) |
| Rules | [Chapter 17](../02-playbook/ch17-reviewing-ai-output.md), [Chapter 11](../02-playbook/ch11-p1-requirements.md) |

---

## All documents

- [ ] Purpose and audience clear; matches the intent
- [ ] Facts, numbers, names, dates and references checked against the original material — **nothing invented**
- [ ] No contradiction with the spec, the ADR or the code
- [ ] Terms consistent with the project glossary
- [ ] No client data, personal data or secrets that should not be there
- [ ] AI involvement recorded

## Specifications and requirements

- [ ] Complete: edge cases and failure modes covered
- [ ] Consistent: no conflicting requirements
- [ ] Unambiguous: one reading only
- [ ] Verifiable: every requirement has a test or pass/fail criterion
- [ ] Every requirement traces to the intent
- [ ] Original Japanese wording kept next to translations of key requirements

## Designs and ADRs

- [ ] Options and trade-offs shown; assumptions and unknowns listed
- [ ] Security, data, operational impact and rollback covered

## Documents for Japanese clients

- [ ] Japanese checked by the PM/BrSE (not only machine translation)
- [ ] Business terms (受注, 出荷, 締め日 …) as the client uses them
- [ ] Format as the client expects (template, numbering, 版数 / version table)
- [ ] AI disclosure note included (Chapter 2, Rule 6)

## Decision

| Decision | Reviewer | Version reviewed | Date |
|---|---|---|---|
| approve / request changes / reject | | | |

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.0 | 2026-09-24 | — | Skeleton |
| 0.1 | 2026-09-24 | Claude (draft) | First content |
