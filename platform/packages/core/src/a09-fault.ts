// A09 FAULT INJECTION (lint): an unused variable must fail `pnpm lint`.
export function a09Fault(): number {
  const unused = 1;
  return 2;
}
