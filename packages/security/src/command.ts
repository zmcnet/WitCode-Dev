/**
 * 命令层：硬黑名单 + 未知命令 fail-closed + 子进程环境白名单。
 *
 * 判定只基于命令文本，不执行任何东西；硬黑名单由权限层复用。
 */

import type { RiskLevel } from '@witcode/protocol';
import type { CommandCheck, CommandGuard } from './types.ts';

export interface CommandGuardOptions {
  /** 额外的环境变量白名单键（大小写不敏感）。 */
  allowedEnvKeys?: string[];
  /** 额外的已知命令名（fail-closed 判定用）。 */
  allowedCommands?: string[];
}

/** 子进程默认空环境，只放行这些键（大小写不敏感，输出使用此处的规范名）。 */
export const ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'SystemRoot',
  'APPDATA',
  'LOCALAPPDATA',
  'ComSpec',
  'PATHEXT',
] as const;

const MAX_COMMAND_LENGTH = 10_000;
const SEPARATORS = new Set(['|', '||', '&', '&&', ';', '>', '>>', '<']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const PIPE_TARGETS = new Set([...SHELLS, 'cmd', 'powershell', 'pwsh']);

/** 已知命令清单；不在此清单中的命令按“无法判定”处理（fail-closed）。 */
const KNOWN_COMMANDS = new Set([
  ...SHELLS,
  'cmd',
  'powershell',
  'pwsh',
  'ls',
  'dir',
  'pwd',
  'cd',
  'echo',
  'printf',
  'cat',
  'type',
  'head',
  'tail',
  'wc',
  'sort',
  'uniq',
  'cut',
  'grep',
  'rg',
  'find',
  'sed',
  'awk',
  'diff',
  'cmp',
  'stat',
  'file',
  'where',
  'which',
  'command',
  'true',
  'false',
  'test',
  'sleep',
  'date',
  'env',
  'printenv',
  'whoami',
  'hostname',
  'uname',
  'mkdir',
  'rmdir',
  'touch',
  'cp',
  'mv',
  'ln',
  'rm',
  'chmod',
  'tar',
  'zip',
  'unzip',
  'gzip',
  'git',
  'node',
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'bun',
  'deno',
  'python',
  'python3',
  'pip',
  'pip3',
  'java',
  'javac',
  'mvn',
  'gradle',
  'go',
  'cargo',
  'rustc',
  'dotnet',
  'php',
  'ruby',
  'perl',
  'tsc',
  'vite',
  'esbuild',
  'jest',
  'vitest',
  'playwright',
  'curl',
  'wget',
]);

function failClosed(reason: string): CommandCheck {
  return { ok: false, risk: 'high', reason: `无法判定，按危险处理：${reason}` };
}

function blacklist(name: string): CommandCheck {
  return { ok: false, risk: 'high', reason: `命中硬黑名单：${name}` };
}

/** 轻量分词：认识引号/管道/重定向；不认识命令替换、反引号、超长命令。 */
function tokenize(command: string): string[] | null {
  if (command.length > MAX_COMMAND_LENGTH) return null;
  const tokens: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command.charAt(i);
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
        started = true;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === '`' || (ch === '$' && /[({]/.test(command.charAt(i + 1) ?? ''))) return null;
    if (/[\r\n]/.test(ch)) return null;
    if (/\s/.test(ch)) {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    if ('|&;><'.includes(ch)) {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      const next = command.charAt(i + 1);
      const pair = ch + next;
      if (SEPARATORS.has(pair)) {
        tokens.push(pair);
        i += 1;
      } else {
        tokens.push(ch);
      }
      continue;
    }
    current += ch;
    started = true;
  }
  if (quote !== null) return null;
  if (started) tokens.push(current);
  return tokens;
}

function basename(token: string): string {
  const trimmed = token.replace(/\.(exe|cmd|bat)$/i, '');
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] ?? trimmed;
}

function segments(tokens: string[]): string[][] {
  const result: string[][] = [];
  let current: string[] = [];
  for (const token of tokens) {
    if (SEPARATORS.has(token)) {
      if (current.length > 0) result.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length > 0) result.push(current);
  return result;
}

interface Effective {
  name: string;
  args: string[];
}

function effective(segment: string[]): Effective {
  let index = 0;
  const firstName = basename(segment[0] ?? '');
  if (firstName === 'sudo') {
    index = 1;
    while (index < segment.length && segment[index]?.startsWith('-')) index += 1;
  }
  return { name: basename(segment[index] ?? ''), args: segment.slice(index + 1) };
}

/** cmd /c 与 sh -c 的内容需要递归检查，不能只看外壳。 */
function nestedCommand(eff: Effective): string[] | undefined {
  if (eff.name === 'cmd') {
    const index = eff.args.findIndex((arg) => /^\/c$/i.test(arg));
    if (index >= 0) return eff.args.slice(index + 1);
  }
  if (SHELLS.has(eff.name)) {
    const index = eff.args.findIndex((arg) => arg === '-c');
    if (index >= 0) return eff.args.slice(index + 1);
  }
  return undefined;
}

function isBlacklistedCommand(eff: Effective): boolean {
  const { name, args } = eff;
  if (name === 'format' || name === 'diskpart' || name === 'shutdown' || name === 'reboot') {
    return true;
  }
  if (name === 'mkfs' || name.startsWith('mkfs.')) return true;
  if (name === 'dd' && args.some((arg) => /^of\s*=\s*\/dev\//i.test(arg))) return true;
  if (name === 'powershell' || name === 'pwsh') {
    if (args.some((arg) => /^-enc/i.test(arg))) return true;
  }
  if (name === 'rm') {
    const flags = args.filter((arg) => arg.startsWith('-')).map((arg) => arg.toLowerCase());
    const hasR = flags.some((flag) => flag.includes('r'));
    const hasF = flags.some((flag) => flag.includes('f'));
    const rootTarget = args.some((arg) => /^\/\*?$/.test(arg));
    if (hasR && hasF && rootTarget) return true;
  }
  return false;
}

function pipesIntoShell(tokens: string[]): boolean {
  for (let i = 0; i < tokens.length; i += 1) {
    const name = basename(tokens[i] ?? '');
    if (name !== 'curl' && name !== 'wget') continue;
    let next = i + 1;
    while (next < tokens.length && !SEPARATORS.has(tokens[next] ?? '')) next += 1;
    if (tokens[next] === '|' && PIPE_TARGETS.has(basename(tokens[next + 1] ?? ''))) return true;
  }
  return false;
}

function analyze(tokens: string[], known: Set<string>, depth: number): CommandCheck {
  if (tokens.length === 0) return failClosed('空命令');
  if (pipesIntoShell(tokens)) return blacklist('curl/wget 管道到 shell');

  for (const segment of segments(tokens)) {
    const eff = effective(segment);
    if (eff.name === '') return failClosed('命令名缺失');

    const nested = nestedCommand(eff);
    if (nested !== undefined) {
      if (depth >= 3) return failClosed('命令嵌套过深');
      const result = analyze(nested, known, depth + 1);
      if (!result.ok) return result;
      continue;
    }
    if (isBlacklistedCommand(eff)) return blacklist(eff.name);
    if (!known.has(eff.name)) return failClosed(`未知命令 ${eff.name}`);
  }
  return { ok: true, risk: 'low' };
}

export function createCommandGuard(options: CommandGuardOptions = {}): CommandGuard {
  const known = new Set([...KNOWN_COMMANDS, ...(options.allowedCommands ?? []).map((name) => name.toLowerCase())]);
  const extraEnv = new Set((options.allowedEnvKeys ?? []).map((key) => key.toLowerCase()));
  const allowedEnv = new Map(ENV_ALLOWLIST.map((key) => [key.toLowerCase(), key]));

  return {
    check(command: string): CommandCheck {
      if (typeof command !== 'string' || command.trim() === '') return failClosed('空命令');
      const tokens = tokenize(command);
      if (tokens === null) return failClosed('命令无法安全解析（引号不匹配、命令替换或超长）');
      return analyze(tokens, known, 0);
    },

    env(overrides: Record<string, string> = {}): Record<string, string> {
      const result: Record<string, string> = {};
      // 从空对象起步，只把白名单键从进程环境复制进来。
      for (const [key, value] of Object.entries(process.env)) {
        const canonical = allowedEnv.get(key.toLowerCase());
        if (canonical !== undefined && value !== undefined) result[canonical] = value;
      }
      for (const [key, value] of Object.entries(overrides)) {
        const canonical = allowedEnv.get(key.toLowerCase());
        const extraAllowed = extraEnv.has(key.toLowerCase());
        if (canonical !== undefined) {
          result[canonical] = value;
        } else if (extraAllowed) {
          result[key] = value;
        }
      }
      return result;
    },
  };
}
