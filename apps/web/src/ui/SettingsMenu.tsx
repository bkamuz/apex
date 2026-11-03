import { useEffect, useRef, type ReactNode } from 'react';
import { useI18n } from '../i18n';
import { useTheme } from '../theme/useTheme';
import type { ThemePreference } from '../theme/theme';

type Props = {
  /** Kernel select, agent bridge — advanced/dev controls. */
  children?: ReactNode;
  debug: boolean;
  onToggleDebug: () => void;
};

const THEMES: ThemePreference[] = ['system', 'light', 'dark'];

/** ⚙ settings popover: theme, language, kernel, agent bridge, debug readout. */
export function SettingsMenu({ children, debug, onToggleDebug }: Props) {
  const { t, locale, setLocale, locales } = useI18n();
  const { preference, setPreference } = useTheme();
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const el = ref.current;
      if (!el?.open) return;
      if (e.target instanceof Node && el.contains(e.target)) return;
      el.open = false;
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, []);

  return (
    <details ref={ref} className="file-menu settings-menu" data-testid="settings-menu">
      <summary
        className="file-menu-summary"
        data-testid="settings-menu-summary"
        title={t('settings.title')}
        aria-label={t('settings.title')}
      >
        ⚙
      </summary>
      <div className="file-menu-panel settings-panel" role="dialog" aria-label={t('settings.title')}>
        <label className="settings-row">
          <span>{t('settings.theme')}</span>
          <select
            data-testid="settings-theme"
            value={preference}
            onChange={(e) => setPreference(e.target.value as ThemePreference)}
          >
            {THEMES.map((p) => (
              <option key={p} value={p}>
                {t(`chrome.theme.${p}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="settings-row">
          <span>{t('chrome.language')}</span>
          <select
            data-testid="settings-language"
            value={locale}
            onChange={(e) => setLocale(e.target.value as typeof locale)}
          >
            {locales.map((l) => (
              <option key={l} value={l}>
                {l.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
        <div className="file-menu-sep" role="separator" />
        <div className="settings-advanced">{children}</div>
        <div className="file-menu-sep" role="separator" />
        <label className="settings-row settings-check">
          <input type="checkbox" checked={debug} onChange={onToggleDebug} data-testid="settings-debug" />
          <span title={t('settings.debugTitle')}>{t('settings.debug')}</span>
        </label>
      </div>
    </details>
  );
}
