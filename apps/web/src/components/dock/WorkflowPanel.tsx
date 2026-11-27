/**
 * 右栏「工作流」页：对齐 ZCode workflow run 详情的最小版。
 * 运行列表 + 阶段脊线 + 产物区；颜色取自 styles.css 的 ZCode 主题变量。
 */
import { useEffect, useState } from 'react';
import type { WorkflowRun } from '@witcode/protocol';
import { IconChevronDown, IconStop } from '../icons';
import { Markdown } from '../Markdown';
import './workflow.css';

export interface WorkflowPanelProps {
  runs: WorkflowRun[];
  selectedId: string | null;
  onSelect(id: string): void;
  onCancel(id: string): void;
  onRefresh(): void;
}

type Phase = WorkflowRun['phases'][number];
type Actor = Phase['actors'][number];
type Artifact = WorkflowRun['artifacts'][number];
type StatusKey = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

const MAX_OUTPUT = 3000;

const RUN_LABEL: Record<WorkflowRun['status'], string> = {
  pending: '等待中',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

const PHASE_LABEL: Record<Phase['status'], string> = {
  pending: '等待中',
  running: '运行中',
  done: '已完成',
  failed: '失败',
};

const ACTOR_LABEL: Record<Actor['status'], string> = {
  queued: '排队中',
  running: '运行中',
  done: '已完成',
  failed: '失败',
};

function runKey(status: WorkflowRun['status']): StatusKey {
  return status === 'completed' ? 'done' : status;
}

function actorKey(status: Actor['status']): StatusKey {
  return status === 'queued' ? 'pending' : status;
}

function formatTime(ts: number): string {
  const date = new Date(ts);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function truncate(text: string): { text: string; omitted: boolean } {
  return { text: text.slice(0, MAX_OUTPUT), omitted: text.length > MAX_OUTPUT };
}

function IconRefresh(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

function Dot({ status }: { status: StatusKey }): JSX.Element {
  return <span className={`workflow-dot workflow-dot--${status}`} aria-hidden="true" />;
}

function Tag({ status, label }: { status: StatusKey; label: string }): JSX.Element {
  return <span className={`workflow-tag workflow-tag--${status}`}>{label}</span>;
}

interface PhaseRowProps {
  phase: Phase;
  expanded: boolean;
  openActors: Record<string, boolean>;
  onTogglePhase(): void;
  onToggleActor(id: string): void;
}

function PhaseRow({ phase, expanded, openActors, onTogglePhase, onToggleActor }: PhaseRowProps): JSX.Element {
  const key: StatusKey = phase.status;
  return (
    <div className={`workflow-phase workflow-phase--${key}`}>
      <button type="button" className="workflow-phase__head" onClick={onTogglePhase} aria-expanded={expanded}>
        <span className="workflow-rail">
          <Dot status={key} />
        </span>
        <span className="workflow-phase__name">{phase.name}</span>
        <span className="workflow-phase__count">{phase.actors.length} 个 actor</span>
        <IconChevronDown size={14} className={`workflow-chevron${expanded ? ' workflow-chevron--open' : ''}`} />
      </button>
      {expanded ? (
        <div className="workflow-phase__actors">
          {phase.actors.length === 0 ? (
            <div className="workflow-muted workflow-phase__no-actor">暂无 actor</div>
          ) : (
            phase.actors.map((actor) => {
              const actorStatus = actorKey(actor.status);
              const open = Boolean(openActors[actor.id]);
              const slice = actor.output ? truncate(actor.output) : null;
              return (
                <div className="workflow-actor" key={actor.id}>
                  <button type="button" className="workflow-actor__head" onClick={() => onToggleActor(actor.id)} aria-expanded={open}>
                    <span className="workflow-rail">
                      <Dot status={actorStatus} />
                    </span>
                    <span className="workflow-actor__name">{actor.name}</span>
                    <Tag status={actorStatus} label={ACTOR_LABEL[actor.status]} />
                    {actor.output || actor.error ? (
                      <IconChevronDown size={13} className={`workflow-chevron${open ? ' workflow-chevron--open' : ''}`} />
                    ) : null}
                  </button>
                  {open ? (
                    <div className="workflow-actor__detail">
                      {actor.error ? <div className="workflow-error">{actor.error}</div> : null}
                      {slice ? (
                        <pre className="workflow-output">{slice.text}{slice.omitted ? '\n…（输出已截断，最多 3000 字）' : ''}</pre>
                      ) : null}
                      {!actor.error && !slice ? <div className="workflow-muted">暂无输出</div> : null}
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}

interface ArtifactRowProps {
  artifact: Artifact;
  expanded: boolean;
  onToggle(): void;
}

function ArtifactRow({ artifact, expanded, onToggle }: ArtifactRowProps): JSX.Element {
  return (
    <div className={`workflow-artifact${expanded ? ' workflow-artifact--open' : ''}`}>
      <button type="button" className="workflow-artifact__head" onClick={onToggle} aria-expanded={expanded}>
        <IconChevronDown size={13} className={`workflow-chevron${expanded ? ' workflow-chevron--open' : ''}`} />
        <span className="workflow-artifact__title">{artifact.title}</span>
        <span className="workflow-artifact__kind">{artifact.kind === 'markdown' ? 'MD' : 'TXT'}</span>
        <span className="workflow-artifact__time">{formatTime(artifact.createdAt)}</span>
      </button>
      {expanded ? (
        <div className="workflow-artifact__body">
          {artifact.kind === 'markdown' ? (
            <Markdown text={artifact.content} />
          ) : (
            <pre className="workflow-artifact__text">{artifact.content}</pre>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function WorkflowPanel({ runs, selectedId, onSelect, onCancel, onRefresh }: WorkflowPanelProps): JSX.Element {
  const [phaseOverrides, setPhaseOverrides] = useState<Record<string, boolean>>({});
  const [openActors, setOpenActors] = useState<Record<string, boolean>>({});
  const [openArtifacts, setOpenArtifacts] = useState<Record<string, boolean>>({});
  const [now, setNow] = useState(() => Date.now());

  const selected = runs.find((run) => run.id === selectedId) ?? null;
  const isRunning = selected?.status === 'running';

  useEffect(() => {
    if (!isRunning) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isRunning]);

  const isPhaseOpen = (phase: Phase): boolean => phaseOverrides[phase.id] ?? phase.status === 'running';
  const togglePhase = (phase: Phase) => setPhaseOverrides((prev) => ({ ...prev, [phase.id]: !isPhaseOpen(phase) }));
  const toggleActor = (id: string) => setOpenActors((prev) => ({ ...prev, [id]: !prev[id] }));
  const toggleArtifact = (id: string) => setOpenArtifacts((prev) => ({ ...prev, [id]: !prev[id] }));

  const durationMs = selected ? (isRunning ? now : selected.updatedAt) - selected.createdAt : 0;
  const selectedKey = selected ? runKey(selected.status) : 'pending';

  return (
    <div className="workflow-panel">
      <div className="workflow-panel__head">
        <span className="workflow-panel__title">工作流</span>
        <button type="button" className="workflow-icon-btn" onClick={onRefresh} title="刷新" aria-label="刷新">
          <IconRefresh />
        </button>
      </div>

      {runs.length === 0 ? (
        <div className="workflow-empty" role="status">
          <div className="workflow-empty__title">还没有工作流</div>
          <div className="workflow-empty__desc">在对话里让智能体用 create_workflow 启动</div>
        </div>
      ) : (
        <div className="workflow-panel__body">
          <div className="workflow-runs">
            {runs.map((run) => {
              const key = runKey(run.status);
              return (
                <button
                  type="button"
                  key={run.id}
                  className={`workflow-run-item${run.id === selectedId ? ' workflow-run-item--active' : ''}`}
                  onClick={() => onSelect(run.id)}
                >
                  <Dot status={key} />
                  <span className="workflow-run-item__name" title={run.name}>{run.name}</span>
                  <Tag status={key} label={RUN_LABEL[run.status]} />
                  <span className="workflow-run-item__time">{formatTime(run.createdAt)}</span>
                </button>
              );
            })}
          </div>

          {!selected ? (
            <div className="workflow-empty workflow-empty--hint" role="status">选择一条运行查看详情</div>
          ) : (
            <div className="workflow-detail">
              <div className="workflow-detail__head">
                <div className="workflow-detail__title">
                  <Dot status={selectedKey} />
                  <span className="workflow-detail__name">{selected.name}</span>
                  <Tag status={selectedKey} label={RUN_LABEL[selected.status]} />
                </div>
                <div className="workflow-detail__meta">
                  <span className="workflow-detail__duration">耗时 {formatDuration(durationMs)}</span>
                  {isRunning ? (
                    <button type="button" className="workflow-cancel" onClick={() => onCancel(selected.id)}>
                      <IconStop size={12} />
                      取消
                    </button>
                  ) : null}
                </div>
              </div>

              {selected.error ? <div className="workflow-error workflow-detail__error">{selected.error}</div> : null}

              <div className="workflow-section">
                <div className="workflow-section__title">阶段</div>
                <div className="workflow-phases">
                  {selected.phases.length === 0 ? (
                    <div className="workflow-starting">脚本启动中…</div>
                  ) : (
                    selected.phases.map((phase) => (
                      <PhaseRow
                        key={phase.id}
                        phase={phase}
                        expanded={isPhaseOpen(phase)}
                        openActors={openActors}
                        onTogglePhase={() => togglePhase(phase)}
                        onToggleActor={toggleActor}
                      />
                    ))
                  )}
                </div>
              </div>

              <div className="workflow-section">
                <div className="workflow-section__title">产物 ({selected.artifacts.length})</div>
                {selected.artifacts.length === 0 ? (
                  <div className="workflow-muted workflow-artifacts__empty">暂无产物</div>
                ) : (
                  <div className="workflow-artifacts">
                    {selected.artifacts.map((artifact) => (
                      <ArtifactRow
                        key={artifact.id}
                        artifact={artifact}
                        expanded={Boolean(openArtifacts[artifact.id])}
                        onToggle={() => toggleArtifact(artifact.id)}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
