# Task: the consumption tax rule

Part of T06 (consumption tax). This task adds only the calculation; the schema, the migration and the screens come later. The rounding rule is an assumption of this sample, not a real tax rule.

## Acceptance criteria
- AC1: A new file `apps/api/src/orders/tax-rules.ts` exports `calculateTax(lines: { amount: number; category: 'standard' | 'reduced' }[]): { beforeTax: number; tax: number; includingTax: number }`. Amounts are whole yen, before tax.
- AC2: The rate is 10% for `standard` and 8% for `reduced`.
- AC3: Add up the amounts per rate first, then calculate the tax of each rate and round it down to whole yen; the order's tax is the sum of the two.
- AC4: Unit tests check: standard ¥1,001 → tax ¥100; reduced ¥999 → tax ¥79; standard ¥105 + standard ¥105 → tax ¥21; standard ¥1,001 + reduced ¥999 → before tax ¥2,000, tax ¥179, including tax ¥2,179.
