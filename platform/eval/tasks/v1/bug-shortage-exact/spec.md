# Bug: an order that takes exactly the available stock is refused

## Report
A customer orders 5 units of a product that has exactly 5 units in stock. The order is refused with a stock shortage.

## Expected behaviour
- An order line that asks for exactly the available quantity is accepted.
- An order line that asks for more than the available quantity is still a shortage.

## Acceptance criteria
- AC1: `findShortages` in `apps/api/src/inventory/stock-rules.ts` reports a product only when the requested quantity is greater than the available quantity.
- AC2: A unit test covers the case of a request equal to the stock.
