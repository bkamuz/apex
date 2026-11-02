import { useEffect, useState } from "react";
import { themeStore, type ResolvedTheme, type ThemePreference } from "./theme";

/** React binding for the shared theme store. */
export function useTheme(): {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (p: ThemePreference) => void;
  toggle: () => void;
} {
  const store = themeStore();
  const [state, setState] = useState(() => ({
    preference: store.preference(),
    resolved: store.resolved(),
  }));
  useEffect(
    () =>
      store.subscribe((resolved, preference) =>
        setState({ resolved, preference }),
      ),
    [store],
  );
  return {
    ...state,
    setPreference: (p) => store.setPreference(p),
    toggle: () => store.toggle(),
  };
}
