/**
 * 代码插件运行时（完整插件体系的后端核心）。
 *
 * 警告：代码插件以服务端权限运行，本版本不做沙箱。
 * manifest.permissions 仅供界面展示，不提供任何隔离能力；只安装可信来源的插件。
 */

import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PluginSummary, ToolDefinition } from '@witcode/protocol';

/** 代码插件清单。注意：插件代码以服务端权限运行，本版本不做沙箱。 */
export interface PluginManifest {
  /** 只允许 [a-z0-9._-]，且不能是 '.' / '..'（会逃逸安装目录）。 */
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  /** 相对插件目录的入口文件，缺省为 main.mjs；必须位于插件目录内。 */
  main: string;
  /** 仅展示，不参与任何沙箱或权限隔离。 */
  permissions?: string[];
  settings?: Array<{
    key: string;
    label: string;
    type: 'string' | 'number' | 'boolean';
    default?: unknown;
    description?: string;
  }>;
  /** 贡献给右栏的面板；entry 相对插件目录。 */
  panel?: { title: string; entry: string };
}

/** 解析插件内静态资源路径；越界返回 null。 */
export function pluginAssetPath(id: string, rel: string, dataDir?: string): string | null {
  const base = dataDir ?? process.env.WITCODE_DATA_DIR ?? path.join(os.homedir(), '.witcode');
  const root = path.resolve(base, 'plugins', id);
  const target = path.resolve(root, rel);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) return null;
  return target;
}

export interface PluginRuntimeOptions {
  /** 数据目录；默认 WITCODE_DATA_DIR 或 ~/.witcode */
  dataDir?: string;
  registerTool(tool: ToolDefinition): () => void;
  workspace?: string;
  logger?: (line: string) => void;
}

/** 传给插件 apply(api) 的接口；插件代码以服务端权限运行。 */
export interface PluginApi {
  registerTool(tool: ToolDefinition): () => void;
  getConfig(): Record<string, unknown>;
  setConfig(patch: Record<string, unknown>): Promise<void>;
  log(...args: unknown[]): void;
  readonly workspace: string;
  onDispose(fn: () => void | Promise<void>): void;
}

export interface PluginRuntime {
  list(): PluginSummary[];
  installLocal(sourcePath: string): Promise<PluginSummary[]>;
  setEnabled(id: string, enabled: boolean): Promise<PluginSummary[]>;
  uninstall(id: string): Promise<PluginSummary[]>;
  loadAll(): Promise<void>;
  getConfig(id: string): Record<string, unknown>;
  setConfig(id: string, patch: Record<string, unknown>): Promise<PluginSummary[]>;
}

type Dispose = () => void | Promise<void>;

interface PluginRecord {
  manifest: PluginManifest;
  pluginDir: string;
  mainPath: string;
  config: Record<string, unknown>;
  disposers: Dispose[];
  status: 'running' | 'stopped' | 'error';
  error?: string;
}

/** 与内置能力管理器的 id 冲突时拒绝安装（见 plugins.ts）。 */
const BUILTIN_IDS = new Set([
  'witcode.tools',
  'witcode.brains',
  'witcode.collab',
  'witcode.memory',
  'witcode.context',
  'witcode.echo',
]);

const ID_RE = /^[a-z0-9._-]+$/;
const SANDBOX_WARNING =
  '[plugin-runtime] 警告：代码插件以服务端权限运行，本版本不做沙箱；请只安装可信来源的插件。';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatArg(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} 必须是非空字符串`);
  }
  return value.trim();
}

/** 判断 child 是否严格位于 parent 内（排除相等与大小写盘符差异由调用方 resolve 处理）。 */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return (
    rel !== '' &&
    rel !== '..' &&
    !rel.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(rel)
  );
}

function isInsideOrEqual(parent: string, child: string): boolean {
  return parent === child || isInside(parent, child);
}

function validateRelativeMain(main: string): void {
  if (
    path.isAbsolute(main) ||
    path.win32.isAbsolute(main) ||
    /^[a-zA-Z]:/.test(main)
  ) {
    throw new Error('main 必须是相对插件目录的路径');
  }
  const segments = main.replace(/\\/g, '/').split('/');
  if (segments.includes('..')) throw new Error('main 不允许包含 .. 路径段');
}

function resolveMain(pluginDir: string, main: string): string {
  validateRelativeMain(main);
  const mainPath = path.resolve(pluginDir, main);
  if (!isInside(pluginDir, mainPath)) throw new Error('main 必须位于插件目录内');
  return mainPath;
}

function parseManifest(raw: unknown): PluginManifest {
  if (!isRecord(raw)) throw new Error('插件清单必须是 JSON 对象');

  const id = requireText(raw.id, 'id');
  if (!ID_RE.test(id) || id === '.' || id === '..') {
    throw new Error(`插件 id 非法：${id}（只允许 [a-z0-9._-]）`);
  }
  const name = requireText(raw.name, 'name');
  const version = requireText(raw.version, 'version');
  const description = requireText(raw.description, 'description');
  const main = raw.main === undefined ? 'main.mjs' : requireText(raw.main, 'main');
  validateRelativeMain(main);

  const author = raw.author === undefined ? undefined : requireText(raw.author, 'author');

  let permissions: string[] | undefined;
  if (raw.permissions !== undefined) {
    if (!Array.isArray(raw.permissions) || raw.permissions.some((item) => typeof item !== 'string')) {
      throw new Error('permissions 必须是字符串数组');
    }
    permissions = [...raw.permissions] as string[];
  }

  let settings: PluginManifest['settings'];
  if (raw.settings !== undefined) {
    if (!Array.isArray(raw.settings)) throw new Error('settings 必须是数组');
    settings = raw.settings.map((entry, index) => {
      if (!isRecord(entry)) throw new Error(`settings[${index}] 必须是对象`);
      const key = requireText(entry.key, `settings[${index}].key`);
      const label = requireText(entry.label, `settings[${index}].label`);
      const type = entry.type;
      if (type !== 'string' && type !== 'number' && type !== 'boolean') {
        throw new Error(`settings[${index}].type 必须是 string / number / boolean`);
      }
      const item: NonNullable<PluginManifest['settings']>[number] = { key, label, type };
      if (entry.default !== undefined) item.default = entry.default;
      if (entry.description !== undefined) {
        if (typeof entry.description !== 'string') {
          throw new Error(`settings[${index}].description 必须是字符串`);
        }
        item.description = entry.description;
      }
      return item;
    });
  }

  let panel: PluginManifest['panel'];
  if (raw.panel !== undefined) {
    if (!isRecord(raw.panel)) throw new Error('panel 必须是对象');
    const title = requireText(raw.panel.title, 'panel.title');
    const entry = requireText(raw.panel.entry, 'panel.entry');
    validateRelativeMain(entry);
    panel = { title, entry };
  }

  return {
    id,
    name,
    version,
    description,
    main,
    ...(author ? { author } : {}),
    ...(permissions ? { permissions } : {}),
    ...(settings ? { settings } : {}),
    ...(panel ? { panel } : {}),
  };
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, filePath);
}

export function createPluginRuntime(options: PluginRuntimeOptions): PluginRuntime {
  const dataDir =
    options.dataDir ?? process.env.WITCODE_DATA_DIR ?? path.join(os.homedir(), '.witcode');
  const pluginsRoot = path.join(dataDir, 'plugins');
  const installedFile = path.join(pluginsRoot, 'installed.json');
  const workspace = options.workspace ?? process.cwd();

  const log = (...args: unknown[]): void => {
    const line = args.map(formatArg).join(' ');
    (options.logger ?? console.log)(line);
  };

  const disabled = new Set<string>();
  const plugins = new Map<string, PluginRecord>();
  let stateLoaded = false;
  let lastImportVersion = 0;

  function loadStateSync(): void {
    if (stateLoaded) return;
    stateLoaded = true;
    try {
      const parsed: unknown = JSON.parse(fsSync.readFileSync(installedFile, 'utf8'));
      if (isRecord(parsed) && Array.isArray(parsed.disabled)) {
        for (const item of parsed.disabled) {
          if (typeof item === 'string') disabled.add(item);
        }
      }
    } catch {
      // 首次启动或文件损坏：视为空状态，不阻塞服务。
    }
  }

  async function persist(): Promise<void> {
    await atomicWrite(installedFile, `${JSON.stringify({ disabled: [...disabled] }, null, 2)}\n`);
  }

  function readConfigSync(pluginDir: string, manifest: PluginManifest): Record<string, unknown> {
    const defaults: Record<string, unknown> = {};
    for (const setting of manifest.settings ?? []) {
      if (setting.default !== undefined) defaults[setting.key] = setting.default;
    }
    try {
      const parsed: unknown = JSON.parse(
        fsSync.readFileSync(path.join(pluginDir, 'config.json'), 'utf8'),
      );
      if (isRecord(parsed)) return { ...defaults, ...parsed };
    } catch {
      // 缺失或损坏：回退到清单默认值。
    }
    return defaults;
  }

  async function writeConfig(
    pluginDir: string,
    config: Record<string, unknown>,
  ): Promise<void> {
    await atomicWrite(
      path.join(pluginDir, 'config.json'),
      `${JSON.stringify(config, null, 2)}\n`,
    );
  }

  /** 同步发现已安装的插件（list/getConfig 为同步接口）。只补充未知插件，不覆盖运行状态。 */
  function discover(): void {
    loadStateSync();
    let entries: fsSync.Dirent[];
    try {
      entries = fsSync.readdirSync(pluginsRoot, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'node_modules') continue;
      if (plugins.has(entry.name)) continue;
      const pluginDir = path.resolve(pluginsRoot, entry.name);
      const manifestFile = path.join(pluginDir, 'manifest.json');
      if (!fsSync.existsSync(manifestFile)) continue;

      let raw: unknown;
      try {
        raw = JSON.parse(fsSync.readFileSync(manifestFile, 'utf8'));
      } catch (error) {
        log(`[plugin-runtime] 跳过 ${entry.name}：清单无法解析（${errorMessage(error)}）`);
        continue;
      }
      let manifest: PluginManifest;
      try {
        manifest = parseManifest(raw);
      } catch (error) {
        log(`[plugin-runtime] 跳过 ${entry.name}：清单非法（${errorMessage(error)}）`);
        continue;
      }
      if (manifest.id !== entry.name) {
        log(`[plugin-runtime] 跳过 ${entry.name}：目录名与插件 id（${manifest.id}）不一致`);
        continue;
      }
      let mainPath: string;
      try {
        mainPath = resolveMain(pluginDir, manifest.main);
      } catch (error) {
        log(`[plugin-runtime] 跳过 ${entry.name}：main 非法（${errorMessage(error)}）`);
        continue;
      }
      plugins.set(manifest.id, {
        manifest,
        pluginDir,
        mainPath,
        config: readConfigSync(pluginDir, manifest),
        disposers: [],
        status: 'stopped',
      });
    }
  }

  async function runDisposers(record: PluginRecord): Promise<void> {
    const pending = record.disposers.splice(0, record.disposers.length).reverse();
    for (const dispose of pending) {
      try {
        await dispose();
      } catch (error) {
        log(`[plugin:${record.manifest.id}] 清理失败：${errorMessage(error)}`);
      }
    }
  }

  function makeApi(record: PluginRecord): PluginApi {
    const prefix = `[plugin:${record.manifest.id}]`;
    return {
      registerTool(tool) {
        const unregister = options.registerTool(tool);
        let active = true;
        const dispose: Dispose = () => {
          if (!active) return;
          active = false;
          const index = record.disposers.indexOf(dispose);
          if (index >= 0) record.disposers.splice(index, 1);
          unregister();
        };
        record.disposers.push(dispose);
        return dispose;
      },
      getConfig() {
        return { ...record.config };
      },
      async setConfig(patch) {
        if (!isRecord(patch)) throw new Error('配置补丁必须是对象');
        const next = { ...record.config, ...patch };
        await writeConfig(record.pluginDir, next);
        record.config = next;
      },
      log(...args) {
        log(prefix, ...args);
      },
      workspace,
      onDispose(fn) {
        record.disposers.push(fn);
      },
    };
  }

  async function loadOne(record: PluginRecord): Promise<void> {
    try {
      log(SANDBOX_WARNING);
      // Date.now() 作为基础版本号，单调自增避免同一毫秒内反复启停命中模块缓存。
      lastImportVersion = Math.max(Date.now(), lastImportVersion + 1);
      const url = `${pathToFileURL(record.mainPath).href}?v=${lastImportVersion}`;
      const module: Record<string, unknown> = await import(url);
      const candidate =
        typeof module.apply === 'function'
          ? module.apply
          : isRecord(module.default) && typeof module.default.apply === 'function'
            ? module.default.apply
            : undefined;
      if (typeof candidate !== 'function') {
        throw new Error('插件模块必须导出 apply(api) 或 default.apply');
      }
      const apply = candidate as (api: PluginApi) => void | Promise<void>;
      await apply(makeApi(record));
      record.status = 'running';
      record.error = undefined;
    } catch (error) {
      record.status = 'error';
      record.error = errorMessage(error);
      await runDisposers(record);
      log(`[plugin:${record.manifest.id}] 加载失败：${record.error}`);
    }
  }

  async function stopOne(record: PluginRecord): Promise<void> {
    await runDisposers(record);
    record.status = 'stopped';
    record.error = undefined;
  }

  function summary(record: PluginRecord): PluginSummary {
    const item: PluginSummary = {
      id: record.manifest.id,
      name: record.manifest.name,
      version: record.manifest.version,
      description: record.manifest.description,
      kind: 'code',
      builtin: false,
      status: record.status,
      enabled: !disabled.has(record.manifest.id),
      source: '本地安装',
      components: [],
      removable: true,
      main: record.manifest.main,
      config: { ...record.config },
    };
    if (record.manifest.author) item.author = record.manifest.author;
    if (record.manifest.settings) item.settings = record.manifest.settings;
    if (record.manifest.panel) item.panel = record.manifest.panel;
    if (record.status === 'error' && record.error) item.error = record.error;
    return item;
  }

  function list(): PluginSummary[] {
    discover();
    return [...plugins.values()]
      .map(summary)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  return {
    list,

    async installLocal(sourcePath) {
      discover();
      const src = path.resolve(sourcePath);
      let raw: unknown;
      try {
        raw = JSON.parse(await fs.readFile(path.join(src, 'manifest.json'), 'utf8'));
      } catch (error) {
        throw new Error(`读取插件清单失败：${errorMessage(error)}`);
      }
      const manifest = parseManifest(raw);
      if (BUILTIN_IDS.has(manifest.id) || manifest.id.startsWith('custom.')) {
        throw new Error(`插件 id 与内置插件冲突：${manifest.id}`);
      }

      const dest = path.resolve(pluginsRoot, manifest.id);
      if (isInsideOrEqual(src, dest) || isInsideOrEqual(dest, src)) {
        throw new Error('源目录与目标目录重叠，拒绝安装（避免覆盖自身）');
      }
      const mainPath = resolveMain(dest, manifest.main);

      const existing = plugins.get(manifest.id);
      if (existing) {
        await stopOne(existing);
        plugins.delete(manifest.id);
      }
      await fs.rm(dest, { recursive: true, force: true });
      if (fsSync.existsSync(path.join(src, 'node_modules'))) {
        log(
          `[plugin-runtime] 警告：插件 ${manifest.id} 包含 node_modules，将原样复制；请审计其依赖。`,
        );
      }
      await fs.cp(src, dest, { recursive: true });

      let realDir: string;
      let realMain: string;
      try {
        realDir = await fs.realpath(dest);
        realMain = await fs.realpath(mainPath);
      } catch {
        await fs.rm(dest, { recursive: true, force: true });
        throw new Error(`插件入口文件缺失：${manifest.main}`);
      }
      if (!isInside(realDir, realMain)) {
        await fs.rm(dest, { recursive: true, force: true });
        throw new Error('插件入口 main 指向插件目录之外，拒绝安装');
      }

      const record: PluginRecord = {
        manifest,
        pluginDir: dest,
        mainPath,
        config: readConfigSync(dest, manifest),
        disposers: [],
        status: 'stopped',
      };
      plugins.set(manifest.id, record);
      if (!disabled.has(manifest.id)) await loadOne(record);
      await persist();
      return list();
    },

    async setEnabled(id, enabled) {
      discover();
      const record = plugins.get(id);
      if (!record) throw new Error(`未知的插件：${id}`);
      if (enabled) {
        disabled.delete(id);
        if (record.status !== 'running') await loadOne(record);
      } else {
        disabled.add(id);
        if (record.status !== 'stopped') await stopOne(record);
      }
      await persist();
      return list();
    },

    async uninstall(id) {
      discover();
      const record = plugins.get(id);
      if (!record) throw new Error(`未知的插件：${id}`);
      await stopOne(record);
      await fs.rm(record.pluginDir, { recursive: true, force: true });
      plugins.delete(id);
      disabled.delete(id);
      await persist();
      return list();
    },

    async loadAll() {
      discover();
      for (const record of [...plugins.values()]) {
        if (disabled.has(record.manifest.id)) {
          if (record.status !== 'stopped') await stopOne(record);
          continue;
        }
        if (record.status !== 'running') await loadOne(record);
      }
    },

    getConfig(id) {
      discover();
      const record = plugins.get(id);
      return record ? { ...record.config } : {};
    },

    async setConfig(id, patch) {
      discover();
      const record = plugins.get(id);
      if (!record) throw new Error(`未知的插件：${id}`);
      if (!isRecord(patch)) throw new Error('配置补丁必须是对象');
      const next = { ...record.config, ...patch };
      await writeConfig(record.pluginDir, next);
      record.config = next;
      return list();
    },
  };
}
