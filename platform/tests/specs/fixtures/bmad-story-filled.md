# Story 2.3: Low-stock warning

Status: ready-for-dev

## Story

As a warehouse staff member,
I want a warning when stock falls below the threshold,
so that I can reorder in time.

## Acceptance Criteria

1. A product whose stock is below its threshold shows a warning on the inventory screen.
2. The threshold is set per product; the default is 10.
3. Goods in that lift the stock above the threshold remove the warning.

## Tasks / Subtasks

- [ ] Task 1 (AC: 1, 2)
  - [ ] Subtask 1.1

## Dev Notes

- The inventory API already returns the stock.
