// CSS classes from server codes (status, severity, mode…): lower-case letters, digits and `_`
// only, so a code can never add another class or break the attribute.
export function codeClass(prefix: string, value: string): string {
  return `${prefix}-${value.toLowerCase().replace(/[^a-z0-9_]/g, '')}`;
}
