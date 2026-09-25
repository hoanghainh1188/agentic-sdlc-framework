// JSON Canonicalization Scheme (RFC 8785): sorted keys, no whitespace, ECMAScript number and
// string serialisation. Used for `config_hash`; the audit hash chain (A07) uses the same scheme.
// Input must be plain JSON data: null, booleans, finite numbers, well-formed strings, arrays and
// plain objects. Object members whose value is `undefined` are left out, as in JSON.stringify.

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
      // ECMAScript Number serialisation, as required by RFC 8785 §3.2.2.3 (-0 becomes 0).
      return JSON.stringify(value);
    case 'string':
      if (!value.isWellFormed()) throw new TypeError('canonicalJson: lone surrogate in string');
      return JSON.stringify(value);
    case 'object':
      return Array.isArray(value) ? canonicalArray(value) : canonicalObject(value);
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
  }
}

function canonicalArray(items: readonly unknown[]): string {
  const parts = items.map((item) => {
    if (item === undefined) throw new TypeError('canonicalJson: undefined array item');
    return canonicalJson(item);
  });
  return `[${parts.join(',')}]`;
}

function canonicalObject(object: object): string {
  const prototype: unknown = Object.getPrototypeOf(object);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('canonicalJson: only plain objects are supported');
  }
  const entries = Object.entries(object).filter(([, v]) => v !== undefined);
  // RFC 8785 §3.2.3: sort by UTF-16 code units, which is the default string sort in JavaScript.
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
