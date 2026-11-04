import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../i18n';
import {
  getEnabledPackIds,
  setPackEnabled,
  subscribePackPrefs,
  systemPacks,
} from '../plugins';
import { useTheme } from '../theme/useTheme';
import type { ThemePreference } from '../theme/theme';

type Props = {
  /** Kernel select, agent bridge — advanced/dev controls. */
  children?: ReactNode;
  debug: boolean;
  onToggleDebug: () => void;
};

const THEMES: ThemePreference[] = ['system', 'light', 'dark'];

/** ⚙ settings popover: theme, language, system packs, kernel, agent bridge, debug. */
export function SettingsMenu({ children, debug, onToggleDebug }: Props) {
  const { t, locale, setLocale, locales } = useI18n();
  const { preference, setPreference } = useTheme();
  const ref = useRef<HTMLDetailsElement>(null);
  const [enabledPacks, setEnabledPacks] = useState(() => new Set(getEnabledPackIds()));

  useEffect(() => {
    return subscribePackPrefs((ids) => setEnabledPacks(new Set(ids)));
  }, []);

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
        <div className="settings-packs" data-testid="settings-packs">
          <div className="settings-section-label">{t('settings.packs')}</div>
          {systemPacks.map((pack) => {
            const checked = enabledPacks.has(pack.id);
            return (
              <label key={pack.id} className="settings-row settings-check">
                <input
                  type="checkbox"
                  checked={checked}
                  data-testid={`settings-pack-${pack.id}`}
                  onChange={(e) => setPackEnabled(pack.id, e.target.checked)}
                />
                <span>{t(pack.labelKey)}</span>
              </label>
            );
          })}
        </div>
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
