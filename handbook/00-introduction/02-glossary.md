# 0.2 Glossary

> Status: **Draft 0.1**, awaiting approval · Readers: everyone
> Codes (P1–P6, G1–G8, L0–L4, HITL/HOTL/AUDIT, risk tiers, PRI, Stage A/B/C) are defined in the [codes table](05-codes.md). This page explains words.
> The Japanese column helps BrSEs talk with clients. Many teams in Japan simply use the English term in katakana; confirm the client's own wording.

---

## A–C

| Term | Meaning in this handbook | Japanese (reference) |
|---|---|---|
| **Acceptance criteria** | Testable conditions that decide whether a requirement is met | 受入基準 |
| **ADR (Architecture Decision Record)** | A short record of a significant design decision, the options considered and why one was chosen (template T12) | アーキテクチャ決定記録 (ADR) |
| **Agent (AI agent)** | An AI assistant that can carry out several steps by itself: read, plan, change code, run tests. In this handbook: a tool + a model + instructions + permissions + context sources (Chapter 20) | AIエージェント |
| **Agent register** | The list of all agents in use, with owner, version, permissions and status | エージェント台帳 |
| **Agent run** | One execution of an agent on one task, from start to stop | エージェント実行 |
| **Approval** | A decision by a person with authority to let work continue, bound to an exact version | 承認 |
| **Artifact** | Anything produced during the work: a spec, a design, code, a test report, a release package | 成果物 |
| **Audit log** | An append-only record of who (or what) did what, when, and on which evidence. Kept at least 2 years | 監査ログ |
| **Autonomy level** | What an agent is allowed to do (L0–L4) | 自律レベル |
| **Blast radius** | How much can be affected if something goes wrong | 影響範囲 |
| **Break-glass** | Emergency access outside normal rules: short, limited, approved by a second person, always reviewed (Chapter 6) | 緊急時特権アクセス |
| **BrSE (Bridge System Engineer)** | The engineer who connects the Japanese client and the Vietnamese team | ブリッジSE |
| **Budget (token budget)** | The maximum AI usage cost allowed for a client, a task or a run | 予算（トークン予算） |
| **Client data** | Anything a client gives us or that we create for a client | 顧客データ |
| **Containment** | Stopping the damage from spreading: stop traffic, isolate, keep a safe state | 封じ込め |
| **Context** | The information an agent reads to do a task: code, documents, specs | コンテキスト |

## D–H

| Term | Meaning in this handbook | Japanese (reference) |
|---|---|---|
| **Data class** | The sensitivity label that decides where information may go: `public`, `internal`, `client_confidential`, `client_restricted`, `prohibited` (Chapter 2) | データ分類 |
| **Decision packet** | The information a reviewer needs to decide: intent, risk, scope, diff, evidence, cost, rollback plan, agent recommendation | 判断資料 |
| **Deferred approval** | An approval that does not stop independent work while it waits (Chapter 19) | 保留型承認 |
| **Escalation** | Handing a decision to a person with independent authority (Chapter 6) | エスカレーション |
| **Evidence** | Machine-readable proof that a check was done: test results, scan reports, approvals | エビデンス |
| **Evidence pack** | All evidence for one task, collected together (kept 6 months by default) | エビデンス一式 |
| **Gate** | A decision point that allows, blocks, pauses or escalates work (G1–G8). Different from a step, which does work (Chapter 10) | ゲート（関門） |
| **Guardrail** | A rule enforced by the system that keeps an agent within safe limits | ガードレール |
| **Hallucination** | AI output that looks right but is invented or wrong | ハルシネーション |
| **HITL / HOTL / AUDIT** | How people are involved: approve before (HITL), watch and can stop (HOTL), check samples after (AUDIT) | 人間参加型 / 人間監視型 / 事後監査 |

## I–P

| Term | Meaning in this handbook | Japanese (reference) |
|---|---|---|
| **Incident** | An event that caused, or nearly caused, harm (Chapter 6 §6.7) | インシデント |
| **Intent** | The goal of a task: purpose, outcomes, constraints, what must not be sacrificed, authority, stop rules. Belongs to people (Chapter 11) | 意図（インテント） |
| **Intent Record** | The written intent for a task (template T1) | インテント記録 |
| **Invariant** | A business or technical rule that must always hold | 不変条件 |
| **Kill switch** | A way to stop a running agent immediately | 緊急停止 |
| **Last known good version** | The most recent version confirmed to work, used as the rollback target (Chapter 18) | 最終正常版 |
| **Model** | The AI engine behind a tool (for example a Claude model). Different from the agent that uses it | モデル |
| **Observation window** | Time after release during which we watch for problems before counting a change as production-qualified (2 weeks) | 観察期間 |
| **Oversight mode** | How people are involved at a gate or action: HITL, HOTL or AUDIT | 監督方式 |
| **Person A / Person B** | The two people in control of a project in the 2+N model: owner/executor and independent reviewer/approver (Chapter 5) | 担当者A / 承認者B |
| **Platform** | Our self-hosted software that enforces the handbook's gates, budgets and records | プラットフォーム |
| **PQC (production-qualified change)** | A change that passed all gates, needed no major rework, and caused no problem during the observation window (Chapter 8) | 本番適格変更 |
| **Prompt** | An instruction given to an AI model for one task or turn. Different from intent | プロンプト |
| **Prompt injection** | Hidden instructions inside content (tickets, documents, web pages) that try to make the AI do something else | プロンプトインジェクション |
| **Provenance** | Where an artifact came from: which intent, tool, model, context and people | 来歴 |
| **Pull request (PR)** | A request to merge changes into a protected branch, reviewed at G7 | プルリクエスト |

## R–Z

| Term | Meaning in this handbook | Japanese (reference) |
|---|---|---|
| **Recertification** | The regular check (every 3 months) that an agent is still owned, useful, safe and correctly configured | 再認定 |
| **Release record** | The record that goes with a release: exact artifact, evidence, approvals, rollback, client disclosure (template T14) | リリース記録 |
| **Remediation record** | The record of a proposed fix in operations: symptom, hypothesis, evidence, action, risk, rollback, verification (template T15) | 対処記録 |
| **Risk tier** | Low, Medium, High or Critical; decides autonomy and oversight | リスク区分 |
| **Rollback** | Returning to the last known good state (Chapter 18) | ロールバック |
| **Run contract** | The platform's signed permission for one agent run: scope, tools, budget, expiry | 実行契約 |
| **Sandbox** | An isolated environment where an agent can work without affecting real systems | サンドボックス |
| **Separation of duties** | The person or agent that produced something never approves it | 職務分掌 |
| **Specification (spec)** | The testable description of what to build (Chapter 11) | 仕様書 |
| **Sprint 0** | A setup sprint before feature work, to prepare people, rules and agents (Chapter 10) | スプリント0 |
| **Step** | A piece of work in the workflow, such as "run tests". Different from a gate | 作業ステップ |
| **Task plan** | The breakdown of work for agents: files, tools, budget, done criteria, escalation rules (template T13) | タスク計画 |
| **Token** | The unit AI providers use to count text and charge for usage | トークン |
| **2+N team** | Two people in control plus N AI agents (Chapter 5) | 2+N体制 |

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.0 | 2026-09-24 | — | Skeleton |
| 0.1 | 2026-09-24 | Claude (draft) | First content: about 60 terms with Japanese reference terms |
