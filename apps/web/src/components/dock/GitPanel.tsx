/**
 * 右栏「Git」页：分支状态、变更列表与逐行着色的 diff。
 * 颜色取自 styles.css 的 ZCode 主题变量，图标沿用 components/icons.tsx 的线性风格。
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { GitChange } from '@witcode/protocol';
import { IconChevronDown } from '../icons';

export interface GitPanelProps {
  branch: string;
  changes: GitChange[];
  diff: string | null;
  onLoad(): void;
  onOpenDiff(path: string): void;
}

type IconProps = { size?: number };

export function IconGitBranch({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="6" cy="5" r="2.2" />
      <circle cx="6" cy="19" r="2.2" />
      <circle cx="18" cy="7" r="2.2" />
      <path d="M6 7.2v9.6M18 9.2v1.3a5 5 0 0 1-5 5H8.2" />
    </svg>
  );
}

function IconRefresh({ size = 14 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 11a8 8 0 1 0-2.3 6.5" />
      <path d="M20 4v7h-7" />
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function statusKind(status: string): string {
  const letter = status.trim().slice(0, 1) || '?';
  if (letter === '?') return 'untracked';
  if (letter === 'D') return 'deleted';
  if (letter === 'A') return 'added';
  if (letter === 'R') return 'renamed';
  return 'modified';
}

function diffClass(line: string): string {
  if (line.startsWith('@@')) return 'dock-diff__line dock-diff__hunk';
  if (line.startsWith('+++') || line.startsWith('---')) return 'dock-diff__line dock-diff__meta';
  if (line.startsWith('+')) return 'dock-diff__line dock-diff__add';
  if (line.startsWith('-')) return 'dock-diff__line dock-diff__del';
  return 'dock-diff__line';
}

export function GitPanel({ branch, changes, diff, onLoad, onOpenDiff }: GitPanelProps): JSX.Element {
  const [view, setView] = useState<'list' | 'diff'>(diff !== null ? 'diff' : 'list');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changesRef = useRef(changes);

  useEffect(() => {
    if (changesRef.current !== changes) {
      changesRef.current = changes;
      setLoading(false);
    }
  }, [changes]);

  const refresh = () => {
    setError(null);
    setLoading(true);
    try {
      onLoad();
    } catch (err) {
      setError(errorMessage(err));
      setLoading(false);
    }
  };

  const openDiff = (path: string) => {
    setError(null);
    setView('diff');
    try {
      onOpenDiff(path);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <div className="dock-panel dock-git">
      <div className="dock-panel__head dock-git__branch">
        <IconGitBranch size={14} />
        <span className="dock-git__branch-name" title={branch}>{branch || '(无分支)'}</span>
        <button type="button" className="dock-icon-btn dock-git__refresh" onClick={refresh} aria-label="刷新 Git 状态" title="刷新">
          <IconRefresh size={14} />
        </button>
      </div>
      {view === 'diff' ? (
        <>
          <div className="dock-panel__head">
            <button type="button" className="dock-icon-btn dock-back" onClick={() => setView('list')} aria-label="返回变更列表" title="返回变更列表">
              <IconChevronDown size={15} />
            </button>
            <span className="dock-panel__title">差异</span>
          </div>
          {error ? <DockState kind="error">{error}</DockState> : diff === null ? (
            <DockState kind="loading">正在加载 diff…</DockState>
          ) : diff.length === 0 ? (
            <DockState kind="empty">没有差异</DockState>
          ) : (
            <pre className="dock-diff">
              {diff.split(/\r?\n/).map((line, index) => (
                <div className={diffClass(line)} key={index}>{line || ' '}</div>
              ))}
            </pre>
          )}
        </>
      ) : (
        <div className="dock-panel__scroll">
          {error ? (
            <DockState kind="error">{error}</DockState>
          ) : loading ? (
            <DockState kind="loading">正在加载 Git 状态…</DockState>
          ) : changes.length === 0 ? (
            <DockState kind="empty">
              <span>没有文件变更</span>
              <button type="button" className="dock-text-btn" onClick={refresh}>刷新</button>
            </DockState>
          ) : (
            changes.map((change) => (
              <button
                type="button"
                key={change.path}
                className="dock-row dock-row--change"
                onClick={() => openDiff(change.path)}
                title={change.path}
              >
                <span className={`dock-status dock-status--${statusKind(change.status)}`}>
                  {change.status.trim().slice(0, 1) || '?'}
                </span>
                <span className="dock-row__name">{change.path}</span>
                <span className={`dock-git__tag${change.staged ? ' dock-git__tag--staged' : ''}`}>
                  {change.staged ? '已暂存' : '未暂存'}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
