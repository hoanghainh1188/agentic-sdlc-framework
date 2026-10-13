# Task: the low-stock rule

Part of T05 (low-stock warning). This task adds only the rule; the API, the migration and the screen come later.

## Acceptance criteria
- AC1: `apps/api/src/inventory/stock-rules.ts` exports `isLowStock(quantity: number, threshold: number): boolean`.
- AC2: It returns `true` when the quantity is at or below the threshold (quantity ≤ threshold).
- AC3: With a threshold of 0, it returns `true` only when the quantity is 0.
- AC4: Unit tests check a quantity equal to the threshold, threshold + 1, and threshold 0.
