# T7 Checklist: contracts, NDAs and the project AI record

> Status: **Draft 0.1**, awaiting approval

| Item | Value |
|---|---|
| Use when | New contract or renewal; before AI touches any client material |
| Filled by | PM / BrSE with Person A; legal when needed |
| Stored in | Checklist: contract file; AI record: `docs/project/ai-record.md` |
| Related | Chapter 2 Rule 3; Chapter 3 §3.9 |
| Rules | [Chapter 2](../01-policy/ch02-ai-usage-policy.md), [Chapter 3](../01-policy/ch03-security-guardrails-and-client-data.md), [Chapter 7](../01-policy/ch07-compliance-and-standards.md) |

---

## Part A — Contract and NDA checklist

- [ ] Is AI use allowed? For which data, which tools, which countries?
- [ ] Must data stay in Japan (or another country)?
- [ ] May AI providers keep or train on the data? (Must be **no**.)
- [ ] Is AI allowed on **production logs and data**? (Asked separately.)
- [ ] Disclosure: must we tell the client, and in what form? (We always disclose.)
- [ ] Who owns AI-generated output? Any licence restrictions?
- [ ] Retention and deletion of client data and logs; deletion at project end?
- [ ] Incident notification: how fast, to whom?
- [ ] Personal data inside client material (APPI, Vietnam PDPL): allowed at all? Masking required?
- [ ] Any client rules on subcontractors or tools that conflict with our tool list?
- [ ] Checked against the METI AI contract checklist (Chapter 7)

Until the client answers in writing: **all client data is `client_restricted`** (no external AI).

## Part B — Project AI record

```markdown
# Project AI record — <project>

| Field | Value |
|---|---|
| Client and contract reference | |
| AI use allowed? | no / yes / yes with conditions |
| Allowed tools and model locations | |
| Data class for client material | |
| AI allowed on production logs and data? | no / yes, with masking |
| Disclosure format required by the client | own format / our standard note |
| Client contact who confirmed, and date | |
| Special conditions | |
| Person A / Person B | |
| Last reviewed | |

## Change log
| Date | Change | Confirmed by |
|---|---|---|
```

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.0 | 2026-09-24 | — | Skeleton |
| 0.1 | 2026-09-24 | Claude (draft) | First content |
