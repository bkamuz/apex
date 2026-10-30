/** Supported UI locales. Add a catalog file + entry in `catalogs/index.ts` to extend. */
export type Locale = 'en' | 'ru';

export type MessageParams = Record<string, string | number>;

/** Flat key → template string (use `{name}` placeholders). */
export type MessageCatalog = Record<string, string>;

export const LOCALES: readonly Locale[] = ['en', 'ru'] as const;

export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  ru: 'Русский',
};

export const DEFAULT_LOCALE: Locale = 'en';

export const LOCALE_STORAGE_KEY = 'apex.locale';
