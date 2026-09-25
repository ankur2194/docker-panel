import { useState } from 'preact/hooks';

const KEY = 'dp:theme';
export const THEMES = [['system', 'System', 'monitor'], ['light', 'Light', 'sun'], ['dark', 'Dark', 'moon']];

function read() {
  try {
    const v = localStorage.getItem(KEY);
    return THEMES.some(([k]) => k === v) ? v : 'system';
  } catch {
    return 'system';
  }
}

/** The saved theme choice (system | light | dark). public/theme.js applies it and follows the OS. */
export function useTheme() {
  const [pref, setPref] = useState(read);
  const set = (v) => {
    setPref(v);
    try { localStorage.setItem(KEY, v); } catch { /* storage unavailable: applies for this page only */ }
    if (window.dpApplyTheme) window.dpApplyTheme(v);
    else document.documentElement.dataset.theme = v === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : v;
  };
  return [pref, set];
}
