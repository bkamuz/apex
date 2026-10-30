import { useI18n } from './I18nProvider';
import type { Locale } from './types';

/** Compact EN/RU control for the topbar chrome. */
export function LanguageSwitcher() {
  const { locale, setLocale, locales, localeLabels, t } = useI18n();

  return (
    <label className="language-switcher" title={t('chrome.language')}>
      <span className="language-switcher-label">{t('chrome.language')}</span>
      <select
        data-testid="language-switcher"
        aria-label={t('chrome.language')}
        value={locale}
        onChange={(e) => setLocale(e.target.value as Locale)}
      >
        {locales.map((id) => (
          <option key={id} value={id}>
            {localeLabels[id]}
          </option>
        ))}
      </select>
    </label>
  );
}
