import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
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

type SettingsTab = 'general' | 'extensions';

const THEMES: ThemePreference[] = ['system', 'light', 'dark'];

const FOCUSABLE =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** ⚙ opens a Settings modal: General (theme/lang/debug) + Extensions (system packs). */
export function SettingsMenu({ children, debug, onToggleDebug }: Props) {
  const { t, locale, setLocale, locales } = useI18n();
  const { preference, setPreference } = useTheme();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<SettingsTab>('general');
  const [enabledPacks, setEnabledPacks] = useState(() => new Set(getEnabledPackIds()));
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  useEffect(() => {
    return subscribePackPrefs((ids) => setEnabledPacks(new Set(ids)));
  }, []);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const focusables = () => [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = focusables()[0];
    requestAnimationFrame(() => first?.focus());

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.code === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        setOpen(false);
        return;
      }
      if (e.key !== 'Tab') return;
      const nodes = focusables();
      if (nodes.length === 0) return;
      const firstEl = nodes[0]!;
      const lastEl = nodes[nodes.length - 1]!;
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };

    // Capture so Escape closes Settings before App's Select fallback.
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
      else triggerRef.current?.focus();
    };
  }, [open]);

  const close = () => setOpen(false);

  let body: ReactNode;
  switch (tab) {
    case 'general':
      body = (
        <div className="settings-pane" data-testid="settings-pane-general" role="tabpanel">
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
            <input
              type="checkbox"
              checked={debug}
              onChange={onToggleDebug}
              data-testid="settings-debug"
            />
            <span title={t('settings.debugTitle')}>{t('settings.debug')}</span>
          </label>
        </div>
      );
      break;
    case 'extensions':
      body = (
        <div
          className="settings-pane settings-packs"
          data-testid="settings-packs"
          role="tabpanel"
        >
          <p className="settings-pane-hint">{t('settings.packsHint')}</p>
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
      );
      break;
    default: {
      const _exhaustive: never = tab;
      return _exhaustive;
    }
  }

  return (
    <div className="settings-menu" data-testid="settings-menu">
      <button
        ref={triggerRef}
        type="button"
        className="file-menu-summary settings-trigger"
        data-testid="settings-menu-summary"
        title={t('settings.title')}
        aria-label={t('settings.title')}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setTab('general');
          setOpen(true);
        }}
      >
        ⚙
      </button>
      {open ? (
        <div
          className="settings-backdrop"
          role="presentation"
          data-testid="settings-backdrop"
          onMouseDown={close}
        >
          <div
            ref={dialogRef}
            className="settings-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            data-testid="settings-dialog"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <header className="settings-dialog-head">
              <h2 id={titleId} className="settings-dialog-title">
                {t('settings.title')}
              </h2>
              <button
                type="button"
                className="settings-dialog-close"
                data-testid="settings-dialog-close"
                onClick={close}
                title={t('panel.close')}
              >
                {t('panel.close')}
              </button>
            </header>
            <div className="settings-tabs" role="tablist" aria-label={t('settings.title')}>
              <button
                type="button"
                role="tab"
                className={tab === 'general' ? 'active' : undefined}
                aria-selected={tab === 'general'}
                data-testid="settings-tab-general"
                onClick={() => setTab('general')}
              >
                {t('settings.tab.general')}
              </button>
              <button
                type="button"
                role="tab"
                className={tab === 'extensions' ? 'active' : undefined}
                aria-selected={tab === 'extensions'}
                data-testid="settings-tab-extensions"
                onClick={() => setTab('extensions')}
              >
                {t('settings.tab.extensions')}
              </button>
            </div>
            <div className="settings-dialog-body">{body}</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
