/**
 * @mun/desktop renderer — theme (dark/light)
 *
 * Persists the choice in localStorage and toggles the `dark` class on <html>
 * (Tailwind darkMode: 'class'). Defaults to the OS preference.
 */

import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';
const KEY = 'mun-theme';

function initialTheme(): Theme {
  const stored = localStorage.getItem(KEY) as Theme | null;
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function useTheme(): {
  theme: Theme;
  toggle: () => void;
  setTheme: (t: Theme) => void;
} {
  const [theme, setThemeState] = useState<Theme>(initialTheme);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    localStorage.setItem(KEY, theme);
  }, [theme]);

  return {
    theme,
    toggle: () => setThemeState((t) => (t === 'dark' ? 'light' : 'dark')),
    setTheme: setThemeState,
  };
}
