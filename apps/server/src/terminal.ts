import { spawn as spawnChild, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { IDisposable, IPty } from 'node-pty';

export interface TerminalOptions {
  cwd: string;
  cols: number;
  rows: number;
  shell?: string;
  env?: Record<string, string>;
}

export interface TerminalSession {
  readonly id: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (data: string) => void): () => void;
  onExit(cb: (code: number) => void): () => void;
}

const MIN_DIMENSION = 1;
const MAX_DIMENSION = 1000;
const TERMINAL_NAME = 'xterm-256color';

const PTY_INSTALL_HINT =
  '[terminal] node-pty 不可用，无法创建真实 PTY。请在仓库根目录执行 ' +
  '"pnpm --filter @witcode/server add node-pty"；若原生模块被 pnpm 拦截，执行 ' +
  '"pnpm approve-builds" 或 "pnpm rebuild node-pty"。' +
  '如确需管道终端，可显式设置环境变量 WITCODE_TERMINAL=pipe 或调用 createPipeTerminal。';

/**
 * 这些变量不允许被调用方传入的 env 覆盖（大小写不敏感）。
 * PATH / HOME 等保留进程原有值，其余传入项只做“追加”而不覆盖已有键。
 */
const PROTECTED_ENV_KEYS = new Set([
  'path',
  'home',
  'userprofile',
  'comspec',
  'systemroot',
  'systemdrive',
  'windir',
  'temp',
  'tmp',
  'tmpdir',
  'appdata',
  'localappdata',
  'programdata',
  'programfiles',
  'programfiles(x86)',
  'commonprogramfiles',
  'commonprogramfiles(x86)',
  'username',
  'userdomain',
  'dnsdomain',
  'shell',
  'term',
  'colorterm',
]);

const requireModule = createRequire(import.meta.url);
let cachedPty: typeof import('node-pty') | undefined;

interface NormalizedOptions extends Required<Pick<TerminalOptions, 'cwd' | 'cols' | 'rows'>> {
  shell?: string;
  env?: Record<string, string>;
}

interface SessionImpl {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

interface SessionCore {
  session: TerminalSession;
  emitData(data: string): void;
  emitExit(code: number): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clampDimension(value: number, name: 'cols' | 'rows'): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`[terminal] ${name} 必须是有限数字`);
  }
  return Math.min(MAX_DIMENSION, Math.max(MIN_DIMENSION, Math.floor(value)));
}

function normalizeOptions(options: TerminalOptions): NormalizedOptions {
  if (!options || typeof options !== 'object') {
    throw new TypeError('[terminal] options 必须是对象');
  }
  const cwd = options.cwd;
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    throw new TypeError('[terminal] cwd 必须是非空字符串');
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(cwd);
  } catch (error) {
    throw new Error(`[terminal] cwd 不存在或不可访问: ${cwd}`, { cause: error });
  }
  if (!stat.isDirectory()) {
    throw new Error(`[terminal] cwd 不是目录: ${cwd}`);
  }
  const cols = clampDimension(options.cols, 'cols');
  const rows = clampDimension(options.rows, 'rows');
  if (options.shell !== undefined && (typeof options.shell !== 'string' || options.shell.trim() === '')) {
    throw new TypeError('[terminal] shell 必须是非空字符串');
  }
  if (
    options.env !== undefined &&
    (typeof options.env !== 'object' || options.env === null || Array.isArray(options.env))
  ) {
    throw new TypeError('[terminal] env 必须是对象');
  }
  return { cwd, cols, rows, shell: options.shell, env: options.env };
}

function findExecutable(name: string): string | undefined {
  const isWindows = process.platform === 'win32';
  const extensions = isWindows
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .map((ext) => ext.trim().toLowerCase())
        .filter(Boolean)
    : [''];
  const hasExtension = isWindows
    ? extensions.some((ext) => name.toLowerCase().endsWith(ext))
    : false;
  const candidates = hasExtension ? [name] : extensions.map((ext) => `${name}${ext}`);

  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const candidate of candidates) {
      const full = path.join(dir, candidate);
      try {
        if (!fs.statSync(full).isFile()) continue;
        if (!isWindows) fs.accessSync(full, fs.constants.X_OK);
        return full;
      } catch {
        /* 继续查找 */
      }
    }
  }
  return undefined;
}

/** 解析默认 shell：Windows 优先 pwsh → powershell.exe → cmd.exe；Unix 优先 $SHELL → bash。 */
export function defaultShell(): string {
  if (process.platform === 'win32') {
    for (const name of ['pwsh', 'powershell.exe', 'cmd.exe']) {
      const found = findExecutable(name);
      if (found) return found;
    }
    return process.env.ComSpec || 'cmd.exe';
  }
  return process.env.SHELL?.trim() ? process.env.SHELL : 'bash';
}

function resolveLaunch(shell?: string): { shell: string; args: string[] } {
  const resolved = shell?.trim() ? shell.trim() : defaultShell();
  const base = path.basename(resolved).toLowerCase();
  const args = /^(pwsh|powershell)(\.exe)?$/.test(base) ? ['-NoLogo', '-NoProfile'] : [];
  return { shell: resolved, args };
}

function buildEnv(userEnv?: Record<string, string>): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) merged[key] = value;
  }
  const lowered = new Set(Object.keys(merged).map((key) => key.toLowerCase()));
  if (userEnv) {
    for (const [key, value] of Object.entries(userEnv)) {
      if (typeof value !== 'string') continue;
      const lower = key.toLowerCase();
      if (PROTECTED_ENV_KEYS.has(lower) || lowered.has(lower)) continue;
      merged[key] = value;
      lowered.add(lower);
    }
  }
  merged.TERM = TERMINAL_NAME;
  merged.COLORTERM = 'truecolor';
  return merged;
}

function createSessionCore(id: string, impl: SessionImpl): SessionCore {
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(code: number) => void>();
  let exited = false;
  let exitCode = -1;
  let killed = false;
  let fallback: ReturnType<typeof setTimeout> | undefined;

  const emitExit = (code: number): void => {
    if (exited) return;
    exited = true;
    exitCode = Number.isFinite(code) ? code : -1;
    if (fallback) clearTimeout(fallback);
    for (const cb of [...exitListeners]) {
      try {
        cb(exitCode);
      } catch {
        /* 监听器异常不应影响会话 */
      }
    }
  };

  const session: TerminalSession = {
    id,
    write(data: string): void {
      if (exited || killed || typeof data !== 'string') return;
      impl.write(data);
    },
    resize(cols: number, rows: number): void {
      if (exited || killed) return;
      impl.resize(clampDimension(cols, 'cols'), clampDimension(rows, 'rows'));
    },
    kill(): void {
      if (killed || exited) return;
      killed = true;
      try {
        impl.kill();
      } catch {
        /* kill 失败也保证 exit 通知 */
      }
      fallback = setTimeout(() => emitExit(-1), 3000);
      fallback.unref?.();
    },
    onData(cb: (data: string) => void): () => void {
      if (typeof cb !== 'function') return () => {};
      dataListeners.add(cb);
      return () => {
        dataListeners.delete(cb);
      };
    },
    onExit(cb: (code: number) => void): () => void {
      if (typeof cb !== 'function') return () => {};
      if (exited) {
        cb(exitCode);
        return () => {};
      }
      exitListeners.add(cb);
      return () => {
        exitListeners.delete(cb);
      };
    },
  };

  return {
    session,
    emitData(data: string): void {
      for (const cb of [...dataListeners]) {
        try {
          cb(data);
        } catch {
          /* 监听器异常不应影响会话 */
        }
      }
    },
    emitExit,
  };
}

function loadPty(): typeof import('node-pty') {
  if (cachedPty) return cachedPty;
  try {
    const mod = requireModule('node-pty') as typeof import('node-pty');
    if (typeof mod.spawn !== 'function') {
      throw new TypeError('node-pty.spawn 不是函数');
    }
    cachedPty = mod;
    return mod;
  } catch (error) {
    throw new Error(`${PTY_INSTALL_HINT} 原始错误: ${errorMessage(error)}`, { cause: error });
  }
}

function createPtySession(options: NormalizedOptions): TerminalSession {
  const pty = loadPty();
  const launch = resolveLaunch(options.shell);
  let child: IPty;
  try {
    child = pty.spawn(launch.shell, launch.args, {
      name: TERMINAL_NAME,
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd,
      env: buildEnv(options.env),
    });
  } catch (error) {
    throw new Error(`[terminal] 启动 PTY 失败 (${launch.shell}): ${errorMessage(error)}`, {
      cause: error,
    });
  }

  const core = createSessionCore(`pty-${randomUUID()}`, {
    write: (data) => child.write(data),
    resize: (cols, rows) => child.resize(cols, rows),
    kill: () => child.kill(),
  });

  let dataSub: IDisposable | undefined;
  let exitSub: IDisposable | undefined;
  dataSub = child.onData((data) => core.emitData(data));
  exitSub = child.onExit((event) => {
    dataSub?.dispose();
    exitSub?.dispose();
    core.emitExit(event.exitCode ?? -1);
  });
  return core.session;
}

function killProcessTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (!pid) {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    return;
  }
  if (process.platform === 'win32') {
    const killer = spawnChild('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.on('error', () => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
}

function createPipeSession(options: NormalizedOptions): TerminalSession {
  const launch = resolveLaunch(options.shell);
  const child = spawnChild(launch.shell, launch.args, {
    cwd: options.cwd,
    env: buildEnv(options.env),
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });

  const core = createSessionCore(`pipe-${randomUUID()}`, {
    write: (data) => {
      child.stdin?.write(data);
    },
    // 管道没有窗口尺寸，resize 为合法空操作。
    resize: () => {},
    kill: () => killProcessTree(child),
  });

  child.stdout?.on('data', (chunk: Buffer) => core.emitData(chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => core.emitData(chunk.toString('utf8')));
  child.on('exit', (code) => core.emitExit(code ?? -1));
  child.on('error', (error) => {
    core.emitData(`[terminal] ${errorMessage(error)}\r\n`);
    core.emitExit(-1);
  });
  return core.session;
}

/** 管道备选实现：不依赖 node-pty，stdout/stderr 合并为 onData。 */
export function createPipeTerminal(options: TerminalOptions): TerminalSession {
  return createPipeSession(normalizeOptions(options));
}

/**
 * 默认创建真实 PTY。node-pty 缺失或加载失败时抛出明确错误（不静默降级）；
 * 显式设置 WITCODE_TERMINAL=pipe 时使用 createPipeTerminal。
 */
export function createTerminal(options: TerminalOptions): TerminalSession {
  const normalized = normalizeOptions(options);
  if ((process.env.WITCODE_TERMINAL ?? '').toLowerCase() === 'pipe') {
    return createPipeSession(normalized);
  }
  return createPtySession(normalized);
}
