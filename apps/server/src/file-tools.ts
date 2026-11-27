/**
 * 内置文件工具：edit_file / apply_patch / glob。
 *
 * 所有路径都相对 ToolContext.workspace 解析，词法上逃逸出 workspace 的路径一律拒绝，
 * 因此不会读取或写入工作区之外的文件。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ToolContext, ToolDefinition, ToolResult } from '@witcode/protocol';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist']);
const DEFAULT_GLOB_LIMIT = 200;

function ok(content: string): ToolResult {
  return { ok: true, content };
}

function fail(error: string): ToolResult {
  return { ok: false, content: '', error };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  return input as Record<string, unknown>;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function workspaceOf(ctx: ToolContext | undefined): string | undefined {
  if (!ctx || typeof ctx.workspace !== 'string' || ctx.workspace.length === 0) return undefined;
  return ctx.workspace;
}

type SafePath =
  | { ok: true; abs: string; rel: string }
  | { ok: false; error: string };

/** Resolve a user path against the workspace and reject any lexical escape. */
function resolveWorkspacePath(ctx: ToolContext | undefined, inputPath: unknown): SafePath {
  const workspace = workspaceOf(ctx);
  if (!workspace) {
    return { ok: false, error: 'invalid context: "workspace" must be a non-empty string' };
  }
  const value = readNonEmptyString(inputPath);
  if (!value) {
    return { ok: false, error: 'invalid input: "path" must be a non-empty string' };
  }
  const base = path.resolve(workspace);
  const abs = path.resolve(base, value);
  const rel = path.relative(base, abs);
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return { ok: false, error: `path escapes workspace: ${value}` };
  }
  return { ok: true, abs, rel: rel.split(path.sep).join('/') };
}

function isFile(abs: string): boolean {
  try {
    return fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}

interface TextFile {
  lines: string[];
  crlf: boolean;
  trailingNewline: boolean;
}

/** Read as UTF-8, normalizing CRLF to LF while remembering the original style. */
function readTextFile(abs: string): TextFile {
  const raw = fs.readFileSync(abs, 'utf8');
  const normalized = raw.replace(/\r\n/g, '\n');
  const trailingNewline = normalized.endsWith('\n');
  const lines = normalized === '' ? [] : normalized.split('\n');
  if (trailingNewline) lines.pop();
  return { lines, crlf: raw.includes('\r\n'), trailingNewline };
}

/** Write back with the original newline style (CRLF or LF). */
function serializeTextFile(file: TextFile): string {
  let out = file.lines.join('\n');
  if (file.trailingNewline && out.length > 0) out += '\n';
  return file.crlf ? out.replace(/\n/g, '\r\n') : out;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) return count;
    count += 1;
    from = index + needle.length;
  }
}

// ---------------------------------------------------------------------------
// edit_file
// ---------------------------------------------------------------------------

async function executeEditFile(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const args = asRecord(input);
  if (!args) return fail('invalid input: expected an object');

  const resolved = resolveWorkspacePath(ctx, args['path']);
  if (!resolved.ok) return fail(resolved.error);

  const oldRaw = args['old_string'];
  if (typeof oldRaw !== 'string' || oldRaw.length === 0) {
    return fail('invalid input: "old_string" must be a non-empty string');
  }
  const newRaw = args['new_string'];
  if (typeof newRaw !== 'string') {
    return fail('invalid input: "new_string" must be a string');
  }
  const replaceAll = args['replace_all'];
  if (replaceAll !== undefined && typeof replaceAll !== 'boolean') {
    return fail('invalid input: "replace_all" must be a boolean');
  }

  if (!isFile(resolved.abs)) return fail(`file not found: ${resolved.rel}`);

  let original: string;
  let crlf: boolean;
  try {
    const file = readTextFile(resolved.abs);
    original = file.lines.join('\n') + (file.trailingNewline && file.lines.length > 0 ? '\n' : '');
    crlf = file.crlf;
  } catch (err) {
    return fail(`failed to read file: ${errorMessage(err)}`);
  }

  // Match in normalized LF form; both the file and the model-supplied strings
  // are normalized so CRLF files can be edited with plain "\n" strings.
  const oldString = oldRaw.replace(/\r\n/g, '\n');
  const newString = newRaw.replace(/\r\n/g, '\n');
  const found = countOccurrences(original, oldString);
  if (found === 0) {
    return fail(`old_string not found in ${resolved.rel}`);
  }
  if (found > 1 && replaceAll !== true) {
    return fail(
      `old_string appears ${found} times in ${resolved.rel}; provide more context to make it unique, or set replace_all: true`,
    );
  }

  const updated = replaceAll === true
    ? original.split(oldString).join(newString)
    : original.replace(oldString, newString);

  try {
    const out = crlf ? updated.replace(/\n/g, '\r\n') : updated;
    fs.writeFileSync(resolved.abs, out, 'utf8');
  } catch (err) {
    return fail(`failed to write file: ${errorMessage(err)}`);
  }

  const count = replaceAll === true ? found : 1;
  return ok(`Successfully edited ${resolved.rel} (${count} replacement${count === 1 ? '' : 's'})`);
}

const editFileTool: ToolDefinition = {
  name: 'edit_file',
  description:
    'Perform an exact string replacement in a file. Reads the file first and requires old_string to be a unique match; if it occurs more than once, add more surrounding context or set replace_all to replace every occurrence. The original newline style (CRLF/LF) is preserved. Paths are resolved against the workspace and paths outside it are rejected.',
  readOnly: false,
  destructive: true,
  concurrentSafe: false,
  riskLevel: 'medium',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path relative to the workspace (absolute paths inside the workspace also work)',
      },
      old_string: { type: 'string', description: 'Exact text to replace; must be unique unless replace_all is true' },
      new_string: { type: 'string', description: 'Replacement text (may be empty to delete text)' },
      replace_all: { type: 'boolean', description: 'Replace all occurrences instead of requiring a unique match' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  async execute(input, ctx) {
    return executeEditFile(input, ctx);
  },
};

// ---------------------------------------------------------------------------
// apply_patch
// ---------------------------------------------------------------------------

type PatchLineType = 'context' | 'add' | 'remove';

interface PatchLine {
  type: PatchLineType;
  text: string;
}

type PatchKind = 'update' | 'add' | 'delete';

interface PatchOp {
  kind: PatchKind;
  rel: string;
  abs: string;
  /** Update hunks, each a consecutive sequence of +/-/space lines. */
  hunks: PatchLine[][];
  /** Content lines for Add/Delete operations. */
  lines: PatchLine[];
}

type ParsedPatch = { ops: PatchOp[] } | { error: string };

function parsePatch(patch: string, ctx: ToolContext): ParsedPatch {
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  if ((lines[0] ?? '').trim() !== '*** Begin Patch') {
    return { error: 'invalid patch: must start with "*** Begin Patch"' };
  }

  const ops: PatchOp[] = [];
  const seen = new Set<string>();
  let current: PatchOp | undefined;
  let hunk: PatchLine[] | undefined;

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    // Directives never start with a space; content lines may.
    const directive = line.trimEnd();
    if (directive === '*** End Patch') break;
    if (directive === '*** Begin Patch') continue;

    let kind: PatchKind | undefined;
    let rawPath: string | undefined;
    if (directive.startsWith('*** Update File:')) {
      kind = 'update';
      rawPath = directive.slice('*** Update File:'.length).trim();
    } else if (directive.startsWith('*** Add File:')) {
      kind = 'add';
      rawPath = directive.slice('*** Add File:'.length).trim();
    } else if (directive.startsWith('*** Delete File:')) {
      kind = 'delete';
      rawPath = directive.slice('*** Delete File:'.length).trim();
    }

    if (kind && rawPath !== undefined) {
      if (!rawPath) return { error: `invalid patch line ${i + 1}: missing file path` };
      const resolved = resolveWorkspacePath(ctx, rawPath);
      if (!resolved.ok) return { error: `patch line ${i + 1}: ${resolved.error}` };
      if (seen.has(resolved.abs)) return { error: `duplicate file in patch: ${resolved.rel}` };
      seen.add(resolved.abs);
      current = { kind, rel: resolved.rel, abs: resolved.abs, hunks: [], lines: [] };
      ops.push(current);
      hunk = undefined;
      continue;
    }

    if (directive.startsWith('***')) continue; // ignore unsupported directives such as "*** Move to:"
    if (!current) return { error: `invalid patch: content before a file header at line ${i + 1}` };

    if (directive.startsWith('@@')) {
      if (current.kind === 'update') {
        hunk = [];
        current.hunks.push(hunk);
      }
      continue;
    }

    let item: PatchLine;
    if (line.startsWith('+')) {
      item = { type: 'add', text: line.slice(1) };
    } else if (line.startsWith('-')) {
      item = { type: 'remove', text: line.slice(1) };
    } else if (line.startsWith(' ')) {
      item = { type: 'context', text: line.slice(1) };
    } else if (line === '') {
      item = { type: 'context', text: '' };
    } else {
      return { error: `invalid patch line ${i + 1}: ${line}` };
    }

    if (current.kind === 'update') {
      if (!hunk) {
        hunk = [];
        current.hunks.push(hunk);
      }
      hunk.push(item);
    } else {
      current.lines.push(item);
    }
  }

  if (ops.length === 0) return { error: 'invalid patch: no file operations found' };
  return { ops };
}

type HunkResult = { lines: string[] } | { error: string };

/** Apply each hunk by finding its old-line sequence in the working file. */
function applyHunks(original: string[], hunks: PatchLine[][], rel: string): HunkResult {
  const lines = original.slice();
  let cursor = 0;

  for (const hunk of hunks) {
    if (hunk.length === 0) continue;
    const before: string[] = [];
    const after: string[] = [];
    for (const item of hunk) {
      if (item.type !== 'add') before.push(item.text);
      if (item.type !== 'remove') after.push(item.text);
    }

    if (before.length === 0) {
      lines.splice(cursor, 0, ...after);
      cursor += after.length;
      continue;
    }

    let found = -1;
    const lastStart = lines.length - before.length;
    for (let i = cursor; i <= lastStart; i += 1) {
      let matches = true;
      for (let j = 0; j < before.length; j += 1) {
        if (lines[i + j] !== before[j]) {
          matches = false;
          break;
        }
      }
      if (matches) {
        found = i;
        break;
      }
    }

    if (found === -1) {
      return { error: `patch context mismatch in ${rel} near line ${cursor + 1}` };
    }
    lines.splice(found, before.length, ...after);
    cursor = found + after.length;
  }

  return { lines };
}

async function executeApplyPatch(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const args = asRecord(input);
  if (!args) return fail('invalid input: expected an object');

  const patch = readNonEmptyString(args['patch']);
  if (!patch) return fail('invalid input: "patch" must be a non-empty string');

  const parsed = parsePatch(patch, ctx);
  if ('error' in parsed) return fail(parsed.error);

  // Validate and compute every operation in memory before touching the disk.
  const pending: Array<{ op: PatchOp; content: string }> = [];
  try {
    for (const op of parsed.ops) {
      if (op.kind === 'delete') {
        if (op.lines.length > 0) {
          return fail(`invalid patch: *** Delete File: ${op.rel} must not contain content lines`);
        }
        if (!isFile(op.abs)) return fail(`file not found: ${op.rel}`);
        pending.push({ op, content: '' });
        continue;
      }

      if (op.kind === 'add') {
        if (fs.existsSync(op.abs)) return fail(`file already exists: ${op.rel}`);
        if (op.lines.some((line) => line.type !== 'add' && line.text !== '')) {
          return fail(`invalid patch: *** Add File: ${op.rel} supports only "+" lines`);
        }
        const added = op.lines.filter((line) => line.type === 'add').map((line) => line.text);
        const file: TextFile = {
          lines: added,
          crlf: false,
          trailingNewline: added.length > 0,
        };
        pending.push({ op, content: serializeTextFile(file) });
        continue;
      }

      if (!isFile(op.abs)) return fail(`file not found: ${op.rel}`);
      const file = readTextFile(op.abs);
      const result = applyHunks(file.lines, op.hunks, op.rel);
      if ('error' in result) return fail(result.error);
      pending.push({ op, content: serializeTextFile({ ...file, lines: result.lines }) });
    }
  } catch (err) {
    return fail(`failed to read file for patch: ${errorMessage(err)}`);
  }

  try {
    for (const { op, content } of pending) {
      if (op.kind === 'delete') {
        fs.unlinkSync(op.abs);
      } else {
        fs.mkdirSync(path.dirname(op.abs), { recursive: true });
        fs.writeFileSync(op.abs, content, 'utf8');
      }
    }
  } catch (err) {
    return fail(`failed to write patch: ${errorMessage(err)}`);
  }

  return ok(`Successfully applied patch to ${pending.length} file${pending.length === 1 ? '' : 's'}`);
}

const applyPatchTool: ToolDefinition = {
  name: 'apply_patch',
  description:
    'Apply a DSH/Codex style patch: a "*** Begin Patch" / "*** End Patch" block with "*** Update File:", "*** Add File:" or "*** Delete File:" sections. Update sections use "@@" hunks with "-" removed lines, "+" added lines and space-prefixed context. Context must match exactly; a mismatch reports the affected line. Paths are resolved against the workspace and escapes are rejected.',
  readOnly: false,
  destructive: true,
  concurrentSafe: false,
  riskLevel: 'high',
  inputSchema: {
    type: 'object',
    properties: {
      patch: {
        type: 'string',
        description: 'The patch text, starting with *** Begin Patch and ending with *** End Patch',
      },
    },
    required: ['patch'],
  },
  async execute(input, ctx) {
    return executeApplyPatch(input, ctx);
  },
};

// ---------------------------------------------------------------------------
// glob
// ---------------------------------------------------------------------------

/** Minimal glob: `**` any depth, `*` within a segment, `?` one character. */
function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i] ?? '';
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

function collectFiles(base: string, dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(base, full, out);
    } else if (entry.isFile()) {
      out.push(path.relative(base, full).split(path.sep).join('/'));
    }
  }
}

async function executeGlob(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const args = asRecord(input);
  if (!args) return fail('invalid input: expected an object');

  const pattern = readNonEmptyString(args['pattern']);
  if (!pattern) return fail('invalid input: "pattern" must be a non-empty string');

  let limit = DEFAULT_GLOB_LIMIT;
  const rawLimit = args['limit'];
  if (rawLimit !== undefined) {
    if (typeof rawLimit !== 'number' || !Number.isInteger(rawLimit) || rawLimit < 1) {
      return fail('invalid input: "limit" must be a positive integer');
    }
    limit = rawLimit;
  }

  const workspace = workspaceOf(ctx);
  if (!workspace) return fail('invalid context: "workspace" must be a non-empty string');
  const base = path.resolve(workspace);
  try {
    if (!fs.statSync(base).isDirectory()) return fail(`workspace is not a directory: ${base}`);
  } catch {
    return fail(`workspace is not a directory: ${base}`);
  }

  const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  const matcher = globToRegExp(normalized);
  // Like the existing grep tool, a slash-free pattern matches file names at any depth.
  const byBasename = !normalized.includes('/');
  const all: string[] = [];
  collectFiles(base, base, all);

  const matches = all
    .filter((rel) => matcher.test(byBasename ? path.posix.basename(rel) : rel))
    .sort()
    .slice(0, limit);
  return ok(JSON.stringify(matches));
}

const globTool: ToolDefinition = {
  name: 'glob',
  description:
    'Find files under the workspace with wildcards: "*" within a path segment, "?" for one character, and "**" for any depth. A pattern without a slash matches file names at any depth. Skips node_modules, .git and dist. Returns a JSON array of sorted workspace-relative paths, capped at 200 by default.',
  readOnly: true,
  concurrentSafe: true,
  riskLevel: 'low',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern, e.g. "**/*.ts" or "src/*.ts"' },
      limit: { type: 'integer', minimum: 1, description: 'Maximum number of matches (default 200)' },
    },
    required: ['pattern'],
  },
  async execute(input, ctx) {
    return executeGlob(input, ctx);
  },
};

export function createFileTools(): ToolDefinition[] {
  return [editFileTool, applyPatchTool, globTool];
}
