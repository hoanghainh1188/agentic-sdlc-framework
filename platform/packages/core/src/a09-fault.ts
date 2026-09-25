// A09 FAULT INJECTION (type check): a string assigned to a number must fail `pnpm build`/`typecheck`.
export function a09Fault(): number {
  const value: number = 'not a number';
  return value;
}
