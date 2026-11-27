/**
 * 右栏「文件」页：目录树 + 文件预览。
 * 颜色取自 styles.css 的 ZCode 主题变量，图标沿用 components/icons.tsx 的线性风格。
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { FileContent, FileEntry } from '@witcode/protocol';
import { IconChevronDown, IconFolder } from '../icons';

export interface FilesPanelProps {
  tree: FileEntry[];
  treePath: string;
  onLoadTree(path: string): void;
  file: FileContent | null;
  onOpenFile(path: string): void;
  onCloseFile(): void;
}

const MAX_LINES = 4000;

function IconFile(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 3h8l4 4v14H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
      <path d="M14 3v5h4" />
    </svg>
  );
}

function DockState({ kind, children }: { kind: 'empty' | 'loading' | 'error'; children: ReactNode }): JSX.Element {
  return (
    <div className={`dock-state dock-state--${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function FilesPanel({ tree, treePath, onLoadTree, file, onOpenFile, onCloseFile }: FilesPanelProps): JSX.Element {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const treeRef = useRef(tree);

  useEffect(() => {
    if (treeRef.current !== tree) {
      treeRef.current = tree;
      setLoading(false);
    }
  }, [tree]);

  useEffect(() => {
    if (!file) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseFile();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [file, onCloseFile]);

  const load = (path: string) => {
    setError(null);
    setLoading(true);
    try {
      onLoadTree(path);
    } catch (err) {
      setError(errorMessage(err));
      setLoading(false);
    }
  };

  const open = (path: string) => {
    setError(null);
    try {
      onOpenFile(path);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  if (file) {
    const allLines = file.content.split(/\r?\n/);
    const lines = allLines.slice(0, MAX_LINES);
    const overflow = allLines.length > MAX_LINES;
    return (
      <div className="dock-panel dock-preview">
        <div className="dock-panel__head">
          <button type="button" className="dock-icon-btn dock-back" onClick={onCloseFile} aria-label="返回目录" title="返回目录 (Esc)">
            <IconChevronDown size={15} />
          </button>
          <span className="dock-panel__title">文件预览</span>
        </div>
        <div className="dock-preview__meta">
          <span className="dock-preview__path" title={file.path}>{file.path}</span>
          <span className="dock-preview__size">{formatSize(file.size)}</span>
        </div>
        {file.binary ? <div className="dock-notice dock-notice--warn">二进制文件，不显示文本内容</div> : null}
        {file.truncated || overflow ? (
          <div className="dock-notice">内容已截断，最多显示 {MAX_LINES} 行</div>
        ) : null}
        {error ? <DockState kind="error">{error}</DockState> : null}
        {file.binary ? null : lines.length === 0 ? (
          <DockState kind="empty">空文件</DockState>
        ) : (
          <pre className="dock-code">
            {lines.map((line, index) => (
              <div className="dock-code__row" key={index}>
                <span className="dock-code__ln">{index + 1}</span>
                <span className="dock-code__text">{line || ' '}</span>
              </div>
            ))}
          </pre>
        )}
      </div>
    );
  }

  const segments = treePath.split(/[\\/]+/).filter(Boolean);

  return (
    <div className="dock-panel">
      <div className="dock-panel__head dock-crumbs">
        <button type="button" className="dock-crumb" onClick={() => load('')} title="workspace 根目录">
          <IconFolder size={13} />
          <span>workspace</span>
        </button>
        {segments.map((segment, index) => (
          <span className="dock-crumb-group" key={`${segment}-${index}`}>
            <span className="dock-crumb__sep">/</span>
            <button
              type="button"
              className={`dock-crumb${index === segments.length - 1 ? ' dock-crumb--current' : ''}`}
              onClick={() => load(segments.slice(0, index + 1).join('/'))}
              title={segments.slice(0, index + 1).join('/')}
            >
              {segment}
            </button>
          </span>
        ))}
      </div>
      <div className="dock-panel__scroll">
        {error ? (
          <DockState kind="error">{error}</DockState>
        ) : loading ? (
          <DockState kind="loading">正在加载目录…</DockState>
        ) : tree.length === 0 ? (
          <DockState kind="empty">
            <span>当前目录没有文件</span>
            <button type="button" className="dock-text-btn" onClick={() => load(treePath)}>刷新</button>
          </DockState>
        ) : (
          tree.map((entry) => (
            <button
              type="button"
              key={`${entry.type}:${entry.path}`}
              className={`dock-row dock-row--${entry.type}`}
              onClick={() => (entry.type === 'dir' ? load(entry.path) : open(entry.path))}
              title={entry.path}
            >
              {entry.type === 'dir' ? <IconFolder size={14} /> : <IconFile />}
              <span className="dock-row__name">{entry.name}</span>
              {entry.type === 'file' && entry.size !== undefined ? (
                <span className="dock-row__size">{formatSize(entry.size)}</span>
              ) : null}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
