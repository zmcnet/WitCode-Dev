/**
 * 内置能力插件管理器（数据型插件，不执行第三方代码）。
 *
 * 把工具、Brain、协作工具与内核特性按组暴露为可开关的插件：
 * 开关状态落盘到 `<dataDir>/plugins.json`，安装的自定义 Brain 也一并持久化，
 * 启动时重新 registerBrain，卸载时先 unregisterBrain 再删持久化。
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getBrain, registerBrain, unregisterBrain } from '@witcode/brains';
import type { BrainDefinition, PluginComponent, PluginSummary } from '@witcode/protocol';

export interface PluginManagerOptions {
  /** 数据目录；默认 WITCODE_DATA_DIR 或 ~/.witcode */
  dataDir?: string;
  /** 当前注册的工具名 */
  toolNames: string[];
  /** 当前全部 Brain id */
  brainIds: string[];
}

export interface PluginManager {
  list(): PluginSummary[];
  setPluginEnabled(id: string, enabled: boolean): Promise<PluginSummary[]>;
  setComponentEnabled(
    pluginId: string,
    componentId: string,
    enabled: boolean,
  ): Promise<PluginSummary[]>;
  installBrain(manifest: string): Promise<PluginSummary[]>;
  uninstall(id: string): Promise<PluginSummary[]>;
  isToolEnabled(name: string): boolean;
  isBrainEnabled(id: string): boolean;
  /** 'projectMemory' | 'context'；'echo' 永远返回 true */
  isFeatureEnabled(id: string): boolean;
}

const COLLAB_TOOLS = new Set(['consult_partner', 'spawn_subagent']);

const TOOL_LABELS: Record<string, string> = {
  read_file: '读取文件',
  write_file: '写入文件',
  list_dir: '列出目录',
  grep: '内容搜索',
  run_command: '执行命令',
  consult_partner: '咨询伙伴',
  spawn_subagent: '派发子智能体',
  use_skill: '加载技能',
  todo_write: '更新待办',
  todo_read: '读取待办',
  web_fetch: '抓取网页',
  web_search: '联网搜索',
  set_goal: '设置目标',
  get_goal: '读取目标',
  update_goal: '更新目标',
  run_background: '后台命令',
  job_output: '读取任务输出',
  job_list: '列出后台任务',
  job_kill: '终止后台任务',
  edit_file: '精确编辑文件',
  apply_patch: '应用补丁',
  glob: '按模式找文件',
  session_search: '搜索历史会话',
  session_export: '导出会话',
  create_workflow: '启动工作流',
};

const ECHO_LOCK_REASON = '回声兜底不可停用，保证模型链路始终可用';

interface PersistedState {
  disabled: string[];
  customBrains: BrainDefinition[];
}

function resolveDataDir(options: PluginManagerOptions): string {
  return options.dataDir ?? process.env.WITCODE_DATA_DIR ?? path.join(os.homedir(), '.witcode');
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, filePath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBrainLike(value: unknown): value is BrainDefinition {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    value.id.trim() !== '' &&
    typeof value.name === 'string' &&
    value.name.trim() !== '' &&
    typeof value.identity === 'string' &&
    value.identity.trim() !== ''
  );
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${field} 必须是字符串数组`);
  }
  return [...value] as string[];
}

/** 解析并校验安装清单；只有 id / name / identity 必填，其余字段按类型校验后补默认值。 */
function parseManifest(manifest: string): BrainDefinition {
  let raw: unknown;
  try {
    raw = JSON.parse(manifest);
  } catch {
    throw new Error('插件清单不是合法 JSON');
  }
  if (!isRecord(raw)) throw new Error('插件清单必须是 JSON 对象');

  const requireText = (key: string): string => {
    const value = raw[key];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`${key} 必须是非空字符串`);
    }
    return value.trim();
  };

  const id = requireText('id');
  const name = requireText('name');
  const identity = requireText('identity');
  const rules = raw.rules === undefined ? [] : stringArray(raw.rules, 'rules');
  const bestFor = raw.bestFor === undefined ? [] : stringArray(raw.bestFor, 'bestFor');

  let tools: unknown = {};
  if (raw.tools !== undefined) {
    if (!isRecord(raw.tools)) throw new Error('tools 必须是对象');
    tools = raw.tools;
  }

  let modes: unknown;
  if (raw.modes !== undefined) {
    if (!Array.isArray(raw.modes)) throw new Error('modes 必须是数组');
    modes = raw.modes;
  }

  const description =
    typeof raw.description === 'string' && raw.description.trim() !== ''
      ? raw.description
      : `自定义 Brain：${name}`;

  return {
    // 透传清单里的其它 BrainDefinition 可选字段（如 prompts / flow / execution）。
    ...(raw as unknown as Partial<BrainDefinition>),
    id,
    name,
    identity,
    description,
    rules,
    bestFor,
    tools: tools as BrainDefinition['tools'],
    ...(modes === undefined ? {} : { modes: modes as BrainDefinition['modes'] }),
  };
}

async function loadState(filePath: string): Promise<PersistedState> {
  const empty: PersistedState = { disabled: [], customBrains: [] };
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(filePath, 'utf8'));
    if (!isRecord(parsed)) return empty;
    return {
      disabled: Array.isArray(parsed.disabled)
        ? parsed.disabled.filter((item): item is string => typeof item === 'string')
        : [],
      customBrains: Array.isArray(parsed.customBrains)
        ? parsed.customBrains.filter(isBrainLike)
        : [],
    };
  } catch {
    // 首次启动或文件损坏：空状态，不阻塞服务。
    return empty;
  }
}

function makeComponent(
  id: string,
  label: string,
  kind: PluginComponent['kind'],
  disabled: Set<string>,
  lockReason?: string,
): PluginComponent {
  const component: PluginComponent = {
    id,
    label,
    kind,
    // 锁定组件永远启用，不受持久化里的 disabled 影响。
    enabled: lockReason ? true : !disabled.has(id),
  };
  if (lockReason) {
    component.locked = true;
    component.lockReason = lockReason;
  }
  return component;
}

function builtinPlugins(disabled: Set<string>, options: PluginManagerOptions): PluginSummary[] {
  const toolComponents = options.toolNames
    .filter((name) => !COLLAB_TOOLS.has(name))
    .map((name) => makeComponent(`tool.${name}`, TOOL_LABELS[name] ?? name, 'tool', disabled));

  const brainComponents = options.brainIds.map((id) =>
    makeComponent(`brain.${id}`, getBrain(id)?.name ?? id, 'brain', disabled),
  );

  const collabComponents = [
    makeComponent('tool.consult_partner', '咨询伙伴', 'tool', disabled),
    makeComponent('tool.spawn_subagent', '派发子智能体', 'tool', disabled),
  ];

  const memoryComponents = [
    makeComponent('feature.projectMemory', '项目记忆注入', 'feature', disabled),
  ];
  const contextComponents = [makeComponent('feature.context', '上下文内核', 'feature', disabled)];
  const echoComponents = [
    makeComponent('feature.echo', '回声兜底', 'feature', disabled, ECHO_LOCK_REASON),
  ];

  const build = (
    id: string,
    name: string,
    description: string,
    components: PluginComponent[],
  ): PluginSummary => ({
    id,
    name,
    version: '1.0.0',
    description,
    kind: 'builtin',
    builtin: true,
    enabled: components.some((component) => component.enabled),
    source: 'WitCode 内置',
    components,
    removable: false,
  });

  return [
    build('witcode.tools', '工具集', '文件与命令相关的内置工具', toolComponents),
    build('witcode.brains', '脑子库', '可切换的内置 Brain', brainComponents),
    build('witcode.collab', '伙伴与子智能体', '协作与子任务派发工具', collabComponents),
    build('witcode.memory', '项目记忆', '把项目记忆注入 system prompt', memoryComponents),
    build('witcode.context', '上下文内核', '会话上下文与压缩能力', contextComponents),
    build('witcode.echo', '回声兜底', '无可用模型时的回声兜底', echoComponents),
  ];
}

function customPlugin(disabled: Set<string>, brain: BrainDefinition): PluginSummary {
  const components = [
    makeComponent(`brain.${brain.id}`, brain.name, 'brain', disabled),
  ];
  return {
    id: `custom.${brain.id}`,
    name: brain.name,
    version: '1.0.0',
    description: brain.description,
    kind: 'brain',
    builtin: false,
    enabled: components.some((component) => component.enabled),
    source: '本地安装',
    components,
    removable: true,
  };
}

export async function createPluginManager(
  options: PluginManagerOptions,
): Promise<PluginManager> {
  const filePath = path.join(resolveDataDir(options), 'plugins.json');
  const state = await loadState(filePath);

  const disabled = new Set(state.disabled);
  const customBrains = new Map<string, BrainDefinition>();

  for (const brain of state.customBrains) {
    // 同一进程内重建 manager 时 Brain 已注册，跳过重复注册但仍纳入管理。
    if (getBrain(brain.id)) {
      customBrains.set(brain.id, brain);
      continue;
    }
    try {
      registerBrain(brain);
      customBrains.set(brain.id, brain);
    } catch {
      // id 与内置冲突或数据损坏：跳过，不阻塞启动。
    }
  }

  const list = (): PluginSummary[] => [
    ...builtinPlugins(disabled, options),
    ...[...customBrains.values()].map((brain) => customPlugin(disabled, brain)),
  ];

  const persist = async (): Promise<void> => {
    const payload: PersistedState = {
      disabled: [...disabled],
      customBrains: [...customBrains.values()],
    };
    await writeFileAtomic(filePath, `${JSON.stringify(payload, null, 2)}\n`);
  };

  const setComponentState = (componentId: string, enabled: boolean): void => {
    if (enabled) disabled.delete(componentId);
    else disabled.add(componentId);
  };

  return {
    list,

    async setPluginEnabled(id, enabled) {
      const plugin = list().find((item) => item.id === id);
      if (!plugin) throw new Error(`未知的插件：${id}`);
      for (const component of plugin.components) {
        if (component.locked) continue;
        setComponentState(component.id, enabled);
      }
      await persist();
      return list();
    },

    async setComponentEnabled(pluginId, componentId, enabled) {
      const plugin = list().find((item) => item.id === pluginId);
      if (!plugin) throw new Error(`未知的插件：${pluginId}`);
      const component = plugin.components.find((item) => item.id === componentId);
      if (!component) throw new Error(`未知的组件：${componentId}`);
      if (component.locked && !enabled) {
        throw new Error(`组件 ${componentId} 已锁定，不可停用`);
      }
      setComponentState(componentId, enabled);
      await persist();
      return list();
    },

    async installBrain(manifest) {
      const brain = parseManifest(manifest);
      if (options.brainIds.includes(brain.id) || getBrain(brain.id) || customBrains.has(brain.id)) {
        throw new Error(`Brain id 已存在：${brain.id}`);
      }
      const unregister = registerBrain(brain);
      customBrains.set(brain.id, brain);
      try {
        await persist();
      } catch (error) {
        unregister();
        customBrains.delete(brain.id);
        throw error;
      }
      return list();
    },

    async uninstall(id) {
      if (!id.startsWith('custom.')) throw new Error(`内置插件不可卸载：${id}`);
      const brainId = id.slice('custom.'.length);
      if (!customBrains.has(brainId)) throw new Error(`未知的插件：${id}`);
      unregisterBrain(brainId);
      customBrains.delete(brainId);
      disabled.delete(`brain.${brainId}`);
      await persist();
      return list();
    },

    isToolEnabled(name) {
      return !disabled.has(`tool.${name}`);
    },

    isBrainEnabled(id) {
      return !disabled.has(`brain.${id}`);
    },

    isFeatureEnabled(id) {
      if (id === 'echo') return true;
      return !disabled.has(`feature.${id}`);
    },
  };
}
