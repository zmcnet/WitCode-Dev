/**
 * 工作区文件浏览：单层目录树、文本读取、Git 状态与 diff。
 *
 * 所有路径都相对 workspace 解析；词法逃逸以及 realpath 后指向 workspace 之外的路径一律拒绝。
 * Git 命令用 spawn 传参数组执行，不经过 shell，避免命令注入。
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { FileContent, FileEntry, GitChange } from '@witcode/protocol';

export interface WorkspaceFilesOptions {
  workspace: string;
  /** 可选：读取前的安全校验（由上层注入 pathGuard）。 */
  checkRead?: (absPath: string) => Promise<{ ok: boolean; reason?: string }>;
  maxFileBytes?: number; // 默认 512_000
}

export interface WorkspaceFiles {
  tree(relPath?: string): Promise<FileEntry[]>; // 单层
  read(relPath: string): Promise<FileContent>;
  gitStatus(): Promise<{ branch: string; items: GitChange[] }>;
  gitDiff(relPath: string): Promise<string>;
}

const DEFAULT_MAX_FILE_BYTES = 512_000;
const BINARY_SNIFF_BYTES = 8 * 1024;
const DIFF_LIMIT = 200 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.vitest', 'coverage']);

/** 优先走 PATH；后面几项只是 Git 不在 PATH 时的兜底。 */
const GIT_COMMANDS = [
  'git',
  'C:\\Program Files\\Git\\bin\\git.exe',
  'C:\\Program Files\\Git\\cmd\\git.exe',
  'D:\\env\\sdk\\git\\bin\\git.exe',
  'D:\\env\\sdk\\git\\cmd\\git.exe',
];

interface ResolvedPath {
  /** realpath 之后的绝对路径。 */
  abs: string;
  /** 相对 workspace 的 POSIX 风格路径。 */
  rel: string;
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

function escapeError(relPath: string): Error {
  return new Error(`path escapes workspace: ${relPath}`);
}

function compareNames(a: FileEntry, b: FileEntry): number {
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return 0;
}

/** 还原 git 对路径的 C 风格引号转义（含 \nnn 八进制）。 */
function unquoteGitPath(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
  const body = value.slice(1, -1);
  const bytes: number[] = [];
  const simple: Record<string, string> = {
    a: '\x07',
    b: '\b',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
    v: '\v',
    '\\': '\\',
    '"': '"',
  };
  for (let i = 0; i < body.length; i += 1) {
    const ch = body.charAt(i);
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'));
      continue;
    }
    i += 1;
    const esc = body.charAt(i);
    if (esc === '') break;
    if (esc >= '0' && esc <= '7') {
      let octal = esc;
      while (i + 1 < body.length && octal.length < 3) {
        const next = body.charAt(i + 1);
        if (next < '0' || next > '7') break;
        i += 1;
        octal += next;
      }
      bytes.push(parseInt(octal, 8));
    } else {
      bytes.push(...Buffer.from(simple[esc] ?? esc, 'utf8'));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function parseBranch(raw: string): string {
  let value = raw.replace(/\s*\[[^\]]*\]\s*$/, '').trim();
  const dots = value.indexOf('...');
  if (dots !== -1) value = value.slice(0, dots);
  value = value.trim();
  if (value.startsWith('No commits yet on ')) {
    value = value.slice('No commits yet on '.length).trim();
  }
  if (value.startsWith('HEAD (no branch)')) value = 'HEAD';
  return value;
}

function parseStatus(output: string): { branch: string; items: GitChange[] } {
  let branch = '';
  const items: GitChange[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (line.length < 4) continue;
    if (line.startsWith('## ')) {
      branch = parseBranch(line.slice(3));
      continue;
    }
    const x = line.charAt(0);
    const y = line.charAt(1);
    let filePath = line.slice(3);
    const rename = filePath.indexOf(' -> ');
    if (rename !== -1) filePath = filePath.slice(rename + 4);
    filePath = unquoteGitPath(filePath);
    const staged = x !== ' ' && x !== '?';
    const status = x === '?' && y === '?' ? '??' : staged ? x : y;
    items.push({ path: filePath, status, staged });
  }
  return { branch, items };
}

/** 尝试多个 Git 入口；ENOENT 时切到下一个候选。 */
function runGit(args: string[]): Promise<GitResult> {
  const attempt = (index: number): Promise<GitResult> =>
    new Promise((resolve) => {
      const command = GIT_COMMANDS[index];
      if (!command) {
        resolve({ code: -1, stdout: '', stderr: 'git not found' });
        return;
      }
      let child: ChildProcess;
      try {
        child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        void attempt(index + 1).then(resolve);
        return;
      }
      const outChunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      let retried = false;
      let spawnError: Error | undefined;
      child.stdout?.on('data', (chunk: Buffer) => outChunks.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => errChunks.push(chunk));
      child.on('error', (error: Error & { code?: string }) => {
        spawnError = error;
        if (!retried && (error.code === 'ENOENT' || error.code === 'EACCES')) {
          retried = true;
          void attempt(index + 1).then(resolve);
        }
      });
      child.on('close', (code) => {
        if (retried) return;
        resolve({
          code: code ?? -1,
          stdout: Buffer.concat(outChunks).toString('utf8'),
          stderr: spawnError ? spawnError.message : Buffer.concat(errChunks).toString('utf8'),
        });
      });
    });
  return attempt(0);
}

export function createWorkspaceFiles(options: WorkspaceFilesOptions): WorkspaceFiles {
  if (!options || typeof options.workspace !== 'string' || options.workspace.length === 0) {
    throw new Error('invalid workspace: must be a non-empty string');
  }
  const workspace = path.resolve(options.workspace);
  let base: string;
  try {
    base = fs.realpathSync(workspace);
  } catch {
    base = workspace;
  }
  const maxFileBytes =
    typeof options.maxFileBytes === 'number' &&
    Number.isFinite(options.maxFileBytes) &&
    options.maxFileBytes > 0
      ? Math.floor(options.maxFileBytes)
      : DEFAULT_MAX_FILE_BYTES;

  const insideOrRoot = (target: string): boolean => {
    if (target === base) return true;
    const rel = path.relative(base, target);
    return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  };

  const resolvePath = (relPath: string, requireExists: boolean): ResolvedPath => {
    if (typeof relPath !== 'string') throw new Error('path must be a string');
    if (relPath.length > 0) {
      if (path.isAbsolute(relPath)) throw escapeError(relPath);
      if (relPath.split(/[\\/]+/).includes('..')) throw escapeError(relPath);
    }
    const abs = path.resolve(base, relPath);
    const lexicalRel = path.relative(base, abs);
    if (
      lexicalRel === '..' ||
      lexicalRel.startsWith(`..${path.sep}`) ||
      path.isAbsolute(lexicalRel)
    ) {
      throw escapeError(relPath);
    }
    let real: string | undefined;
    try {
      real = fs.realpathSync(abs);
    } catch {
      if (requireExists) throw new Error(`path not found: ${relPath}`);
    }
    if (real !== undefined && !insideOrRoot(real)) throw escapeError(relPath);
    return { abs: real ?? abs, rel: toPosix(path.relative(base, real ?? abs)) };
  };

  return {
    async tree(relPath = ''): Promise<FileEntry[]> {
      const dir = resolvePath(relPath, true);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(dir.abs);
      } catch {
        throw new Error(`path not found: ${relPath}`);
      }
      if (!stat.isDirectory()) throw new Error(`not a directory: ${dir.rel}`);

      const dirs: FileEntry[] = [];
      const files: FileEntry[] = [];
      for (const entry of fs.readdirSync(dir.abs, { withFileTypes: true })) {
        if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
        const full = path.join(dir.abs, entry.name);
        let isDir = entry.isDirectory();
        let size: number | undefined;
        try {
          const info = fs.statSync(full);
          isDir = info.isDirectory();
          if (info.isFile()) size = info.size;
        } catch {
          continue;
        }
        if (!isDir && size === undefined) continue;
        const item: FileEntry = {
          name: entry.name,
          path: toPosix(path.relative(base, full)),
          type: isDir ? 'dir' : 'file',
        };
        if (!isDir) item.size = size;
        (isDir ? dirs : files).push(item);
      }
      dirs.sort(compareNames);
      files.sort(compareNames);
      return [...dirs, ...files];
    },

    async read(relPath: string): Promise<FileContent> {
      const file = resolvePath(relPath, true);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file.abs);
      } catch {
        throw new Error(`path not found: ${relPath}`);
      }
      if (!stat.isFile()) throw new Error(`not a file: ${file.rel}`);

      if (options.checkRead) {
        const verdict = await options.checkRead(file.abs);
        if (!verdict || !verdict.ok) {
          throw new Error(`read denied: ${verdict?.reason ?? 'blocked by policy'}`);
        }
      }

      const size = stat.size;
      const fd = fs.openSync(file.abs, 'r');
      try {
        const sniff = Buffer.allocUnsafe(Math.min(BINARY_SNIFF_BYTES, size));
        const sniffLen = sniff.length === 0 ? 0 : fs.readSync(fd, sniff, 0, sniff.length, 0);
        if (sniff.subarray(0, sniffLen).includes(0)) {
          return { path: file.rel, content: '', size, truncated: false, binary: true };
        }
        const toRead = Math.min(size, maxFileBytes);
        const buffer = Buffer.allocUnsafe(toRead);
        let offset = 0;
        while (offset < toRead) {
          const read = fs.readSync(fd, buffer, offset, toRead - offset, offset);
          if (read <= 0) break;
          offset += read;
        }
        return {
          path: file.rel,
          content: buffer.subarray(0, offset).toString('utf8'),
          size,
          truncated: size > maxFileBytes,
          binary: false,
        };
      } finally {
        fs.closeSync(fd);
      }
    },

    async gitStatus(): Promise<{ branch: string; items: GitChange[] }> {
      const result = await runGit([
        '-C',
        workspace,
        '-c',
        'core.quotepath=false',
        'status',
        '--porcelain=v1',
        '-b',
      ]);
      if (result.code !== 0) return { branch: '', items: [] };
      return parseStatus(result.stdout);
    },

    async gitDiff(relPath: string): Promise<string> {
      const file = resolvePath(relPath, false);
      const result = await runGit([
        '-C',
        workspace,
        '-c',
        'core.quotepath=false',
        'diff',
        '--no-color',
        '--',
        file.rel,
      ]);
      if (result.code !== 0) return '';
      return result.stdout.slice(0, DIFF_LIMIT);
    },
  };
}
