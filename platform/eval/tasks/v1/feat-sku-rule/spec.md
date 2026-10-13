# Task: the SKU format rule

Part of T02 (validate the SKU format). This task adds only the rule; the API and the screens come later.

## Acceptance criteria
- AC1: A new file `apps/api/src/products/sku-rules.ts` exports `isValidSku(sku: string): boolean`.
- AC2: A SKU is valid when it is three capital letters, a hyphen and three digits (regular expression `^[A-Z]{3}-[0-9]{3}$`), after removing spaces at both ends.
- AC3: Lower-case letters are invalid (`tea-001` is refused, not converted).
- AC4: Unit tests in `apps/api/src/products/sku-rules.spec.ts` check `TEA-001` (valid) and `TEA-1`, `tea-001`, `TEAS-001`, `TEA_001` and an empty string (invalid).
