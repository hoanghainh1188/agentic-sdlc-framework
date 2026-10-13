# Bug: stock rows are not locked in product order

## Report
Two orders created at the same moment sometimes wait for each other until the database stops one of them (a deadlock). The rows of the inventory are locked in the order of the order lines, not by product id.

## Expected behaviour
The merged stock requests come back sorted by product id, smallest first, so every order locks the rows in the same order.

## Acceptance criteria
- AC1: `mergeRequests` in `apps/api/src/inventory/stock-rules.ts` returns one request per product, with the quantities added up, sorted by `productId` (ascending).
- AC2: A unit test covers lines given in descending product order.
