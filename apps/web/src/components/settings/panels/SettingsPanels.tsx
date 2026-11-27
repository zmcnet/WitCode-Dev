import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { AppSettings, BrainSummary, ModelInfo, PermissionMode } from '@witcode/protocol';
import type { ThemeMode } from '../../../theme';
import { PERMISSION_MODES, permissionOption, ShieldIcon } from '../../../permission';
import './settings-panels.css';

/** 所有面板的统一 props；服务端设置通过 settings/onSave 即时读写。 */
export interface CommonProps {
  settings: AppSettings | null;
  onSave: (patch: Partial<AppSettings>) => void;
  connected: boolean;
}

export interface BehaviorPanelProps extends CommonProps {
  permissionMode: PermissionMode;
  onSelectPermissionMode: (mode: PermissionMode) => void;
}

export interface MemoryPanelProps extends CommonProps {
  memoryText: string;
  memoryPath: string;
  onLoadMemory: () => void;
  onSaveMemory: (text: string) => void;
}

export interface SubagentsPanelProps extends CommonProps {
  brains: BrainSummary[];
  models: ModelInfo[];
}

export interface PersonalizationPanelProps extends CommonProps {
  personalization: string;
  onLoadPersonalization: () => void;
  onSavePersonalization: (text: string) => void;
}

export interface ProjectsPanelProps extends CommonProps {
  sessionCount: number;
  workspaceName?: string;
  workspacePath?: string;
}

export interface DataPanelProps extends CommonProps {
  sessionCount: number;
}

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  sendKey: 'enter',
  reasoningDisplay: false,
  fontScale: 1,
  replyLanguage: 'auto',
  maxSteps: 30,
  projectMemory: true,
  subagentMaxDepth: 1,
  subagentMaxPerSession: 4,
  subagentBrainId: '',
};

const FONT_SMOOTHING_KEY = 'witcode:font-smoothing';
const PERSONALIZATION_MAX = 20000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// ---------------------------------------------------------------------------
// 排版基元
// ---------------------------------------------------------------------------

function Panel({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="settings-panels">
      <section className="settings-panels__panel">
        <header className="settings-panels__head">
          <h2>{title}</h2>
          <p>{description}</p>
        </header>
        {children}
      </section>
    </div>
  );
}

function SettingGroup({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="settings-panels__group">
      {title ? <div className="settings-panels__group-title">{title}</div> : null}
      <div className="settings-panels__group-body">{children}</div>
    </div>
  );
}

function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="settings-panels__row">
      <div className="settings-panels__row-info">
        <div className="settings-panels__label">{label}</div>
        {description ? <div className="settings-panels__desc">{description}</div> : null}
      </div>
      <div className="settings-panels__control">{children}</div>
    </div>
  );
}

function SettingBlock({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="settings-panels__block">
      <div className="settings-panels__label">{label}</div>
      {description ? <div className="settings-panels__desc">{description}</div> : null}
      <div className="settings-panels__block-control">{children}</div>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={checked ? 'settings-panels__switch is-on' : 'settings-panels__switch'}
      onClick={() => onChange(!checked)}
    >
      <span className="settings-panels__switch-knob" />
    </button>
  );
}

function Select<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  ariaLabel: string;
  disabled?: boolean;
}) {
  return (
    <select
      className="settings-panels__select"
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as T)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function NumberSetting({
  value,
  min,
  max,
  ariaLabel,
  disabled,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  ariaLabel: string;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = () => {
    const parsed = Number(draft);
    const next = Number.isFinite(parsed) ? clamp(Math.round(parsed), min, max) : value;
    setDraft(String(next));
    if (next !== value) onChange(next);
  };

  return (
    <input
      type="number"
      className="settings-panels__input settings-panels__number"
      aria-label={ariaLabel}
      value={draft}
      min={min}
      max={max}
      disabled={disabled}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
      }}
    />
  );
}

function EditableText({
  value,
  label,
  onSave,
  onReload,
  path,
  maxChars,
  placeholder,
  disabled,
}: {
  value: string;
  label: string;
  onSave: (text: string) => void;
  onReload?: () => void;
  path?: string;
  maxChars?: number;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const dirty = draft !== value;
  const count = draft.length;
  const atLimit = maxChars !== undefined && count >= maxChars;

  return (
    <div className="settings-panels__editor">
      {path || onReload ? (
        <div className="settings-panels__editor-bar">
          {path ? <code className="settings-panels__code">{path}</code> : null}
          {onReload ? (
            <button type="button" className="settings-panels__btn" onClick={onReload}>
              重新加载
            </button>
          ) : null}
        </div>
      ) : null}
      <textarea
        className="settings-panels__textarea"
        aria-label={label}
        value={draft}
        placeholder={placeholder}
        maxLength={maxChars}
        onChange={(event) => setDraft(event.target.value)}
      />
      <div className="settings-panels__editor-foot">
        <span className={atLimit ? 'settings-panels__count is-max' : 'settings-panels__count'}>
          {maxChars === undefined ? `${count} 字符` : `${count} / ${maxChars} 字符`}
        </span>
        <div className="settings-panels__editor-actions">
          <button type="button" className="settings-panels__btn" disabled={!dirty} onClick={() => setDraft(value)}>
            取消
          </button>
          <button
            type="button"
            className="settings-panels__btn is-primary"
            disabled={!dirty || disabled}
            onClick={() => onSave(draft)}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 面板
// ---------------------------------------------------------------------------

export function GeneralPanel(_props: CommonProps) {
  return (
    <Panel title="常规" description="工作台的基础信息与偏好。">
      <SettingGroup>
        <SettingRow label="语言" description="界面语言固定为简体中文。">
          <Select
            ariaLabel="语言"
            value="zh-CN"
            options={[{ value: 'zh-CN', label: '简体中文' }]}
            onChange={() => {}}
            disabled
          />
        </SettingRow>
        <SettingRow label="界面模式" description="Web 工作台；深浅主题在外观中设置。">
          <span className="settings-panels__static">Web 工作台</span>
        </SettingRow>
        <SettingRow label="数据目录" description="服务端 ~/.witcode 或 WITCODE_DATA_DIR。">
          <code className="settings-panels__code">~/.witcode</code>
        </SettingRow>
        <SettingRow label="版本" description="WitCode 当前版本。">
          <span className="settings-panels__static">0.1.0</span>
        </SettingRow>
      </SettingGroup>
    </Panel>
  );
}

export function AppearancePanel({ settings, onSave, connected }: CommonProps) {
  const theme = settings?.theme ?? DEFAULT_SETTINGS.theme;
  const [smoothing, setSmoothing] = useState(() => {
    try {
      return localStorage.getItem(FONT_SMOOTHING_KEY) !== 'off';
    } catch {
      return true;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(FONT_SMOOTHING_KEY, smoothing ? 'on' : 'off');
    } catch {
      // localStorage 不可用时仍切换 class。
    }
    document.documentElement.classList.toggle('no-font-smoothing', !smoothing);
  }, [smoothing]);

  return (
    <Panel title="外观" description="主题与字体渲染偏好。">
      <SettingGroup title="主题">
        <SettingRow label="界面主题" description="深色、浅色或跟随系统。">
          <Select<ThemeMode>
            ariaLabel="界面主题"
            value={theme}
            options={[
              { value: 'dark', label: '深色' },
              { value: 'light', label: '浅色' },
              { value: 'system', label: '跟随系统' },
            ]}
            disabled={!connected}
            onChange={(value) => onSave({ theme: value })}
          />
        </SettingRow>
        <SettingRow label="界面字号" description="只放大文字，不改变布局尺寸。">
          <Select
            ariaLabel="界面字号"
            value={String(settings?.fontScale ?? 1)}
            options={[
              { value: '0.9', label: '小（90%）' },
              { value: '1', label: '标准（100%）' },
              { value: '1.1', label: '大（110%）' },
              { value: '1.2', label: '特大（120%）' },
              { value: '1.3', label: '超大（130%）' },
            ]}
            disabled={!connected}
            onChange={(value) => onSave({ fontScale: Number(value) })}
          />
        </SettingRow>
        <SettingRow label="字体平滑" description="关闭后使用系统默认字体渲染。">
          <Toggle
            label="字体平滑"
            checked={smoothing}
            onChange={setSmoothing}
          />
        </SettingRow>
      </SettingGroup>
    </Panel>
  );
}

export function BehaviorPanel({
  settings,
  onSave,
  connected,
  permissionMode,
  onSelectPermissionMode,
}: BehaviorPanelProps) {
  const current = settings ?? DEFAULT_SETTINGS;
  const permission = permissionOption(permissionMode);

  return (
    <Panel title="行为" description="回复呈现、执行步数与权限模式。">
      <SettingGroup title="回复">
        <SettingRow label="推理过程显示" description="在回复中展示模型的思考过程。">
          <Toggle
            label="推理过程显示"
            checked={current.reasoningDisplay}
            disabled={!connected}
            onChange={(value) => onSave({ reasoningDisplay: value })}
          />
        </SettingRow>
        <SettingRow label="回复语言" description="auto 表示跟随用户提问语言。">
          <Select<AppSettings['replyLanguage']>
            ariaLabel="回复语言"
            value={current.replyLanguage}
            options={[
              { value: 'auto', label: '自动' },
              { value: 'zh-CN', label: '简体中文' },
              { value: 'en', label: 'English' },
            ]}
            disabled={!connected}
            onChange={(value) => onSave({ replyLanguage: value })}
          />
        </SettingRow>
        <SettingRow label="单轮最大步数" description="模型与工具调用的总步数上限（1–100）。">
          <NumberSetting
            ariaLabel="单轮最大步数"
            value={current.maxSteps}
            min={1}
            max={100}
            disabled={!connected}
            onChange={(value) => onSave({ maxSteps: value })}
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="权限">
        <SettingBlock label="权限模式" description={`${permission.label}：${permission.description}`}>
          <div className="settings-panels__perm-grid" role="radiogroup" aria-label="权限模式">
            {PERMISSION_MODES.map((item) => {
              const active = item.mode === permissionMode;
              return (
                <button
                  key={item.mode}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={!connected}
                  className={active ? 'settings-panels__perm-btn is-active' : 'settings-panels__perm-btn'}
                  onClick={() => onSelectPermissionMode(item.mode)}
                >
                  <ShieldIcon />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>
        </SettingBlock>
      </SettingGroup>
    </Panel>
  );
}

export function MemoryPanel({
  settings,
  onSave,
  connected,
  memoryText,
  memoryPath,
  onLoadMemory,
  onSaveMemory,
}: MemoryPanelProps) {
  const current = settings ?? DEFAULT_SETTINGS;

  return (
    <Panel title="记忆与上下文" description="项目记忆注入 system prompt；上下文预算由产品硬约束固定。">
      <SettingGroup title="项目记忆">
        <SettingRow label="启用项目记忆" description="把记忆文件内容注入 system prompt。">
          <Toggle
            label="启用项目记忆"
            checked={current.projectMemory}
            disabled={!connected}
            onChange={(value) => onSave({ projectMemory: value })}
          />
        </SettingRow>
        <SettingBlock label="记忆文件" description="编辑后保存，取消可还原到上次加载的内容。">
          <EditableText
            value={memoryText}
            label="记忆文件"
            path={memoryPath}
            placeholder="每行一条项目记忆…"
            onReload={onLoadMemory}
            onSave={onSaveMemory}
            disabled={!connected}
          />
        </SettingBlock>
      </SettingGroup>

      <SettingGroup title="上下文预算">
        <SettingRow label="上下文窗口" description="模型上下文总窗口。">
          <span className="settings-panels__static">1,000,000 tokens</span>
        </SettingRow>
        <SettingRow label="脑子（system）" description="系统提示词预留。">
          <span className="settings-panels__static">200,000 tokens</span>
        </SettingRow>
        <SettingRow label="正常会话" description="可用对话上下文。">
          <span className="settings-panels__static">800,000 tokens</span>
        </SettingRow>
        <SettingRow label="最大输出" description="单次输出硬上限。">
          <span className="settings-panels__static">128,000 tokens</span>
        </SettingRow>
      </SettingGroup>

      <div className="settings-panels__note">
        压缩模式由服务端环境变量控制：<code className="settings-panels__code">WITCODE_CONTEXT_MODE=off | summary | acp</code>（默认 off）。
      </div>
    </Panel>
  );
}

export function SubagentsPanel({ settings, onSave, connected, brains, models }: SubagentsPanelProps) {
  const current = settings ?? DEFAULT_SETTINGS;
  const brainOptions = [
    { value: '', label: '默认（跟随当前脑子）' },
    ...brains.map((brain) => ({ value: brain.id, label: brain.name })),
  ];
  const modelOptions = [
    { value: '', label: '主模型（跟随主会话）' },
    ...models
      .filter((model) => model.enabled)
      .map((model) => ({
        value: `${model.providerId}/${model.id}`,
        label: `${model.providerName} / ${model.displayName ?? model.id}`,
      })),
  ];
  const currentModel = current.subagentModel
    ? `${current.subagentModel.providerId}/${current.subagentModel.model}`
    : '';

  return (
    <Panel title="子智能体" description="派发子智能体时的层级、数量与默认脑子。">
      <SettingGroup title="派发策略">
        <SettingRow label="最大嵌套层数" description="子智能体可继续向下派发的层级（1–3）。">
          <Select
            ariaLabel="最大嵌套层数"
            value={String(current.subagentMaxDepth)}
            options={[
              { value: '1', label: '1 层' },
              { value: '2', label: '2 层' },
              { value: '3', label: '3 层' },
            ]}
            disabled={!connected}
            onChange={(value) => onSave({ subagentMaxDepth: Number(value) })}
          />
        </SettingRow>
        <SettingRow label="每会话最多派发" description="单个会话内派发的子智能体数量上限（1–10）。">
          <NumberSetting
            ariaLabel="每会话最多派发"
            value={current.subagentMaxPerSession}
            min={1}
            max={10}
            disabled={!connected}
            onChange={(value) => onSave({ subagentMaxPerSession: value })}
          />
        </SettingRow>
        <SettingRow label="默认脑子" description="子智能体启动时使用的脑子。">
          <Select
            ariaLabel="默认脑子"
            value={current.subagentBrainId}
            options={brainOptions}
            disabled={!connected}
            onChange={(value) => onSave({ subagentBrainId: value })}
          />
        </SettingRow>
        <SettingRow label="默认模型" description="子智能体使用的模型；默认跟随主会话。">
          <Select
            ariaLabel="默认模型"
            value={currentModel}
            options={modelOptions}
            disabled={!connected}
            onChange={(value) => {
              if (!value) {
                onSave({ subagentModel: null });
                return;
              }
              const index = value.indexOf('/');
              onSave({
                subagentModel: {
                  providerId: value.slice(0, index),
                  model: value.slice(index + 1),
                },
              });
            }}
          />
        </SettingRow>
      </SettingGroup>
    </Panel>
  );
}

export function ShortcutsPanel({ settings, onSave, connected }: CommonProps) {
  const current = settings ?? DEFAULT_SETTINGS;

  return (
    <Panel title="快捷键" description="发送方式与常用键盘操作。">
      <SettingGroup title="发送">
        <SettingRow label="发送消息" description="选择触发发送的按键。">
          <Select<AppSettings['sendKey']>
            ariaLabel="发送消息"
            value={current.sendKey}
            options={[
              { value: 'enter', label: 'Enter' },
              { value: 'ctrl-enter', label: 'Ctrl/⌘ + Enter' },
            ]}
            disabled={!connected}
            onChange={(value) => onSave({ sendKey: value })}
          />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="其他">
        <SettingRow label="停止生成 / 关闭弹层">
          <kbd className="settings-panels__kbd">Esc</kbd>
        </SettingRow>
        <SettingRow label="设置内搜索">
          <kbd className="settings-panels__kbd">Ctrl/⌘ + K</kbd>
        </SettingRow>
      </SettingGroup>
    </Panel>
  );
}

export function PersonalizationPanel({
  personalization,
  onLoadPersonalization,
  onSavePersonalization,
  connected,
}: PersonalizationPanelProps) {
  return (
    <Panel title="个性化" description="写入 system prompt 的用户级偏好。">
      <SettingGroup title="用户偏好">
        <SettingBlock label="个性化内容" description="以下内容会注入 system prompt，影响所有回复。">
          <EditableText
            value={personalization}
            label="个性化内容"
            placeholder="例如：偏好简洁回答、始终使用中文思考…"
            onReload={onLoadPersonalization}
            onSave={onSavePersonalization}
            maxChars={PERSONALIZATION_MAX}
            disabled={!connected}
          />
        </SettingBlock>
      </SettingGroup>
    </Panel>
  );
}

export function ProjectsPanel({ sessionCount, workspaceName, workspacePath }: ProjectsPanelProps) {
  return (
    <Panel title="工作区" description="当前工作区与会话概览。">
      <SettingGroup>
        <SettingRow label="当前工作区" description="名称与路径取自启动时的工作目录。">
          <span className="settings-panels__static">{workspaceName ?? '当前目录'}</span>
        </SettingRow>
        {workspacePath ? (
          <SettingRow label="工作区路径">
            <code className="settings-panels__code">{workspacePath}</code>
          </SettingRow>
        ) : null}
        <SettingRow label="会话数量" description="当前工作区下的会话。">
          <span className="settings-panels__static">{sessionCount} 个</span>
        </SettingRow>
      </SettingGroup>
    </Panel>
  );
}

export function DataPanel({ sessionCount }: DataPanelProps) {
  return (
    <Panel title="数据" description="会话与用量保存在服务端本机，不经过第三方。">
      <SettingGroup>
        <SettingRow label="会话数量">
          <span className="settings-panels__static">{sessionCount} 个</span>
        </SettingRow>
        <SettingRow label="会话存储">
          <span className="settings-panels__static">SQLite（服务端）</span>
        </SettingRow>
        <SettingRow label="数据目录">
          <span className="settings-panels__static">
            <code className="settings-panels__code">~/.witcode</code> 或{' '}
            <code className="settings-panels__code">WITCODE_DATA_DIR</code>
          </span>
        </SettingRow>
        <SettingRow label="归档" description="归档只在前端隐藏会话，不删除数据库记录。">
          <span className="settings-panels__static">前端隐藏</span>
        </SettingRow>
      </SettingGroup>
    </Panel>
  );
}

export function AboutPanel(_props: CommonProps) {
  return (
    <Panel title="关于" description="Web 优先的 Coding Harness：内核只负责插拔，能力都是插件。">
      <SettingGroup>
        <SettingRow label="版本">
          <span className="settings-panels__static">0.1.0</span>
        </SettingRow>
        <SettingRow label="许可">
          <span className="settings-panels__static">Apache-2.0</span>
        </SettingRow>
        <SettingRow label="仓库">
          <a
            className="settings-panels__link"
            href="https://github.com/zmcnet/WitCode-Dev"
            target="_blank"
            rel="noopener noreferrer"
          >
            github.com/zmcnet/WitCode-Dev
          </a>
        </SettingRow>
      </SettingGroup>
    </Panel>
  );
}
