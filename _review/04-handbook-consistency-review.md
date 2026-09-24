# Review 04 — Handbook consistency and duplication

| Item | Value |
|---|---|
| Date | 2026-09-24 |
| Scope | Whole handbook: Part 0, Part I (Ch.1–9), Part II (Ch.10–20), templates (skeletons) |
| Method | Automated checks (terms, codes, numbers, cross-references, template names, tags) + cross-reading of topics that appear in several chapters |

## 1. Automated checks

| Check | Result |
|---|---|
| Cross-references "Chapter N §N.M", "codes table §N" | All resolve to existing sections |
| Links between files | No broken links |
| Template names (T1–T18) | Consistent everywhere |
| Repeated numbers (budget 80/100 %, loop > 3 calls, kill switch 5 min, audit ≥ 2 years, evidence 6 months, observation window 2 weeks, recertification and access review 3 months, incident report 15 min, review 48 h, review-time warning 2 h, CFR 15 %) | Consistent everywhere |
| Old codes ("Level 0–3", "Mức") | None left (only in version history) |
| Mentions of internal reference documents | None |

## 2. Fixed in this review

| # | Problem | Fix |
|---|---|---|
| F1 | "Human A / Human B" in the codes table and contents; "Person A / Person B" everywhere else | "Person A / Person B" everywhere |
| F2 | Five leftover citation lines in Ch.2 and one in the codes table after the citation clean-up | Removed |
| F3 | `[Proposal]` tags left in approved chapters (the writing style says to remove them once decided) | Removed from approved chapters; kept in drafts and in Ch.7 (provisional) |
| F4 | Codes table §2.1 listed 8 agent actions as "never, unless granted"; Ch.4 §4.7 splits them into 5 never-allowed (no override) and 4 allowed only with a specific HITL grant | Codes table aligned with Ch.4 (Ch.4 is stricter and more detailed) |
| F5 | Ch.4 §4.11 summarised gate approvers imprecisely | Aligned with codes table §4 |

## 3. Open — needs Harry's decision

| # | Issue | Where |
|---|---|---|
| O1 | **Agents before the platform.** Ch.2 Rule 9 says agents may be used only on internal work until the platform is ready. Ch.13 §13.9 and Ch.9 Step 1 describe using Claude Code and GitHub Copilot on project work under manual controls | Ch.2, Ch.9, Ch.13 |
| O2 | **Severity / SLA tables repeated** in the codes table §6.3, Ch.3 §3.11 and Ch.6 §6.4 (same values, different columns). Risk: they drift apart when one is changed | Codes, Ch.3, Ch.6 |
| O3 | **Incident handling in three places**: Ch.2 §2.8 (reporting), Ch.3 §3.11 (security incidents), Ch.6 §6.7 (AI incidents). Complementary, but steps are repeated | Ch.2, Ch.3, Ch.6 |
| O4 | **Principles in two places**: Ch.1 §1.8 (5 principles) and 0.4 (14 principles) | Ch.1, 0.4 |

## 4. Accepted overlaps (no change proposed)

- Gate approval tables in the codes table §4 and in Chapters 11–15 (phase view): same values, useful in each chapter.
- Data-class tables in Ch.2 §2.4 (what staff may paste) and Ch.3 §3.9.1 (how data is processed and stored): different purposes.
- Decision packet described in Ch.4 §4.5 and used in Ch.15, Ch.19: Ch.15 and Ch.19 refer to Ch.4.

## 5. Decisions on open items (Harry, 2026-09-24)

| # | Decision | Applied in |
|---|---|---|
| O1 | Supervised IDE assistants (Copilot; Claude Code with a person approving each step) allowed on client projects with written consent; autonomous agents only through the platform | Ch.2 v1.2 Rule 9; Ch.9 v1.1; Ch.13 v0.2 |
| O2 + O3 | SLA tables only in codes §6.3 and Ch.6 §6.4; single incident process in Ch.6 §6.7; Ch.2 and Ch.3 refer to it | Codes v1.3; Ch.2 v1.2; Ch.3 v1.1; Ch.6 v1.1 |
| O4 | Keep the 5 principles in Ch.1 with a link to 0.4 | Ch.1 v1.1 |
