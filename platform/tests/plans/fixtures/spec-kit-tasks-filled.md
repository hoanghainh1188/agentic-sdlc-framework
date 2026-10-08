---
description: "Task list for T03: filter orders by status"
---

# Tasks: Filter orders by status / 注文をステータスで絞り込む

**Input**: Design documents from `/specs/003-order-status-filter/`

## Format: `[ID] [P?] [Story] Description`

<!--
  The tasks below replace the sample tasks of the template.
  - [ ] T999 A commented-out task is never read
-->

## Phase 1: Setup (Shared Infrastructure)

- [ ] T001 Add the status enum to apps/api/src/orders/order-status.ts

---

## Phase 2: Foundational (Blocking Prerequisites)

- [ ] T002 [P] Add a `status` query parameter to apps/api/src/orders/orders.controller.ts
- [ ] T003 Filter by status in apps/api/src/orders/orders.service.ts (depends on T001, T002)

**Checkpoint**: The API filters orders by status

---

## Phase 3: User Story 1 - 受付 / 出荷済 filter on the list screen (Priority: P1) 🎯 MVP

### Tests for User Story 1

- [ ] T004 [P] [US1] Unit test in apps/api/test/orders/orders.service.spec.ts: "received" → 受付; key: value # not a comment
- [x] T005 [US1] Add a status select to apps/web/src/views/OrderList.vue (depends on T003)
- [ ] T006 [US1] Do not touch .github/workflows/ci.yml or AGENTS.md; keep *alias &anchor !tag text as text

```text
- [ ] T998 A task in a code block is never read
```

**Checkpoint**: User Story 1 works on its own
