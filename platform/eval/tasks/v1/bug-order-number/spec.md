# Bug: order numbers have five digits instead of six

## Report
New orders are shown as `SO-00042`. The README and the screens expect `SO-000042`.

## Expected behaviour
The order number is `SO-` and the sequence value padded with zeros to six digits. Values with more than six digits are not cut.

## Acceptance criteria
- AC1: `formatOrderNumber` in `apps/api/src/orders/order-rules.ts` pads to six digits.
- AC2: A unit test covers 1, 42, 999999 and 1234567.
