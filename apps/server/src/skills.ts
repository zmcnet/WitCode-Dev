/**
 * 技能与斜杠命令：数据型能力，落盘到 `<dataDir>/skills.json` / `commands.json`。
 *
 * 技能正文只通过 `use_skill` 工具按需读取，系统提示里仅注入简短摘要；
 * 命令在消息入口展开为 prompt + 参数。文件缺失或损坏时按空数组启动，不阻塞服务。
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SkillSummary, SlashCommand, ToolDefinition, ToolResult } from '@witcode/protocol';

function resolveDataDir(options?: { dataDir?: string }): string {
  return options?.dataDir ?? process.env.WITCODE_DATA_DIR ?? path.join(os.homedir(), '.witcode');
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, filePath);
}

async function loadArray(filePath: string): Promise<unknown[]> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(filePath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // 首次启动或文件损坏：空数组，不阻塞服务。
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} 必须是非空字符串`);
  }
  return value.trim();
}

function normalizeSkill(input: unknown): SkillSummary {
  if (!isRecord(input)) throw new Error('技能必须是对象');
  const id = requiredText(input.id, '技能 id');
  const name = requiredText(input.name, '技能 name');
  if (typeof input.content !== 'string' || input.content.trim() === '') {
    throw new Error('技能 content 必须是非空字符串');
  }
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  const enabled = typeof input.enabled === 'boolean' ? input.enabled : true;
  return { id, name, description, content: input.content, enabled };
}

function normalizeCommand(input: unknown): SlashCommand {
  if (!isRecord(input)) throw new Error('命令必须是对象');
  const name = requiredText(input.name, '命令 name');
  if (!/^[a-z0-9_-]+$/i.test(name)) throw new Error(`命令 name 非法：${name}`);
  if (typeof input.prompt !== 'string' || input.prompt.trim() === '') {
    throw new Error('命令 prompt 必须是非空字符串');
  }
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  return { name, description, prompt: input.prompt };
}

const PROMPT_HEADER = '## 可用技能\n';
const PROMPT_HINT = '\n提示：调用 `use_skill` 并传入技能 name 可获取技能全文。\n';
const PROMPT_LIMIT = 8000;

function buildPromptSection(skills: SkillSummary[]): string {
  const enabled = skills.filter((skill) => skill.enabled);
  if (enabled.length === 0) return '';

  const budget = Math.max(0, PROMPT_LIMIT - PROMPT_HEADER.length - PROMPT_HINT.length);
  let body = '';
  for (const skill of enabled) {
    const line = `- ${skill.name}: ${skill.description}\n`;
    if (body.length + line.length <= budget) {
      body += line;
      continue;
    }
    const remaining = budget - body.length;
    if (remaining >= 2) body += `${line.slice(0, remaining - 2)}…\n`;
    break;
  }
  return `${PROMPT_HEADER}${body}${PROMPT_HINT}`;
}

export interface SkillStore {
  list(): SkillSummary[];
  save(skill: SkillSummary): Promise<SkillSummary[]>;
  remove(id: string): Promise<SkillSummary[]>;
  /** 没有启用技能时返回 '' */
  enabledPromptSection(): string;
}

export async function createSkillStore(options?: { dataDir?: string }): Promise<SkillStore> {
  const filePath = path.join(resolveDataDir(options), 'skills.json');
  const items: SkillSummary[] = [];
  for (const raw of await loadArray(filePath)) {
    try {
      items.push(normalizeSkill(raw));
    } catch {
      // 损坏条目跳过，不影响其它技能。
    }
  }

  const persist = async (): Promise<void> => {
    await writeFileAtomic(filePath, `${JSON.stringify(items, null, 2)}\n`);
  };
  const snapshot = (): SkillSummary[] => items.map((skill) => ({ ...skill }));

  return {
    list: snapshot,

    async save(skill) {
      const next = normalizeSkill(skill);
      const index = items.findIndex((item) => item.id === next.id);
      if (index >= 0) items[index] = next;
      else items.push(next);
      await persist();
      return snapshot();
    },

    async remove(id) {
      const key = typeof id === 'string' ? id.trim() : '';
      const before = items.length;
      for (let index = items.length - 1; index >= 0; index -= 1) {
        if (items[index]?.id === key) items.splice(index, 1);
      }
      if (items.length !== before) await persist();
      return snapshot();
    },

    enabledPromptSection() {
      return buildPromptSection(items);
    },
  };
}

export interface CommandStore {
  list(): SlashCommand[];
  save(command: SlashCommand): Promise<SlashCommand[]>;
  remove(name: string): Promise<SlashCommand[]>;
  /** 输入以 /name 开头时展开为 prompt + 剩余参数；未知命令返回 null。 */
  expand(text: string): { command: string; text: string } | null;
}

export async function createCommandStore(options?: { dataDir?: string }): Promise<CommandStore> {
  const filePath = path.join(resolveDataDir(options), 'commands.json');
  const items: SlashCommand[] = [];
  for (const raw of await loadArray(filePath)) {
    try {
      items.push(normalizeCommand(raw));
    } catch {
      // 损坏条目跳过，不影响其它命令。
    }
  }

  const persist = async (): Promise<void> => {
    await writeFileAtomic(filePath, `${JSON.stringify(items, null, 2)}\n`);
  };
  const snapshot = (): SlashCommand[] => items.map((command) => ({ ...command }));
  const findIndex = (name: string): number =>
    items.findIndex((item) => item.name.toLowerCase() === name.toLowerCase());

  return {
    list: snapshot,

    async save(command) {
      const next = normalizeCommand(command);
      const index = findIndex(next.name);
      if (index >= 0) items[index] = next;
      else items.push(next);
      await persist();
      return snapshot();
    },

    async remove(name) {
      const key = typeof name === 'string' ? name.trim() : '';
      const index = findIndex(key);
      if (index >= 0) {
        items.splice(index, 1);
        await persist();
      }
      return snapshot();
    },

    expand(text) {
      if (typeof text !== 'string') return null;
      const match = /^\/([a-z0-9_-]+)(?=$|\s)/i.exec(text);
      const token = match?.[1];
      if (!token) return null;
      const command = items.find((item) => item.name.toLowerCase() === token.toLowerCase());
      if (!command) return null;
      const args = text.slice(match[0].length).trim();
      return { command: command.name, text: args ? `${command.prompt} ${args}` : command.prompt };
    },
  };
}

export function createSkillTool(store: SkillStore): ToolDefinition {
  return {
    name: 'use_skill',
    description: '按名称或 id 读取已启用技能的完整正文；技能摘要见「可用技能」段落。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '技能名称或 id' },
      },
      required: ['name'],
    },
    readOnly: true,
    destructive: false,
    riskLevel: 'low',
    concurrentSafe: true,
    async execute(input: unknown): Promise<ToolResult> {
      const args = isRecord(input) ? input : {};
      const key = typeof args.name === 'string' ? args.name.trim() : '';
      if (!key) return { ok: false, content: '', error: 'name 不能为空' };
      const skill = store.list().find((item) => item.id === key || item.name === key);
      if (!skill) return { ok: false, content: '', error: `未知技能：${key}` };
      if (!skill.enabled) return { ok: false, content: '', error: `技能已禁用：${key}` };
      return { ok: true, content: skill.content };
    },
  };
}
