# D-09. Sample pilot repo: order and inventory management

| Item | Value |
|---|---|
| Version | 1.0 |
| Date | 2026-09-24 |
| Status | **Approved** (Harry, 2026-09-24) — version 1.0, aligned with the handbook (tag `design-v1.0`) |
| Readers | Tech lead, developers, Claude Code |
| Related decisions | D-02 Q4: A → C → B. Domain: orders / inventory. Stack: Vue + NestJS + PostgreSQL |

---

## 1. Purpose

- Create **a fictional repo that looks like a real project**, so the platform can run agents on it.
- Use it long-term as the platform's **integration test environment**, from milestone M-C onwards.
- Use it as a **demo** when presenting the platform to clients later.
- It contains no real client data.

## 2. Place in the pilot roadmap

| Step | Repo | Used at milestone |
|---|---|---|
| **A** | This sample repo (`pilot-order-inventory`) | M-C, M-D, and long-term integration tests |
| **C** | A real internal tool (not chosen yet) | M-F |
| **B** | The platform repo itself | After the MVP |

## 3. Fictional context

- Client: a small retail company in Japan (fictional).
- System: 受注・在庫管理 (order intake and inventory management), simplified.
- Users: warehouse staff, sales staff.
- Specs are bilingual Japanese – English, like our real projects.

---

## 4. Functional scope (baseline, before any agent task)

This is the **baseline**, built first by people (or Claude Code). Agents then work on the tasks in section 7 on top of it.

| # | Feature | Notes |
|---|---|---|
| F1 | Products: create, edit, view, list | SKU, name, price (JPY, integer), sales status |
| F2 | Inventory: goods in, goods out, view stock | Single warehouse. Movement history stored |
| F3 | Customers: create, view, list | Name, address, phone (fake data) |
| F4 | Orders: create multi-line orders, check stock, deduct stock | Status: 受付 (received) → 出荷済 (shipped) |
| F5 | Order list: view, search by order number / customer | No pagination yet (left for task T08) |
| F6 | Sample data | About 50 products, 20 customers, 100 orders. All fake |

**Not in** the baseline: complex login, tax, order cancellation, CSV export, pagination, multiple warehouses. These are left for agent tasks.

---

## 5. Stack and repo layout

| Layer | Technology | Notes |
|---|---|---|
| Frontend | Vue 3 + Vite + TypeScript | Decided |
| Backend | NestJS (TypeScript) | Decided |
| Database | PostgreSQL | Decided |
| ORM | Prisma or TypeORM | [Proposal] Choose when building; pick one and note it in the README |
| Tests | Vitest (web), Jest (NestJS), 1–2 end-to-end tests | [Proposal] |
| Package manager | pnpm workspace | [Proposal] |
| Local run | Docker Compose (PostgreSQL) | |

```text
pilot-order-inventory/
├── apps/
│   ├── web/            # Vue 3
│   └── api/            # NestJS
├── docs/
│   └── specs/          # Bilingual Japanese–English specs, one file per feature
├── .github/
│   ├── workflows/ci.yml
│   └── pull_request_template.md   # Per template T2 (AI disclosure)
├── AGENTS.md           # Instructions for agents: build/test commands, conventions
├── docker-compose.yml
└── README.md
```

- [Proposal] `AGENTS.md`: a general instruction file for agents. Check which repo instruction format OpenHands reads, and adjust.

---

## 6. CI and repo protection (needed to test gates G4, G6, G7)

| Item | Requirement | Related gate |
|---|---|---|
| CI on GitHub Actions | Lint, type check, tests, build for both `web` and `api` | G6 |
| Security scans | Gitleaks (secret leaks), Semgrep (code issues), Trivy (vulnerable dependencies) | G6 |
| Branch protection on `main` | No direct pushes. PR required, CI must pass, at least 1 approval | G4, G7 |
| CODEOWNERS | Code owners for `apps/api` and `apps/web` | G7 |
| PR template | Per T2: AI disclosure, intent_id, run_id | G7 |

---

## 7. Ten sample tasks for the agent

Each task has its own spec in `docs/specs/`. The risk tier sets the autonomy level (see the codes table).

| ID | Task | Risk | Max autonomy | What it tests |
|---|---|---|---|---|
| T01 | Add Japanese labels to the product list screen | Low | L2 | The simplest G1→G8 flow |
| T02 | Validate the SKU format when creating a product | Low | L2 | Generated tests, G6 |
| T03 | Filter orders by status | Low | L2 | Changes in both frontend and backend |
| T04 | Export the order list to CSV, with a Shift_JIS encoding option | Medium | L2 | A Japan-specific requirement |
| T05 | Low-stock warning based on a threshold | Medium | L2 | Business logic |
| T06 | Consumption tax at 10% / 8% and rounding (消費税・軽減税率) | Medium | L2 | Business logic; the spec must be clear (G2) |
| T07 | Cancel an order and return stock | Medium | L2 | Database transaction; thorough tests |
| T08 | Pagination for the order API and list screen | Medium | L2 | API change |
| T09 | Move to multiple warehouses | High | **L1** | The platform only lets the agent **propose** (stored as evidence `proposal`); no code changes |
| T10 | Delete orders older than 5 years | Critical | **L0** | The platform must **refuse to run the agent** |

### "Unhappy path" scenarios (to test that the platform blocks correctly)

| ID | Scenario | The platform must |
|---|---|---|
| N1 | The agent changes files outside the G3 plan | G5 stops; G3 must be approved again |
| N2 | A task makes CI fail repeatedly | G6 stops after the maximum number of retries |
| N3 | A very small token budget | The Cost Controller stops the run and warns on the issue |
| N4 | The spec is edited after G2 was approved | Hash mismatch reported; G2 must be approved again |
| N5 | The producer of a change approves it at G7, or a person without the gate's role approves | Refused (separation of duties) |
| N6 | The agent tries to push to `main` | Blocked by branch protection |
| N7 | An escalation is not acknowledged within its SLA | Moves to the backup owner, then governance; the work stays frozen |
| N8 | A Low-risk task whose plan is flagged `migration` | G3 becomes HITL (forced list) |
| N9 | A PR flagged `personal_data` approved by Person B only | G7 waits for the second approver |
| N10 | The kill switch is used during a run | Run `stopped_killed` within 5 minutes; token and key revoked; escalation opened |

---

## 8. Sample bilingual spec (example T06)

```markdown
# T06 消費税計算 / Consumption tax calculation

## 目的 / Purpose
注文明細ごとに税率（10% / 8%）を適用し、注文合計の消費税額を計算する。
Apply the tax rate (10% / 8%) to each order line and calculate the order's total consumption tax.

## 受入基準 / Acceptance criteria
- AC1: 商品に税区分（標準 10% / 軽減 8%）を持たせる。
        Each product has a tax category (standard 10% / reduced 8%).
- AC2: 税額は税率ごとに合計してから計算し、1円未満は切り捨てる。
        Sum amounts per tax rate first, then calculate the tax; round down fractions below 1 yen.
- AC3: 画面と API で税抜・税額・税込を表示する。
        The screen and the API show the price before tax, the tax amount and the price including tax.

## 対象外 / Out of scope
- インボイス番号の出力 / Printing the invoice number
```

[Proposal] The rounding rule above is an **assumption**. Its purpose is to test whether G2 catches an ambiguous spec. It is not a real tax rule.

---

## 9. Who builds this repo, and when

| Work | Who | When |
|---|---|---|
| Build the baseline (F1–F6), CI, branch protection | Claude Code + a human reviewer | **Right before M-C** (milestone M-0, per D-02) |
| Write specs T01–T10 | PM/BrSE (AI may draft) | Before M-C |
| Run tasks through the platform | Platform + OpenHands | From M-C |

- [Proposal] While the platform does not exist yet, this repo is built with the **manual process**: spec → plan → PR → review.

## 10. Definition of done for the sample repo

1. `docker compose up` + the run command in the README → F1–F6 work.
2. CI passes on `main`. Security scans show no critical findings.
3. Branch protection, CODEOWNERS and the PR template are enabled.
4. Specs for T01–T10 exist in `docs/specs/`.
5. No real data, no secrets in the repo.

## 11. Risks

| Risk | Mitigation |
|---|---|
| The sample repo is too simple to reflect reality | Medium/High tasks with real business logic (T06, T07, T09). Add tasks during the real trial (C) |
| Building the sample repo takes effort | Keep the baseline small (F1–F6). Claude Code builds it |
| Readers take the tax rule in the example as real | The spec clearly says "assumption" |

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-09-24 | Claude (draft) | First version |
| 0.2 | 2026-09-24 | Claude (draft) | After review: sample repo built right before M-C; T09, N5 updated |
| 1.0 | 2026-09-24 | Claude, approved by Harry | Autonomy codes L0–L2; N5 rewritten (separation of duties); new N7–N10 |
| 0.3 | 2026-09-24 | Claude | Translated into English. Specs now bilingual Japanese–English. Step C belongs to M-F (matches D-02) |
