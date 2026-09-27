// Chooses the message locale from `Accept-Language` (NFR-08). English until vi and ja exist.
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '@sdlc/messages';

export function localeOf(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header.join(',') : (header ?? '');
  for (const part of value.split(',')) {
    const tag = part.split(';')[0]?.trim().toLowerCase().split('-')[0];
    if (tag && SUPPORTED_LOCALES.includes(tag)) return tag;
  }
  return DEFAULT_LOCALE;
}
