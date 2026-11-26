import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ToolContext, ToolDefinition, ToolResult, ToolService } from '@witcode/protocol';
import { asInput, CappedBuffer, readNumber, readString, safePath } from './util.ts';

const MAX_READ_LINES = 2000;
const MAX_GREP_RESULTS = 100;
const MAX_OUTPUT_BYTES = 100 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'dist', '.witcode']);

function ok(content: string): ToolResult {
  return { ok: true, content };
}

function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Only plain JSON objects carry tool arguments; anything else is left for execute to reject. */
function isInputObject(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

/** The same absolute path is used for the approval preview and for execution. */
function resolvePathField(args: Record<string, unknown>, ctx: ToolContext): unknown {
  return typeof args.path === 'string' ? path.resolve(ctx.workspace, args.path) : args.path;
}

/** Numeric strings become real numbers; bad values stay for execute's own validation. */
function normalizeNumber(value: unknown, fallback: number): unknown {
  if (value === undefined) return fallback;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return value;
}

/** Minimal glob: `**` any depth, `*` within a segment, `?` one character. */
function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/' || glob[i + 2] === '\\') {
          source += '(?:.*[/\\\\])?';
          i += 2;
        } else {
          source += '.*';
          i += 1;
        }
      } else {
        source += '[^/\\\\]*';
      }
    } else if (ch === '?') {
      source += '[^/\\\\]';
    } else {
      source += /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
    }
  }
  return new RegExp(`^${source}$`);
}

const readFileTool: ToolDefinition = {
  name: 'read_file',
  description:
    'Read a UTF-8 text file and return it with 1-based line numbers. Shows at most 2000 lines by default; use offset/limit to page through longer files.',
  readOnly: true,
  concurrentSafe: true,
  riskLevel: 'low',
  async resolveInput(input, ctx) {
    if (!isInputObject(input)) return input;
    return {
      ...input,
      path: resolvePathField(input, ctx),
      offset: normalizeNumber(input.offset, 0),
      limit: normalizeNumber(input.limit, MAX_READ_LINES),
    };
  },
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the workspace' },
      offset: { type: 'number', description: 'Zero-based line to start from (default 0)' },
      limit: { type: 'number', description: 'Maximum lines to return (max 2000, default 2000)' },
    },
    required: ['path'],
  },
  async execute(input, ctx) {
    const args = asInput(input);
    const rel = readString(args, 'path', true)!;
    const offset = Math.max(0, Math.floor(readNumber(args, 'offset', 0)));
    const limit = Math.min(MAX_READ_LINES, Math.max(0, Math.floor(readNumber(args, 'limit', MAX_READ_LINES))));
    const file = safePath(ctx.workspace, rel);

    const text = await fs.promises.readFile(file, 'utf8');
    const lines = text.split(/\r?\n/);
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();

    const total = lines.length;
    const slice = lines.slice(offset, offset + limit);
    const body = slice
      .map((line, index) => `${String(offset + index + 1).padStart(6)}\t${line}`)
      .join('\n');

    const shownEnd = Math.min(total, offset + limit);
    const notes: string[] = [];
    if (offset > 0) notes.push(`skipped first ${offset} lines (offset)`);
    if (shownEnd < total) notes.push(`truncated: showing lines ${offset + 1}-${shownEnd} of ${total}`);

    return ok(notes.length > 0 ? `${body}\n\n[${notes.join('; ')}]` : body);
  },
};

const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description: 'Write UTF-8 content to a file, creating parent directories as needed.',
  destructive: true,
  concurrentSafe: false,
  riskLevel: 'medium',
  async resolveInput(input, ctx) {
    if (!isInputObject(input)) return input;
    return {
      ...input,
      path: resolvePathField(input, ctx),
      content: input.content === undefined ? undefined : String(input.content),
    };
  },
  async prepareApproval(input, ctx) {
    const args = isInputObject(input) ? input : {};
    const file = path.resolve(ctx.workspace, typeof args.path === 'string' ? args.path : '.');
    const content =
      typeof args.content === 'string'
        ? args.content
        : args.content === undefined
          ? ''
          : String(args.content);
    return {
      title: '写入文件',
      detail: `目标：${file}\n大小：${Buffer.byteLength(content, 'utf8')} 字节`,
      riskLevel: 'medium',
    };
  },
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the workspace' },
      content: { type: 'string', description: 'Full file content to write' },
    },
    required: ['path', 'content'],
  },
  async execute(input, ctx) {
    const args = asInput(input);
    const rel = readString(args, 'path', true)!;
    const content = readString(args, 'content', true)!;
    const file = safePath(ctx.workspace, rel);

    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, content, 'utf8');
    return ok(`Wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${rel}`);
  },
};

const listDirTool: ToolDefinition = {
  name: 'list_dir',
  description: 'List a directory with entry type and size, sorted by name.',
  readOnly: true,
  concurrentSafe: true,
  riskLevel: 'low',
  async resolveInput(input, ctx) {
    if (!isInputObject(input)) return input;
    return { ...input, path: resolvePathField(input, ctx) };
  },
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory relative to the workspace (default: workspace root)' },
    },
    required: [],
  },
  async execute(input, ctx) {
    const args = asInput(input);
    const dir = safePath(ctx.workspace, readString(args, 'path', false));

    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const rows = entries.map((entry) => {
      let size = 0;
      try {
        size = fs.statSync(path.join(dir, entry.name)).size;
      } catch {
        size = 0;
      }
      return {
        name: entry.name,
        type: entry.isDirectory() ? 'dir' : 'file',
        size,
      };
    });
    rows.sort((a, b) => compareNames(a.name, b.name));

    const header = 'type  size        name';
    const body = rows
      .map((row) => `${row.type.padEnd(4)}  ${String(row.size).padStart(10)}  ${row.name}`)
      .join('\n');
    return ok(body.length > 0 ? `${header}\n${body}` : '(empty directory)');
  },
};

const grepTool: ToolDefinition = {
  name: 'grep',
  description:
    'Recursively search files with a JavaScript regular expression. Skips node_modules, .git, dist and .witcode. Returns at most 100 matches as path:line:content.',
  readOnly: true,
  concurrentSafe: true,
  riskLevel: 'low',
  async resolveInput(input, ctx) {
    if (!isInputObject(input)) return input;
    return { ...input, path: resolvePathField(input, ctx) };
  },
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression source to match against each line' },
      path: { type: 'string', description: 'Directory or file to search (default: workspace root)' },
      glob: { type: 'string', description: 'Optional glob filter on the relative file path, e.g. "*.ts"' },
    },
    required: ['pattern'],
  },
  async execute(input, ctx) {
    const args = asInput(input);
    const pattern = readString(args, 'pattern', true)!;
    const glob = readString(args, 'glob', false);
    // A slash-free glob is understood as a filename pattern, like most CLI tools.
    const globByBasename =
      glob !== undefined && !glob.includes('/') && !glob.includes('\\');
    const matcher = glob === undefined ? undefined : globToRegExp(glob);
    const matchesGlob = (rel: string): boolean =>
      matcher === undefined || matcher.test(globByBasename ? path.basename(rel) : rel);
    const regex = new RegExp(pattern); // invalid patterns surface as a normal tool error
    const root = safePath(ctx.workspace, readString(args, 'path', false));

    const results: string[] = [];
    let truncated = false;

    const walk = async (dir: string): Promise<void> => {
      if (results.length >= MAX_GREP_RESULTS) return;
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      entries.sort((a, b) => compareNames(a.name, b.name));

      for (const entry of entries) {
        if (results.length >= MAX_GREP_RESULTS) break;
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }
        if (!entry.isFile()) continue;

        const rel = path.relative(root, full).split(path.sep).join('/');
        if (!matchesGlob(rel)) continue;

        let text: string;
        try {
          text = await fs.promises.readFile(full, 'utf8');
        } catch {
          continue; // unreadable/binary files are simply skipped
        }

        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i]!;
          if (!regex.test(line)) continue;
          results.push(`${rel}:${i + 1}:${line}`);
          if (results.length >= MAX_GREP_RESULTS) {
            truncated = true;
            break;
          }
        }
      }
    };

    // A directly supplied file is a valid search root too.
    const stat = await fs.promises.stat(root);
    if (stat.isDirectory()) {
      await walk(root);
    } else {
      const text = await fs.promises.readFile(root, 'utf8');
      const rel = path.basename(root);
      if (matchesGlob(rel)) {
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length && results.length < MAX_GREP_RESULTS; i += 1) {
          const line = lines[i]!;
          if (regex.test(line)) results.push(`${rel}:${i + 1}:${line}`);
        }
        if (results.length >= MAX_GREP_RESULTS) truncated = true;
      }
    }

    const body = results.join('\n');
    return ok(truncated ? `${body}\n... [truncated: reached 100 matches]` : body);
  },
};

interface CommandOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
}

/** Force-stop the shell and its children; resolve once termination is done. */
function killTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null) return Promise.resolve();
  if (process.platform === 'win32') {
    // No `detached` on Windows (it breaks piped stdio), so taskkill /t is
    // what reaches grandchildren spawned by the shell.
    return new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      const fallback = (): void => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        resolve();
      };
      killer.on('error', fallback);
      killer.on('close', () => resolve());
    });
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
  return Promise.resolve();
}

const runCommandTool: ToolDefinition = {
  name: 'run_command',
  description:
    'Run a shell command with cwd set to the workspace. Default timeout 60s; stdout and stderr are each capped at 100KB.',
  destructive: true,
  concurrentSafe: false,
  riskLevel: 'high',
  async resolveInput(input, _ctx) {
    if (!isInputObject(input)) return input;
    return {
      ...input,
      command: typeof input.command === 'string' ? input.command.trim() : input.command,
    };
  },
  async prepareApproval(input, ctx) {
    const args = isInputObject(input) ? input : {};
    const command = typeof args.command === 'string' ? args.command.trim() : '';
    return {
      title: '执行命令',
      detail: `命令：${command}\ncwd：${path.resolve(ctx.workspace)}`,
      riskLevel: 'high',
    };
  },
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Command line passed to the shell' },
      timeoutMs: { type: 'number', description: 'Timeout in milliseconds (default 60000)' },
    },
    required: ['command'],
  },
  async execute(input, ctx) {
    const args = asInput(input);
    const command = readString(args, 'command', true)!;
    const timeoutMs = readNumber(args, 'timeoutMs', DEFAULT_TIMEOUT_MS);
    if (timeoutMs <= 0) throw new Error('invalid input: "timeoutMs" must be positive');

    const stdoutBuf = new CappedBuffer(MAX_OUTPUT_BYTES);
    const stderrBuf = new CappedBuffer(MAX_OUTPUT_BYTES);

    const outcome = await new Promise<CommandOutcome>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(command, {
          shell: true,
          cwd: path.resolve(ctx.workspace),
          // Windows breaks piped stdio when detached; taskkill /t handles
          // grandchildren there, while POSIX can signal the process group.
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        reject(error);
        return;
      }

      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let forced: 'timeout' | 'abort' | undefined;

      const forcedFlags = (): { timedOut: boolean; aborted: boolean } => ({
        timedOut: forced === 'timeout',
        aborted: forced === 'abort',
      });
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        ctx.signal?.removeEventListener('abort', onAbort);
      };
      const finish = (value: CommandOutcome): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const fail = (error: unknown): void => {
        if (settled || forced !== undefined) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const stop = (reason: 'timeout' | 'abort'): void => {
        forced = reason;
        const value = (): CommandOutcome => ({
          exitCode: child.exitCode,
          signal: child.signalCode,
          ...forcedFlags(),
        });
        // Only settle after the whole tree is gone, so the caller can safely
        // delete the workspace directory holding the child's cwd.
        void killTree(child).then(() => finish(value()));
      };
      function onAbort(): void {
        stop('abort');
      }

      timer = setTimeout(() => stop('timeout'), timeoutMs);

      if (ctx.signal?.aborted) {
        onAbort();
      } else if (ctx.signal) {
        ctx.signal.addEventListener('abort', onAbort, { once: true });
      }

      child.stdout?.on('data', (chunk: Buffer) => stdoutBuf.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => stderrBuf.push(chunk));
      child.on('error', fail);
      child.on('close', (code, signal) => {
        // On forced termination `stop` settles after killTree completes.
        if (forced !== undefined) return;
        finish({ exitCode: code, signal, timedOut: false, aborted: false });
      });
    });

    const stdout = stdoutBuf.toString() + (stdoutBuf.truncated ? '\n... [truncated: 100KB limit]' : '');
    const stderr = stderrBuf.toString() + (stderrBuf.truncated ? '\n... [truncated: 100KB limit]' : '');

    let header: string;
    let error: string | undefined;
    if (outcome.timedOut) {
      error = `command timed out after ${timeoutMs}ms`;
      header = error;
    } else if (outcome.aborted) {
      error = 'command aborted';
      header = error;
    } else if (outcome.exitCode === null) {
      header = `exit code: null (signal: ${outcome.signal ?? 'unknown'})`;
    } else {
      header = `exit code: ${outcome.exitCode}`;
    }

    const content = `${header}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`;
    return error === undefined ? ok(content) : { ok: false, content, error };
  },
};

/** The five tools every agent gets out of the box. */
export const builtinTools: ToolDefinition[] = [
  readFileTool,
  writeFileTool,
  listDirTool,
  grepTool,
  runCommandTool,
];

/** Register all builtins; returns a disposer that unregisters them. */
export function registerBuiltinTools(service: ToolService): () => void {
  const disposers = builtinTools.map((tool) => service.register(tool));
  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}
