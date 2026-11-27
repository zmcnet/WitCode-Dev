/**
 * 右栏「终端」页：xterm.js 挂载到面板，输入输出桥接服务端 pty。
 * 主题色从 ZCode 的 CSS 变量 --bg / --text 初始化，并随主题切换更新。
 */
import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

export interface TerminalPanelProps {
  subscribe(cb: (data: string) => void): () => void;
  send(data: string): void;
  resize(cols: number, rows: number): void;
  create(cols: number, rows: number): void;
  close(): void;
}

function readTheme() {
  const style = getComputedStyle(document.documentElement);
  const background = style.getPropertyValue('--bg').trim() || '#0d1117';
  const foreground = style.getPropertyValue('--text').trim() || '#e6edf3';
  return {
    background,
    foreground,
    cursor: foreground,
    selectionBackground: foreground,
    selectionForeground: background,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function TerminalPanel({ subscribe, send, resize, create, close }: TerminalPanelProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef({ subscribe, send, resize, create, close });
  apiRef.current = { subscribe, send, resize, create, close };
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let term: Terminal | null = null;
    let fit: FitAddon | null = null;
    let dataSub: { dispose(): void } | null = null;
    let unsub: (() => void) | null = null;
    let ro: ResizeObserver | null = null;
    let themeObserver: MutationObserver | null = null;
    let created = false;

    setReady(false);
    setError(null);

    try {
      term = new Terminal({
        theme: readTheme(),
        fontFamily: '"Cascadia Mono", "JetBrains Mono", Consolas, "Liberation Mono", monospace',
        fontSize: 12.5,
        lineHeight: 1.35,
        cursorBlink: true,
        scrollback: 5000,
        allowTransparency: false,
        convertEol: true,
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host);

      if (host.clientWidth > 0 && host.clientHeight > 0) {
        try {
          fit.fit();
        } catch {
          // 容器尚未布局完成时 fit 可能抛错，保留默认行列数。
        }
      }
      if (term.cols <= 0 || term.rows <= 0) term.resize(80, 24);
      const cols = term.cols;
      const rows = term.rows;

      apiRef.current.create(cols, rows);
      created = true;
      unsub = apiRef.current.subscribe((data) => {
        term?.write(data);
      });
      dataSub = term.onData((data) => {
        apiRef.current.send(data);
      });
      term.focus();

      if (typeof ResizeObserver !== 'undefined') {
        ro = new ResizeObserver(() => {
          if (!host.clientWidth || !host.clientHeight || !fit || !term) return;
          try {
            fit.fit();
          } catch {
            return;
          }
          apiRef.current.resize(term.cols, term.rows);
        });
        ro.observe(host);
      }

      if (typeof MutationObserver !== 'undefined') {
        themeObserver = new MutationObserver(() => {
          if (term) term.options.theme = readTheme();
        });
        themeObserver.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['class', 'data-theme'],
        });
      }

      setReady(true);
    } catch (err) {
      setError(errorMessage(err));
    }

    return () => {
      ro?.disconnect();
      themeObserver?.disconnect();
      dataSub?.dispose();
      unsub?.();
      term?.dispose();
      if (created) {
        try {
          apiRef.current.close();
        } catch {
          // 服务端会话可能已关闭，忽略清理阶段的错误。
        }
      }
    };
  }, []);

  return (
    <div className="dock-panel dock-terminal">
      <div ref={hostRef} className="dock-terminal__host" />
      {error ? (
        <div className="dock-terminal__overlay">
          <div className="dock-state dock-state--error" role="alert">终端启动失败：{error}</div>
        </div>
      ) : !ready ? (
        <div className="dock-terminal__overlay">
          <div className="dock-state dock-state--loading" role="status">正在启动终端…</div>
        </div>
      ) : null}
    </div>
  );
}
