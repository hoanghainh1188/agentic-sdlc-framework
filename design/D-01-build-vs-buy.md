# D-01. Build vs buy

| Item | Value |
|---|---|
| Version | 0.5 |
| Date | 2026-09-24 |
| Status | **Approved** (Harry, 2026-09-24) |
| Readers | Leadership, tech lead / architect |
| Related decisions | Option C (build the full platform ourselves). Monorepo. Internal first, sell to clients later. GitHub + GitLab. Fully self-hosted. Models: both API and self-hosted |

---

## 1. Purpose

- Answer the question: **which components do we build, and which do we reuse?**
- Option C ("build the full platform") does not mean rewriting everything.
- This document identifies **the core that we really must write**, so that we can focus our effort there.

## 2. Scope

- Compare **component by component**, not whole products.
- Market information is current as of September 2026.
- Tool names, prices and versions change very quickly. **Check again before committing.**

## 3. Evaluation criteria

| # | Criterion | Why it matters to us |
|---|---|---|
| 1 | Licence | Can we use it commercially? Can we sell the framework to clients? |
| 2 | Self-hostable | Code and data of Japanese clients must stay on infrastructure we control |
| 3 | Cost | Limited budget |
| 4 | Vendor lock-in | How easy is it to switch later? |
| 5 | Maturity | Used in production yet, or still in preview? |
| 6 | Operating effort | Few people, no dedicated ops team |

---

## 4. General principle

[Doc] Draft v1.0 (section 5.1.2) states:
- **Do not rebuild 7 systems**: Git, CI runner, container registry, secret manager, monitoring, identity provider, deployment controller.
- **Only build what is specific to agents**: intent/spec registry, agent registry, run management, policy/gate orchestration, context snapshots, tool control, evidence/provenance, agent-aware audit.
- The platform is a **policy + orchestration + evidence layer** wrapped around existing tools.

[Proposal] This document keeps that principle, even with option C.

---

## 4b. Three confirmed decisions and their impact

| Decision | Impact on the design |
|---|---|
| **Internal use first, then sell to clients** | Design for **multi-tenancy** from day one (data separated per client/project). Only choose components whose licence allows commercial use and redistribution. Do not use third-party trademarks in the product name |
| **Code on both GitHub and GitLab** | The platform must be **independent of the code host**, with adapters for both. GitHub AI Controls only covers GitHub, so it cannot be the main governance layer |
| **Prefer fully self-hosted** | Managed services (AgentCore, Temporal Cloud, Langfuse Cloud) are removed from the main option. Every component must run with Docker/Kubernetes on our own infrastructure |

---

## 5. Component-by-component comparison

Conclusion labels:
- **REUSE**: use an existing tool; only configure it or write an adapter.
- **HYBRID**: use an existing engine; write our own business logic on top.
- **BUILD**: we must write it ourselves.

### 5.1. Coding agent

| Option | Type | Licence / price | Self-host | Notes |
|---|---|---|---|---|
| OpenHands | Open source | MIT | Yes | Runs the agent in a Docker sandbox. Works with many models. Has an SDK for integration |
| Aider | Open source | Apache 2.0 | Yes | Each AI change is a separate git commit; easy to review or revert |
| OpenCode | Open source | MIT | Yes | Written in TypeScript; works with many model providers |
| Claude Agent SDK | Commercial SDK | Pay per token | Model via API/Bedrock | Draft v1.0 proposed it as the agent runtime |
| GitHub Copilot cloud agent | SaaS | Copilot plan | No | Built into GitHub |

**Conclusion: REUSE.** [Proposal]
- Do not write our own coding agent. This is the fastest-moving part of the market.
- The platform should be able to **plug in several agents** (OpenHands, Claude, Copilot…) through one common adapter.

### 5.2. Intent / spec (task goal and specification)

| Option | Type | Licence | Notes |
|---|---|---|---|
| GitHub Spec Kit | Open source | MIT | Process + templates for spec-driven development. Works with Copilot, Claude Code, Gemini CLI… |
| OpenSpec | Open source | MIT | Lightweight; suits existing (brownfield) projects |
| Kiro | Commercial (AWS) | Paid | An IDE; cannot be embedded in our platform |

#### Further evaluation: BMAD Method

| Criterion | Assessment |
|---|---|
| What it is | A method + role-playing agents (PM, Architect, Developer, UX, Scrum Master…) that run inside IDE agents such as Claude Code, Cursor, Copilot. Covers analysis, planning, architecture and coding |
| Licence | MIT. **But "BMAD" and "BMAD-METHOD" are trademarks of BMad Code, LLC** |
| Maturity | v6 stable is released. It changes quickly: many skills are deprecated and will be removed in v7 |
| Strengths for us | Produces a full document set (PRD, architecture, epics/stories). Suits Japanese projects that need thorough documents. Has a TEA module (Test Architect): risk-based test strategy, automation, release gates |
| Weaknesses | Heavier than Spec Kit. Many personas → more tokens. Version changes can break the process. No storage, no link to PRs/evidence |
| Fit with gates | P1–P2 (G1, G2, G3). The TEA module supports P4 (G6) |

**Can we use BMAD? → Yes, as a "document generator", not as the source of truth.** [Proposal]
- Use BMAD for **large features** that need a full PRD and architecture.
- Use Spec Kit or OpenSpec for **small changes** (bug fixes, change requests). Or use only BMAD if we want a single tool.
- **The platform's Intent Registry is the source of truth.** The platform has its own neutral intent/spec format, with adapters that import output from BMAD / Spec Kit.
- **Pin the BMAD version.** Upgrade only with testing.
- When selling the product: **do not use the BMAD name** in the product name or marketing. Ask legal before claiming "BMAD compatible".

**Conclusion: HYBRID.** [Proposal]
- Reuse the **templates, process and agents** of BMAD (large features) and Spec Kit/OpenSpec (small changes).
- **Build our own intent/spec registry**, with IDs, versions, and links to PRs and evidence. None of the tools above has this.
- PoC needed: run BMAD and Spec Kit on the same feature; compare document quality and effort.

### 5.3. Workflow / multi-step orchestration

| Option | Type | Licence / price | Notes |
|---|---|---|---|
| Temporal | Open source | MIT. Paid Cloud edition available | Runs long workflows and resumes after failures. Supports waiting for human approval. SDKs for TypeScript, Java, .NET, Python |
| BullMQ | Open source | — | Job queue, lighter than Temporal. The draft suggested it for a light version |

**Conclusion: HYBRID.** [Proposal]
- Use **Temporal as the engine**.
- **Write our own G1–G8 workflow** on Temporal. This is the core.

### 5.4. Policy engine (rules that allow / block actions)

| Option | Type | Licence | Maturity | Notes |
|---|---|---|---|---|
| OPA (Rego) | Open source | Apache 2.0 | CNCF Graduated (2021) | Flexible, widely used. Rego is hard to learn |
| Cedar | Open source | Apache 2.0 | CNCF Sandbox (Oct 2025) | Easier to read. Formally verified. Used in AgentCore Policy |
| Dogwood | Open source | Apache 2.0 | New (Aug 2026) | Extends Cedar to reason about **sequences of agent actions**. AWS says the reference interpreter is not for production yet |

**Conclusion: REUSE the engine, WRITE our own rules.** [Proposal]
- Choose OPA or Cedar. A small PoC decides.
- Watch Dogwood; do not use it yet.

### 5.5. Sandbox (isolated environment for the agent)

| Option | Type | Price | Notes |
|---|---|---|---|
| Docker + git worktree | Open source | Infrastructure only | Proposed for the MVP in draft v1.0 |
| OpenHands sandbox | Open source | Infrastructure only | Included when using OpenHands |
| AgentCore Runtime | AWS, pay per use | About USD 0.0895 per vCPU-hour + USD 0.00945 per GB-hour (mid-2026) | Serverless; nothing to operate |

**Conclusion: REUSE.** [Proposal] Use Docker + git worktree. Because we prefer self-hosting, **we do not use AgentCore**.

### 5.6. Tool control / MCP gateway / access control

| Option | Type | Notes |
|---|---|---|
| GitHub Enterprise AI Controls + agent control plane | SaaS | GA since 2026-02-26. Audit logs, agent session views, custom agents. **The MCP allowlist is still in preview.** Only for GitHub Enterprise with Copilot |
| AgentCore Gateway + Identity + Policy | AWS, pay per use | Tools exposed over MCP. Policy blocks tool calls. Hidden cost: Policy is billed per tool call |
| Build our own gateway | — | High effort, high security risk |

**Conclusion: REUSE.** [Proposal]
- Do not write a gateway from scratch. This part is directly security-critical.
- Because we use both GitHub and GitLab and prefer self-hosting: **choose a self-hosted open-source MCP gateway** connected to the policy engine (section 5.4). Needs further research (open item).
- GitHub AI Controls: only as a supplement for projects on GitHub.

### 5.7. LLM observability

| Option | Type | Licence | Notes |
|---|---|---|---|
| Langfuse | Open source | MIT core. Enterprise modules need a licence | Tracing, evaluation, prompt management. Self-hostable, can run in a VPC without internet access. **Audit logs, SCIM and data-retention policies need a commercial licence when self-hosted** |
| OpenTelemetry | Open standard | Apache 2.0 | Common standard, no lock-in |
| AgentCore Observability | AWS | CloudWatch pricing | No free tier; costs have no cap |

**Conclusion: REUSE** Langfuse + OpenTelemetry for tracing. [Proposal]
- Note: **the compliance audit log must be built by us**; do not rely on the free Langfuse edition.

### 5.8. Automated verification (CI, security scans)

[Doc] Draft v1.0 proposes: GitHub/GitLab CI, Semgrep/CodeQL, Trivy, Gitleaks, Syft, Cosign.

**Conclusion: REUSE.** Only build the part that **collects results into an Evidence Pack**.

### 5.8b. Context layer (knowledge and context for the agent)

The context layer is where the agent finds documents, specs, meeting notes and relevant code before it works.

[Doc] Draft v1.0 proposes: PostgreSQL + pgvector, Tree-sitter, SCIP; move to Qdrant/OpenSearch when it grows.

#### Further evaluation: WeKnora (Tencent)

| Criterion | Assessment |
|---|---|
| What it is | LLM-based knowledge platform: RAG (retrieve documents, then answer), ReAct agent, auto-generated wiki, long-term memory |
| Licence | MIT |
| Technology | Go + frontend. Runs on Docker Compose or Kubernetes (Helm). Self-hosted, works offline |
| Maturity | Version 0.8.0 (not yet 1.0). About 26.8k GitHub stars. Very frequent releases |
| Vector DB | pgvector, Elasticsearch, OpenSearch, Milvus, Weaviate, Qdrant… → matches the pgvector choice in the draft |
| Data sources | Syncs from GitLab, Notion, Feishu… Reads 10+ formats: PDF, Word, Excel, PPT, images. **No GitHub, Backlog or Confluence source listed** |
| Agent access | Official MCP server (29 tools) and an agent-oriented CLI |
| Governance | Multi-workspace RBAC with 4 roles, per-workspace audit log, scoped API keys, encrypted credentials |
| Observability | Built-in Langfuse integration → matches section 5.7 |
| Models | Many providers, including Anthropic, OpenAI, LiteLLM, Ollama (local models) |

**Can we use WeKnora? → Yes, for "document knowledge".** [Proposal]

Good fit:
- Japanese project documents (要件定義書, 設計書, meeting notes, Q&A) are mostly Word/Excel/PDF. WeKnora reads these formats well.
- **Workspaces + RBAC** → knowledge separated per client. Fits multi-tenancy and future sales.
- Self-hosted, MIT → fits the "self-host" and "sell to clients" decisions.
- Our agents call WeKnora over MCP. No need to rebuild RAG.

Weak fit / risks:
- **It does not understand code.** No code-structure index (Tree-sitter/SCIP). We still need a separate "code context".
- **Overlapping features**: WeKnora has its own agent, sandbox and memory. **Turn these off** and use it only as a knowledge service, to avoid two places controlling agents.
- **Not yet 1.0**, changes fast → pin the version, test before upgrading.
- **No GitHub or Backlog connector** → we may need to write one or sync via files.
- **Check with clients**: some clients have rules about the origin of software, especially for a product we sell. Review the supply chain (dependencies, Docker images) per client requirements. This applies to every open-source component, not only WeKnora.

**Conclusion: HYBRID.** [Proposal]

| Type of context | Proposed tool |
|---|---|
| Project documents (specs, designs, minutes, Q&A) | **WeKnora** (via MCP) |
| Code (structure, symbols, file links) | Tree-sitter / SCIP + pgvector (as in the draft) |
| Context snapshot for each run (for audit) | **Build** inside the Run Manager: record what the agent read |

PoC needed: load a real (anonymised) project document set into WeKnora and measure search quality on Japanese documents.

### 5.8c. LLM gateway and self-hosted models

Decision: use **both API models and self-hosted models**. Details in [D-07](D-07-model-and-token-management.md).

| Component | Choice | Conclusion |
|---|---|---|
| LLM gateway (single entry point for all model calls, with budgets, routing, logs) | LiteLLM Proxy (open source, self-hosted) | **REUSE** |
| Serving self-hosted models | vLLM (Apache 2.0) | **REUSE** |
| Budgets per intent / run / gate, cost reports per client | — | **BUILD** (Cost Controller) |

### 5.8e. Object storage and cache (added after review)

| Need | Not used | Used | Reason |
|---|---|---|---|
| S3-compatible storage (Evidence Packs, Langfuse) | MinIO: repo archived on 2026-04-25, no longer maintained; AGPLv3 | **SeaweedFS** (Apache 2.0) | Runs on a single node; mature. RustFS is still alpha; Garage is AGPLv3 |
| Cache / rate limiting (LiteLLM, Langfuse) | Redis: RSALv2 + SSPLv1 since 7.4; Redis 8 added AGPLv3 | **Valkey** (BSD, Linux Foundation) | Redis-protocol compatible |

### 5.8d. Secret manager

| Option | Licence | Conclusion |
|---|---|---|
| HashiCorp Vault | BSL 1.1 (not open source by OSI definition). Restricts offering it as a competing product | Fine for internal use. Needs legal review before selling |
| **OpenBao** | MPL 2.0, Linux Foundation, fork of Vault 1.14 | **REUSE** [Proposal]. Vault-compatible API |

Details: D-03 section 8.1.

### 5.9. All-in-one products, for reference

| Product | Assessment |
|---|---|
| GitHub Enterprise AI Controls | Strong governance for agents inside GitHub. No G1–G8 gates, no intent registry, nothing outside GitHub |
| Amazon Bedrock AgentCore | 12 components, pay per use, no fixed fee. AWS lock-in. Memory and Identity are hard to move elsewhere |
| OpenHands Agent Canvas | Self-hosted agent control centre. Runs OpenHands, Claude Code, Codex. Still in beta |
| ESF (fork of Machinist) | Small MIT project. Architecture very close to ours: Task → Temporal → sandbox → agent → verification → evidence. **Worth reading for design ideas**; not for direct use |

[Proposal] No product covers **G1–G8 + intent registry + client-facing evidence**. This justifies building the core ourselves.

---

## 6. Summary: what we build

| # | Component we build | Based on | Priority (proposal) |
|---|---|---|---|
| 1 | **Gate Orchestrator**: runs G1–G8, stores approval decisions | Temporal | Highest |
| 2 | **Intent / Spec Registry**: IDs, versions, PR links | PostgreSQL + Spec Kit / BMAD templates | High |
| 3 | **Run Manager**: manages agent runs, assigns run_id | Temporal + agent adapter | High |
| 4 | **Evidence Pack**: collects CI, tests, scans, reviews per task | Existing CI results + SeaweedFS | High |
| 5 | **Compliance audit log**: append-only, hash chain | PostgreSQL + hash anchored to S3 storage | High |
| 6 | **Git adapter**: GitHub (MVP), GitLab (later) | GitHub, GitLab APIs | High |
| 7 | **Cost Controller**: token budgets per intent / run / gate, cost reports per client | LiteLLM + Langfuse | High |
| 8 | **Policy bundle**: autonomy rules, tool permissions, model routing | YAML (MVP) → OPA or Cedar | Medium |
| 9 | **Agent adapter**: plug in OpenHands / Claude / Copilot | Each agent's SDK / REST API | Medium |
| 10 | **Spec adapter**: import BMAD / Spec Kit output into the registry | Markdown / YAML files | Medium |
| 11 | **Context layer**: code index + context snapshots. Documents via WeKnora | WeKnora + Tree-sitter/SCIP + pgvector | Medium |
| 12 | **Project management integration**: Backlog / Jira / GitHub Issues | Existing APIs | Medium |
| 13 | **Client reports**: export evidence per task | Evidence Pack | Low (after the pilot) |

[Doc] Items 1–5, 8, 9, 11 match "what the platform builds" in draft v1.0 (section 5.1.2).
[Proposal] Items 6, 7, 10, 12, 13 were added for our context (GitHub + GitLab, tokens, Japanese projects).

**In short:** option C = **build 13 core components**, reuse about 10 existing ones.

---

## 7. Risks and items to verify (PoC)

| # | Risk / question | How to verify |
|---|---|---|
| 1 | Staffing: building these components needs a stable team over time | Leadership decides headcount and duration. Not set by us |
| 2 | Is self-hosted Temporal too heavy for a small team? | PoC with one G1–G3 workflow |
| 3 | OPA or Cedar? | PoC: write the same 5 rules in both |
| 4 | Langfuse: which parts need an Enterprise licence? | Re-read the licence page. Ask for a quote if needed |
| 5 | GitHub AI Controls needs the Enterprise plan | Check the company's current GitHub plan |
| 6 | AgentCore: which components are available in the Tokyo region? | Check the AWS regions page |
| 7 | If we **sell the framework**: do all licences allow it? | Review each component's licence. Ask legal |
| 8 | BMAD and WeKnora change versions quickly | Pin versions. Run a regression suite before upgrading |
| 9 | Self-hosted models need GPUs and may be weaker | PoC comparison in D-07 |
| 10 | The market moves fast; parts we build may be replaced by products | Review this document every 3 months |

---

## 8. Open questions for leadership

- ~~Internal or for sale?~~ → Decided: internal first, sell later.
- ~~Where is the code?~~ → Decided: GitHub + GitLab.
- ~~Self-hosted or managed?~~ → Decided: fully self-hosted.
- ~~Which models?~~ → Decided: both API and self-hosted (see D-07).
- How many people, for how long, to build the platform?

---

## 9. References

**Internal**
- Draft v1.0 "AI-Agentic-SDLC-Handbook", sections 0.6, 5.1.2, 5.8, 5.10.5.

**External** (accessed 2026-09-24)
- GitHub Changelog, Enterprise AI Controls & agent control plane GA (2026-02-26): https://github.blog/changelog/2026-02-26-enterprise-ai-controls-agent-control-plane-now-generally-available/
- AWS, Amazon Bedrock AgentCore pricing: https://aws.amazon.com/bedrock/agentcore/pricing/
- AWS, AgentCore GA: https://aws.amazon.com/about-aws/whats-new/2025/10/amazon-bedrock-agentcore-available
- CloudBurn, AgentCore pricing breakdown (May 2026): https://cloudburn.io/blog/amazon-bedrock-agentcore-pricing
- OpenHands on GitHub: https://github.com/OpenHands/openhands
- Security Boulevard, 9 Open-Source AI Coding Agents Worth Self-Hosting (June 2026): https://securityboulevard.com/2026/06/9-open-source-ai-coding-agents-worth-self-hosting/
- GitHub Spec Kit: https://github.com/github/spec-kit
- Spec-driven tools comparison (community): https://github.com/cameronsjo/spec-compare
- Temporal: https://temporal.io/
- CNCF, Open Policy Agent: https://www.cncf.io/projects/open-policy-agent-opa/
- CNCF, Cedar: https://www.cncf.io/projects/cedar
- InfoQ, AWS Dogwood (Aug 2026): https://www.infoq.com/news/2026/08/aws-dogwood-agent-policy/
- Langfuse, self-hosting: https://langfuse.com/self-hosting
- Langfuse, why open source (licence): https://langfuse.com/handbook/chapters/open-source
- MinIO on GitHub (archived): https://github.com/minio/minio
- RustFS vs SeaweedFS vs Garage (Elestio): https://blog.elest.io/rustfs-vs-seaweedfs-vs-garage-which-minio-alternative-should-you-pick/
- Redis 8.0 adds AGPLv3 (Phoronix): https://www.phoronix.com/news/Redis-8.0-Goes-AGPLv3
- Valkey vs Redis (computingforgeeks): https://computingforgeeks.com/valkey-vs-redis-migration/
- ESF (design reference): https://github.com/mitkox/esf
- Tencent WeKnora: https://github.com/Tencent/WeKnora
- BMAD Method: https://github.com/bmad-code-org/BMAD-METHOD
- BMAD Method changelog: https://github.com/bmad-code-org/BMAD-METHOD/blob/main/CHANGELOG.md

Reliability notes:
- AgentCore prices come from third-party analyses quoting the AWS page. Check the AWS page before budgeting.
- spec-compare and ESF are community projects, for reference only.

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-09-24 | Claude (draft) | First version |
| 0.2 | 2026-09-24 | Claude (draft) | Added 3 decisions (internal → sell, GitHub + GitLab, self-host). WeKnora, BMAD evaluations |
| 0.3 | 2026-09-24 | Claude (draft) | Added LLM gateway, self-hosted models, Cost Controller (details in D-07) |
| 0.4 | 2026-09-24 | Claude (draft) | After review: SeaweedFS replaces MinIO, Valkey replaces Redis; 13 build components renumbered |
| 0.5 | 2026-09-24 | Claude | Translated into English. Content unchanged (risk rows renumbered 1–10) |
