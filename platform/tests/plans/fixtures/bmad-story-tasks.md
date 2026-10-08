# Story 2.3: Low-stock warning

Status: ready-for-dev

## Story

As a warehouse staff member,
I want a warning when stock falls below the threshold,
so that I can reorder in time.

## Acceptance Criteria

1. A product whose stock is below its threshold shows a warning on the inventory screen.
2. The threshold is set per product; the default is 10.

## Tasks / Subtasks

- [ ] Add a threshold column to products (AC: 2)
  - [ ] Migration with the default 10
  - [ ] Show the threshold on the product form
- [ ] Show the low-stock warning on the inventory screen (AC: 1)
  - [ ] 在庫が閾値未満なら警告を表示する

## Dev Notes

- The inventory API already returns the stock.

### File List
