# Task: the paging rule

Part of T08 (pagination of the order list). This task adds only the rule that checks the parameters; the API and the screen come later.

## Acceptance criteria
- AC1: A new file `apps/api/src/common/paging.ts` exports `resolvePaging(input: { page?: number; pageSize?: number }): { page: number; pageSize: number; offset: number }`.
- AC2: Defaults: `page` 1 and `pageSize` 20.
- AC3: `page` must be an integer of 1 or more; `pageSize` an integer from 1 to 100. Any other value throws a `RangeError`.
- AC4: `offset` is `(page - 1) * pageSize`.
- AC5: Unit tests check the defaults and the edge values (`pageSize` 1, 100 and 101; `page` 0).
