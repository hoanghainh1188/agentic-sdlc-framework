// Message catalog for user-facing text (design/D-02 NFR-08, ADR-M18).
// English is the source catalog. Other locales (vi, ja) are added as `locales/<locale>.json` with
// the same keys and placeholders; a missing key falls back to English.
import en from './locales/en.json';

export type MessageKey = keyof typeof en;
export type MessageParams = Readonly<Record<string, string | number>>;
export type Catalog = Readonly<Partial<Record<MessageKey, string>>>;

export const DEFAULT_LOCALE = 'en';

const CATALOGS: Readonly<Record<string, Catalog>> = { en };

export const SUPPORTED_LOCALES: readonly string[] = Object.keys(CATALOGS);

const PLACEHOLDER = /\{([a-z_][a-z0-9_]*)\}/g;

/** Returns the catalog of a locale, or undefined when the locale is not supported. */
export function catalogFor(locale: string): Catalog | undefined {
  return CATALOGS[locale];
}

/** Placeholder names used by a template, in order of first use. */
export function placeholdersOf(template: string): string[] {
  return [...new Set([...template.matchAll(PLACEHOLDER)].map((m) => m[1] ?? ''))];
}

/**
 * Renders a message. Placeholders use the ICU `{name}` form, so the catalog can move to full ICU
 * MessageFormat later without rewriting it. A placeholder without a value stays visible as `{name}`.
 */
export function t(key: MessageKey, params: MessageParams = {}, locale = DEFAULT_LOCALE): string {
  const template = catalogFor(locale)?.[key] ?? en[key];
  return template.replace(PLACEHOLDER, (match, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  );
}
