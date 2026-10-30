import { CATALOGS } from './catalogs';
import {
  DEFAULT_LOCALE,
  LOCALES,
  LOCALE_STORAGE_KEY,
  type Locale,
  type MessageParams,
} from './types';

type Listener = (locale: Locale) => void;

let currentLocale: Locale = DEFAULT_LOCALE;
const listeners = new Set<Listener>();

function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

/** Read persisted preference once at module load (SSR-safe). */
export function readStoredLocale(): Locale {
  try {
    const raw = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (raw && isLocale(raw)) return raw;
  } catch {
    /* ignore */
  }
  return DEFAULT_LOCALE;
}

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(locale: Locale): void {
  if (currentLocale === locale) return;
  currentLocale = locale;
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    /* ignore */
  }
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale;
  }
  for (const listener of listeners) listener(locale);
}

/** Apply stored locale before first paint (call from provider mount). */
export function initLocaleFromStorage(): Locale {
  const locale = readStoredLocale();
  currentLocale = locale;
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale;
  }
  return locale;
}

export function subscribeLocale(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function format(template: string, params?: MessageParams): string {
  if (!params) return template;
  let out = template;
  for (const [key, value] of Object.entries(params)) {
    out = out.replaceAll(`{${key}}`, String(value));
  }
  return out;
}

/**
 * Look up a message key in the active catalog, falling back to English, then
 * `fallback`, then the raw key. Use `{name}` placeholders with `params`.
 *
 * Safe to call from tools / plugins outside React — locale changes notify
 * React via `subscribeLocale` / `useI18n`.
 */
export function t(key: string, params?: MessageParams, fallback?: string): string {
  const active = CATALOGS[currentLocale];
  const english = CATALOGS.en;
  const template = active[key] ?? english[key] ?? fallback ?? key;
  return format(template, params);
}

/** True when the English catalog defines the key (plugins can probe before overriding). */
export function hasMessage(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(CATALOGS.en, key);
}

/** Plural helper for English-style "point" / "points" in templates via `{s}`. */
export function pluralS(n: number): string {
  return n === 1 ? '' : 's';
}
