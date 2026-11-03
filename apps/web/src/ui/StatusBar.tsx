import { useI18n } from '../i18n';
import { THEME_PREFERENCES } from '../theme/theme';
import { useTheme } from '../theme/useTheme';
import { SNAP_GROUPS, type SnapFilter, type SnapGroup } from '../tools/elementSnap';

export interface StatusBarProps {
  levelName: string;
  /** Live element-snap kind label (`end`, `intersection`, …) or null. */
  snapKind: string | null;
  snaps: SnapFilter;
  onToggleSnap: (group: SnapGroup) => void;
  hairline: boolean;
  onToggleHairline: () => void;
  /** fps + scene revision; shown only when debug info is on. */
  debug: { fps: number; version: number } | null;
  compact?: boolean;
}

/**
 * Bottom status bar: level, live snap, snap toggles, Thin Lines, units,
 * theme and language — the "set and forget" state that used to crowd the top.
 */
export function StatusBar(props: StatusBarProps) {
  const { t, locale, setLocale, locales } = useI18n();
  const { preference, resolved, setPreference } = useTheme();
  const nextTheme = THEME_PREFERENCES[(THEME_PREFERENCES.indexOf(preference) + 1) % THEME_PREFERENCES.length];
  const nextLocale = locales[(locales.indexOf(locale) + 1) % locales.length];
  return (
    <footer className="statusbar" data-testid="statusbar">
      <span className="statusbar-level" data-testid="status-level">{props.levelName}</span>
      {props.snapKind ? (
        <span className="statusbar-live" data-testid="status-snap">
          {t(`snap.kind.${props.snapKind}`, undefined, props.snapKind)}
        </span>
      ) : null}
      <span className="statusbar-spacer" />
      {!props.compact ? (
        <span className="statusbar-group" role="group" aria-label={t('status.snaps')}>
          <span className="statusbar-label">{t('status.snaps')}</span>
          {SNAP_GROUPS.map((g) => (
            <button
              key={g}
              type="button"
              className={`statusbar-chip${props.snaps[g] ? ' on' : ''}`}
              aria-pressed={props.snaps[g]}
              data-testid={`snap-toggle-${g}`}
              title={t('status.snapToggleTitle', { kind: t(`status.snap.${g}`) })}
              onClick={() => props.onToggleSnap(g)}
            >
              {t(`status.snap.${g}`)}
            </button>
          ))}
        </span>
      ) : null}
      <button
        type="button"
        className={`statusbar-chip${props.hairline ? ' on' : ''}`}
        aria-pressed={props.hairline}
        data-testid="toggle-thin-lines-status"
        title={t('toolbar.thinLinesTitle')}
        onClick={props.onToggleHairline}
      >
        {t('status.thinLines')}
      </button>
      <span className="statusbar-chip statusbar-chip--static" title={t('status.unitsTitle')} data-testid="status-units">
        {t('status.unitsMetres')}
      </span>
      <button
        type="button"
        className="statusbar-chip"
        data-testid="status-theme"
        title={t('status.themeTitle', { next: t(`chrome.theme.${nextTheme}`) })}
        onClick={() => setPreference(nextTheme)}
      >
        {resolved === 'dark' ? '☾' : '☀'} {t(`chrome.theme.${preference}`)}
      </button>
      <button
        type="button"
        className="statusbar-chip"
        data-testid="status-language"
        title={t('chrome.language')}
        onClick={() => setLocale(nextLocale)}
      >
        {locale.toUpperCase()}
      </button>
      {props.debug ? (
        <span className="statusbar-debug" data-testid="status-debug">
          {props.debug.fps > 0 ? `${props.debug.fps} fps` : '…'} · v{props.debug.version}
        </span>
      ) : null}
    </footer>
  );
}
