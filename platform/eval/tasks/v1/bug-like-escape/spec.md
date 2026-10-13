# Bug: the order search treats an underscore as a wildcard

## Report
Searching orders for the customer name `A_B` also finds `AXB`. The search text is put into a PostgreSQL `ILIKE` pattern, where `_` matches any single character.

## Expected behaviour
The characters `%`, `_` and `\` in the search text match themselves.

## Acceptance criteria
- AC1: `likePattern` in `apps/api/src/orders/order-rules.ts` escapes `%`, `_` and `\` with a backslash and wraps the text in `%…%`.
- AC2: A unit test covers each of the three characters.
