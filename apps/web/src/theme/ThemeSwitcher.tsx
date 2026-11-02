import { useI18n } from "../i18n";
import { THEME_PREFERENCES, type ThemePreference } from "./theme";
import { useTheme } from "./useTheme";

/** Light / Dark / System select for the topbar settings, next to Language. */
export function ThemeSwitcher() {
  const { t } = useI18n();
  const { preference, setPreference } = useTheme();
  return (
    <label className="language-switcher" title={t("chrome.theme")}>
      <span className="language-switcher-label">{t("chrome.theme")}</span>
      <select
        data-testid="theme-switcher"
        aria-label={t("chrome.theme")}
        value={preference}
        onChange={(e) => setPreference(e.target.value as ThemePreference)}
      >
        {THEME_PREFERENCES.map((id) => (
          <option key={id} value={id}>
            {t(`chrome.theme.${id}`)}
          </option>
        ))}
      </select>
    </label>
  );
}
