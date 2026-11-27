/**
 * ZCode 右侧停靠栏：文件 / Git / 终端。
 * 宽度受控于 props，左侧 4px 拖拽条通过 pointer capture 调节；
 * 颜色全部取自 styles.css 的 ZCode 主题变量，图标沿用 components/icons.tsx。
 */
import { useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { FileContent, FileEntry, GitChange, WorkflowRun } from '@witcode/protocol';
import { IconBlocks, IconFolder, IconSparkles, IconTerminal, IconX } from '../icons';
import { FilesPanel } from './FilesPanel';
import { GitPanel, IconGitBranch } from './GitPanel';
import { TerminalPanel } from './TerminalPanel';
import { WorkflowPanel } from './WorkflowPanel';
import './dock.css';

export type DockTab = 'files' | 'git' | 'terminal' | 'workflow' | `plugin:${string}`;

export interface RightDockProps {
  width: number;
  onWidthChange(width: number): void;
  onClose(): void;
  files: {
    tree: FileEntry[]; treePath: string;
    onLoadTree(path: string): void;
    file: FileContent | null;
    onOpenFile(path: string): void;
    onCloseFile(): void;
  };
  git: {
    branch: string; changes: GitChange[]; diff: string | null;
    onLoad(): void; onOpenDiff(path: string): void;
  };
  terminal: {
    subscribe(cb: (data: string) => void): () => void;
    send(data: string): void;
    resize(cols: number, rows: number): void;
    create(cols: number, rows: number): void;
    close(): void;
  };
  pluginPanels: Array<{ id: string; title: string; entry: string }>;
  workflow: {
    runs: WorkflowRun[];
    selectedId: string | null;
    onSelect(id: string): void;
    onCancel(id: string): void;
    onRefresh(): void;
  };
  activeTab?: DockTab;
  onTabChange?(tab: DockTab): void;
}

const MIN_WIDTH = 240;
const MAX_WIDTH = 720;
const DEFAULT_WIDTH = 320;

type TabIcon = (props: { size?: number }) => JSX.Element;

const TABS: { key: DockTab; label: string; Icon: TabIcon }[] = [
  { key: 'files', label: '文件', Icon: IconFolder },
  { key: 'git', label: 'Git', Icon: IconGitBranch },
  { key: 'terminal', label: '终端', Icon: IconTerminal },
  { key: 'workflow', label: '工作流', Icon: IconSparkles },
];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function RightDock(props: RightDockProps): JSX.Element {
  const { width, onWidthChange, onClose, files, git, terminal, workflow, pluginPanels, activeTab, onTabChange } = props;
  const [internalTab, setInternalTab] = useState<DockTab>('files');
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const isControlled = activeTab !== undefined;
  const currentTab = isControlled ? activeTab : internalTab;
  const selectTab = (tab: DockTab) => {
    if (!isControlled) setInternalTab(tab);
    onTabChange?.(tab);
  };

  const displayWidth = Number.isFinite(width) ? clamp(width, MIN_WIDTH, MAX_WIDTH) : DEFAULT_WIDTH;

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { startX: event.clientX, startWidth: displayWidth };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const next = clamp(drag.startWidth + (drag.startX - event.clientX), MIN_WIDTH, MAX_WIDTH);
    onWidthChange(next);
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <aside className="dock" style={{ width: displayWidth }} aria-label="右侧工具面板">
      <div
        className="dock__resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整面板宽度"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={() => { dragRef.current = null; }}
      />
      <div className="dock__tabs" role="tablist" aria-label="右侧工具面板标签">
        {[
          ...TABS,
          ...pluginPanels.map((panel) => ({
            key: `plugin:${panel.id}` as DockTab,
            label: panel.title,
            Icon: IconBlocks,
          })),
        ].map(({ key, label, Icon }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={currentTab === key}
            className={`dock__tab${currentTab === key ? ' dock__tab--active' : ''}`}
            onClick={() => selectTab(key)}
          >
            <Icon size={15} />
            <span>{label}</span>
          </button>
        ))}
        <button type="button" className="dock__close" onClick={onClose} aria-label="关闭右侧面板" title="关闭">
          <IconX size={16} />
        </button>
      </div>
      <div className="dock__body">
        {currentTab === 'files' ? <FilesPanel {...files} /> : null}
        {currentTab === 'git' ? <GitPanel {...git} /> : null}
        {currentTab === 'terminal' ? <TerminalPanel {...terminal} /> : null}
        {currentTab === 'workflow' ? <WorkflowPanel {...workflow} /> : null}
        {currentTab.startsWith('plugin:')
          ? (() => {
              const panel = pluginPanels.find((item) => `plugin:${item.id}` === currentTab);
              if (!panel) return null;
              return (
                <iframe
                  key={panel.id}
                  className="dock__plugin-frame"
                  title={panel.title}
                  sandbox="allow-scripts allow-forms"
                  src={`/plugin-ui/${encodeURIComponent(panel.id)}/${panel.entry
                    .split('/')
                    .map(encodeURIComponent)
                    .join('/')}`}
                />
              );
            })()
          : null}
      </div>
    </aside>
  );
}
