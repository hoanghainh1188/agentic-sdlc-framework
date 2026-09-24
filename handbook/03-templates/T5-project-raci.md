# T5 Project RACI (2+N)

> Status: **Draft 0.1**, awaiting approval

| Item | Value |
|---|---|
| Use when | At project start (Sprint 0); update when people change |
| Filled by | PM / BrSE with Person A; approved by leadership |
| Stored in | `docs/project/raci.md` |
| Related | Chapter 5; project AI record |
| Rules | [Chapter 5](../01-policy/ch05-team-roles-and-accountability.md) |

---

## 1. People and hats

| Person | Role in 2+N | Hats worn on this project | Backup |
|---|---|---|---|
| | Person A | product owner, tech lead, intent engineer, agent operator | |
| | Person B | reviewer, security reviewer, incident commander | |
| | PM / BrSE | client interface (Japanese), disclosure, consent | |
| | Leadership contact | governance owner, exceptions, Critical incidents | |

Separation of duties check:
- [ ] Person B does not produce the changes they approve
- [ ] A backup reviewer is named
- [ ] One-person project? Then: borrowed Person B named · merges wait 1 working day · AI only on Low/Medium risk work

## 2. Agents on this project

| Agent (register ID) | Role (producer / validator / release / operations) | Max autonomy | Operator |
|---|---|---|---|

## 3. RACI

R = does · A = accountable · C = consulted · I = informed

| Activity | Person A | Person B | Agents | Leadership | Client (via PM/BrSE) |
|---|---|---|---|---|---|
| Intent Record, risk tier (G1) | A, R | C | R (draft) | I | C |
| Specification (G2) | A (B for High+) | C / A for High+ | R (draft) | — | C |
| Design and plan (G3) | R | A | R (options) | — | I |
| Run agents, budget (G4–G5) | A, R | I | R | — | — |
| Verification (G6) | C | A | R | — | — |
| Merge (G7) | C | A, R | — | — | — |
| Production release (G8) | R | A | R (package) | I (C for Critical) | I |
| Incidents | R | A (Medium/Low) | R (containment) | A (Critical/High) | I per contract |
| Exceptions, overrides | C | C | — | A | I if affected |
| Project AI record | A, R | C | — | I | C (consent) |

Add project-specific rows as needed.

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.0 | 2026-09-24 | — | Skeleton |
| 0.1 | 2026-09-24 | Claude (draft) | First content |
