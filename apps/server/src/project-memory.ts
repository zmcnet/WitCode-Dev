/**
 * 项目记忆：第一次进一个项目时，自己扫一遍，形成一份可复用的上下文。
 *
 * 不是向量数据库，就是一份会长大的 Markdown：
 * - 自动扫描：包名、脚本、README 摘要、顶层目录
 * - 人工/模型追加：`.witcode/memory.md` 里记项目约定、坑、常用命令
 *
 * 每次会话把它拼进 system prompt，第二次进来就不用从零读。
 */

import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const MEMORY_DIR = '.witcode';
export const MEMORY_FILE = 'memory.md';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);

export interface ProjectMemory {
  /** 自动扫描出来的事实。 */
  facts: string;
  /** 人工/模型维护的记忆。 */
  notes: string;
  /** 拼好的完整上下文，可直接进 system prompt。 */
  context: string;
}

export async function loadProjectMemory(workspace: string): Promise<ProjectMemory> {
  const facts = await scanProject(workspace);
  const notes = await readNotes(workspace);
  const context = [
    '# 项目记忆',
    '',
    '以下是这个项目的自动扫描结果与历史笔记。动手前先读，不要假设。',
    '',
    facts,
    notes ? `\n## 历史笔记\n\n${notes}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return { facts, notes, context };
}

async function readNotes(workspace: string): Promise<string> {
  try {
    return await readFile(path.join(workspace, MEMORY_DIR, MEMORY_FILE), 'utf8');
  } catch {
    return '';
  }
}

async function scanProject(workspace: string): Promise<string> {
  const lines: string[] = [];

  lines.push(`## 位置\n\n${workspace}`);

  const pkg = await readJson(path.join(workspace, 'package.json'));
  if (pkg) {
    lines.push('', '## 包信息', '');
    if (typeof pkg.name === 'string') lines.push(`- 名称：${pkg.name}`);
    if (typeof pkg.version === 'string') lines.push(`- 版本：${pkg.version}`);
    if (pkg.scripts && typeof pkg.scripts === 'object') {
      lines.push(`- 脚本：${Object.keys(pkg.scripts).join(', ')}`);
    }
  }

  const readme = await readFirstExisting(workspace, [
    'README.md',
    'README.zh-CN.md',
    'README.zh.md',
    'readme.md',
  ]);
  if (readme) {
    lines.push('', '## README 摘要', '', truncate(readme, 1800));
  }

  const dirs = await listTopLevelDirs(workspace);
  if (dirs.length > 0) {
    lines.push('', '## 顶层目录', '', dirs.join(', '));
  }

  return lines.join('\n');
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function readFirstExisting(workspace: string, names: string[]): Promise<string> {
  for (const name of names) {
    try {
      return await readFile(path.join(workspace, name), 'utf8');
    } catch {
      // 继续找下一个
    }
  }
  return '';
}

async function listTopLevelDirs(workspace: string): Promise<string[]> {
  try {
    const entries = await readdir(workspace, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name))
      .map((entry) => entry.name)
      .sort()
      .slice(0, 30);
  } catch {
    return [];
  }
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n\n…（已截断）`;
}

/** 把一段新的笔记追加到项目记忆里（模型复盘时用）。 */
export async function appendProjectNote(workspace: string, note: string): Promise<void> {
  const dir = path.join(workspace, MEMORY_DIR);
  await mkdir(dir, { recursive: true });

  const file = path.join(dir, MEMORY_FILE);
  const existing = await readNotes(workspace);
  const stamp = new Date().toISOString().slice(0, 10);
  const next = `${existing}${existing ? '\n\n' : ''}- ${stamp}：${note.trim()}\n`;

  await writeFile(file, next, 'utf8');
}
