# Chapter 7. Compliance and reference standards

> Readers: **leadership** (approval), PM/BrSE · Reading time: about 15 minutes
> Status: **Provisionally approved** (Harry, 2026-09-24) — version 0.9. **Legal review pending**; becomes 1.0 after the lawyer's review.
> **This chapter is not legal advice.** It lists what we know as of September 2026 and how the handbook responds. Leadership should confirm the legal points with a lawyer before relying on them.

---

## 7.1. Purpose

- Know **which laws and standards apply** to our use of AI, in Vietnam (where we work) and in Japan (where our clients are).
- Separate **binding law** from **voluntary guidance**, so that we do not over- or under-comply.
- Show **where the handbook already covers** each requirement, and what is still open.

## 7.2. Scope

| In scope | Out of scope |
|---|---|
| Our use of AI tools and agents in software delivery; client data; personal data in our work; selling the platform later | Sector-specific rules of our clients' own businesses (finance, health…) — checked per project through the contract |
| Vietnam and Japan | EU rules (EU AI Act, GDPR) — only if we take EU clients [Proposal] |

---

## 7.3. Our position

| Role | When |
|---|---|
| **Deployer / user of AI** | Today: we use Claude and GitHub Copilot in our work |
| **Processor of client data** (including personal data inside it) | On client projects |
| **Provider of an AI system** | Later, if we sell the platform to clients |

---

## 7.4. Vietnam

| Instrument | Status | Why it matters to us | Binding? |
|---|---|---|---|
| **Law on Artificial Intelligence** (No. 134/2025/QH15) | Passed 2025-12-10, in force since **2026-03-01**. Grace period for AI systems already in operation until 2027-03-01 (2027-09-01 for health, education, finance) | Risk-based framework; the human remains the final decision-maker for important decisions. Detailed rules (risk classification, transparency and labelling, incident reporting) are still being issued by decree | **Yes** |
| **Law on Personal Data Protection** (No. 91/2025/QH15) + **Decree 356/2025/ND-CP** | In force since **2026-01-01**; replaces Decree 13/2023 | Applies whenever we process personal data, including personal data inside client material. Impact assessments are required, including for **cross-border transfer** of personal data | **Yes** |

[External] Baker McKenzie (Feb 2026) on the AI Law timeline; DLA Piper and DFDL (2026) on the PDPL and Decree 356. Links in 7.9.

**What this means for us** [Proposal, to be confirmed by a lawyer]:
- Sending personal data to an AI service whose servers are outside Vietnam may count as a **cross-border transfer**. The simplest control is the one we already have: **personal data is `prohibited` for AI tools** (Chapter 2, Rule 2 and Rule 4). Use fake or masked data.
- When the AI Law's implementing decrees are issued, check: whether our platform (when sold) falls into a risk class; labelling or transparency duties; incident reporting thresholds.

---

## 7.5. Japan (our clients)

| Instrument | Status | Why it matters to us | Binding? |
|---|---|---|---|
| **AI Promotion Act** | In force (2025) | A promotion and coordination law; no direct penalties on companies | Framework law, no direct duties for us |
| **AI Guidelines for Business Ver 1.2** (METI / MIC) | Issued **2026-03-31** | Japanese clients use it as their reference. Ver 1.2 adds definitions for **AI agents** and stresses that **human judgement remains essential** | **No** (soft law), but clients expect it |
| **Act on the Protection of Personal Information (APPI)** | In force | Applies to personal information of people in Japan inside client material | **Yes** (applies to our clients, and to us through contracts) |
| **METI checklist for AI use and development contracts** | Published 2025 | Points to check in AI-related contracts | No; a practical checklist |

[External] METI/MIC AI Guidelines for Business Ver 1.2 (2026-03-31), and summaries of Japan's framework (IBA; regulatory trackers, 2026). Links in 7.9.

**What this means for us** [Proposal]:
- Expect Japanese clients to ask about **human oversight, transparency, data handling and accountability** for AI. Our answers are Chapters 2–6 (human approval, disclosure, data classes, audit).
- Use the METI contract checklist when reviewing contracts (template T7).
- Personal information of people in Japan stays **out of AI tools** unless the client has explicitly allowed it and the contract covers it.

---

## 7.6. Voluntary standards we align with

| Standard | Use in this framework |
|---|---|
| **ISO/IEC 42001:2023** (AI management system) | Structure for governance, risk, operation, evaluation and improvement. Our Chapters 4–9 cover its clauses 4–10 at SME scale. **Certification: decided later**, when we prepare to sell the platform (decision: Harry, 2026-09-24) |
| **NIST AI Risk Management Framework** (and its generative-AI profile) | Common vocabulary for AI risk (govern, map, measure, manage) |
| **OWASP Top 10 for Agentic Applications** (ASI01–ASI10) | Threats for AI agents; used in Chapter 3 |
| **DORA metrics** | Delivery performance; used in Chapter 8 |

---

## 7.7. Where the handbook covers each requirement

| Requirement theme | Sources | Covered in |
|---|---|---|
| Human remains the final decision-maker | VN AI Law; JP Guidelines Ver 1.2 | Ch.4 (HITL, veto), Ch.5 (2+N) |
| Risk-based controls | VN AI Law; ISO 42001 cl. 6; NIST RMF | Codes table §3–§4; Ch.4 |
| Transparency to users and clients | VN AI Law (decree pending); JP Guidelines | Ch.2 Rule 6 (always disclose) |
| Personal data protection, cross-border transfer | VN PDPL + Decree 356; JP APPI | Ch.2 Rules 2–4 (`prohibited` class); Ch.3 §3.9 |
| Security of AI systems | OWASP Agentic; ISO 42001 Annex A | Ch.3 |
| Incident handling and reporting | VN AI Law (thresholds pending); ISO 42001 cl. 10 | Ch.3 §3.11, Ch.6 §6.7 |
| Accountability and records | ISO 42001 cl. 7.5, 9; JP Guidelines | Ch.5 §5.10; Ch.6 §6.10; audit log ≥ 2 years (Ch.3) |
| Management review and improvement | ISO 42001 cl. 9–10 | Ch.6 (monthly leadership review); Ch.8; Ch.9 |
| Competence and awareness | ISO 42001 cl. 7.2–7.3 | Ch.9 §9.8 |
| Contracts with clients | METI AI contract checklist | Template T7 |

---

## 7.8. Keeping up to date

| What | Who | When |
|---|---|---|
| Watch for Vietnam AI Law implementing decrees and PDPL guidance | Compliance owner [to confirm] | Quarterly; immediately when a decree is issued |
| Watch Japan's AI Basic Plan and guideline revisions | PM/BrSE lead | Quarterly |
| Legal review of this chapter | External lawyer (name [to confirm]) | After provisional approval (decision: Harry, 2026-09-24), then yearly |
| Review client contracts for AI terms | PM/BrSE with Person A | At every new contract or renewal |

---

## 7.9. References

**External** (accessed 2026-09-24)
- METI / MIC, AI Guidelines for Business Ver 1.2 (2026-03-31) — summary and status: https://vorplabs.com/ai-regulatory-updates/japan/2026-07/ai-promotion-act-basic-plan-business-guidance and https://zenn.dev/syoshida07/articles/8a428180adb5c3?locale=en
- International Bar Association, Japan's emerging framework for responsible AI: https://www.ibanet.org/japan-emerging-framework-ai-legislation-guidelines
- Lexology, Japan: guide for AI contracts (METI checklist): https://www.lexology.com/library/detail.aspx?g=6b261bcf-1a72-48dd-8992-ca09d72c7136
- Baker McKenzie, Vietnam: Artificial Intelligence Law — foundation and outlook (2026-02): https://www.bakermckenzie.com/en/insight/publications/2026/02/vietnam-artificial-intelligence-law-foundation-and-outlook
- DLA Piper, Data protection laws in Vietnam: https://www.dlapiperdataprotection.com/?t=law&c=VN
- DFDL, Vietnam personal data protection 2026: https://www.dfdl.com/insights/legal-and-tax-updates/vietnam-personal-data-protection-2026-what-foreign-organizations-need-to-know/
- ISO/IEC 42001:2023: https://www.iso.org/standard/81230.html
- NIST AI Risk Management Framework: https://www.nist.gov/itl/ai-risk-management-framework
- OWASP GenAI Security Project (Top 10 for Agentic Applications): https://genai.owasp.org/

Reliability notes: summaries of the Japanese guidelines come from secondary sources; check the official METI page before relying on specific wording. Vietnamese implementing decrees for the AI Law were still pending at the time of writing.

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.0 | 2026-09-24 | — | Skeleton |
| 0.1 | 2026-09-24 | Claude (draft) | First content |
| 0.9 | 2026-09-24 | Harry | Provisionally approved; ISO 42001 certification decided later; legal review after approval |
