/**
 * UI 字号缩放：只写根变量 --font-scale，样式表里的文字尺寸用它做比例。
 * 范围与服务端设置一致（0.85–1.3）；装饰性图标/圆点/进度环不受影响。
 */

export const FONT_SCALE_MIN = 0.85;
export const FONT_SCALE_MAX = 1.3;

export function clampFontScale(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, value));
}

/** 把字号缩放写入根元素；App 也会用同一个变量同步服务端设置。 */
export function applyFontScale(scale: number): void {
  document.documentElement.style.setProperty('--font-scale', String(clampFontScale(scale)));
}
