/**
 * 主题：深色 / 浅色 / 跟随系统。
 * 颜色 token 定义在 styles.css：默认深色，`.theme-light` 覆盖为 ZCode 浅色主题。
 */
export type ThemeMode = 'dark' | 'light' | 'system';

const STORAGE_KEY = 'witcode:theme';

export function loadTheme(): ThemeMode {
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved === 'light' || saved === 'system' || saved === 'dark' ? saved : 'dark';
}

export function resolveTheme(mode: ThemeMode): 'dark' | 'light' {
  if (mode !== 'system') return mode;
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function applyTheme(mode: ThemeMode): void {
  const resolved = resolveTheme(mode);
  document.documentElement.classList.toggle('theme-light', resolved === 'light');
  document.documentElement.dataset.theme = resolved;
  localStorage.setItem(STORAGE_KEY, mode);
}

/** 跟随系统时监听系统主题变化；返回取消订阅函数。 */
export function watchSystemTheme(onChange: () => void): () => void {
  const media = window.matchMedia?.('(prefers-color-scheme: light)');
  if (!media) return () => {};
  const listener = () => onChange();
  media.addEventListener('change', listener);
  return () => media.removeEventListener('change', listener);
}
