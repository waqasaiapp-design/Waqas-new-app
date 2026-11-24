import { useEffect, useState } from 'react';

export type ThemeMode = 'light' | 'dark';

export function useTheme() {
  const [theme, setTheme] = useState<ThemeMode>(() => {
    if (typeof document !== 'undefined') {
      return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
    }
    return 'light';
  });

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    try {
      localStorage.setItem('waqas-theme', theme);
    } catch {
      // ignore storage failures
    }
  }, [theme]);

  const toggleTheme = () => setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));

  return { theme, setTheme, toggleTheme };
}
