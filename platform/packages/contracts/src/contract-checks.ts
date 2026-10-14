// Field checks shared by the Run Contract and the evaluation contract (task L04, ADR-M81 §2.2):
// patterns and small validators for IDs, hashes, model names, hosts, money and timestamps.
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const SHA256 = /^[0-9a-f]{64}$/;
export const GIT_SHA = /^[0-9a-f]{40}$/;
export const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
export const VERSION_LABEL = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
export const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
export const HOST =
  /^(?=.{1,253}(:|$))[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*(:[0-9]{1,5})?$/;
export const USD = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/;
export const TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
export const SIGNATURE = /^vault:v([1-9][0-9]{0,8}):[A-Za-z0-9+/]+={0,2}$/;

const MAX_LIST = 100;

export type Check = (value: unknown) => boolean;

export const text =
  (pattern: RegExp): Check =>
  (value) =>
    typeof value === 'string' && pattern.test(value);

export const positiveInt: Check = (value) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;

/** A sorted list of unique strings that match `pattern`. */
export const sortedSet =
  (pattern: RegExp, min: number): Check =>
  (value) =>
    Array.isArray(value) &&
    value.length >= min &&
    value.length <= MAX_LIST &&
    value.every(
      (item, i) =>
        typeof item === 'string' &&
        pattern.test(item) &&
        (i === 0 || (value[i - 1] as string) < item),
    );

export const timestamp: Check = (value) =>
  typeof value === 'string' &&
  TIMESTAMP.test(value) &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString() === value;

export const budget: Check = (value) =>
  typeof value === 'string' && USD.test(value) && Number(value) > 0;
