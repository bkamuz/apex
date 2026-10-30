import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  getLocale,
  initLocaleFromStorage,
  setLocale,
  subscribeLocale,
  t as translate,
} from './t';
import { LOCALES, LOCALE_LABELS, type Locale, type MessageParams } from './types';

export interface I18nValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, params?: MessageParams, fallback?: string) => string;
  locales: readonly Locale[];
  localeLabels: typeof LOCALE_LABELS;
}

const I18nContext = createContext<I18nValue | null>(null);

function subscribe(onStoreChange: () => void): () => void {
  return subscribeLocale(() => onStoreChange());
}

function getSnapshot(): Locale {
  return getLocale();
}

/**
 * Provides locale + `t` to the React tree. Tools outside React still call the
 * module-level `t` / `setLocale` from `./t`.
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    initLocaleFromStorage();
    setReady(true);
  }, []);

  const locale = useSyncExternalStore(subscribe, getSnapshot, () => getLocale());

  const value: I18nValue = {
    locale: ready ? locale : getLocale(),
    setLocale,
    t: translate,
    locales: LOCALES,
    localeLabels: LOCALE_LABELS,
  };

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error('useI18n must be used within I18nProvider');
  }
  return ctx;
}
