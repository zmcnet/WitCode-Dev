/**
 * 根据当前 Brain 组装 system prompt。
 *
 * 分层：
 * - identity：人格与工作法（稳定）
 * - rules：硬规则
 * - context.sections：Brain 自带的固定段落
 * - 项目记忆：自动扫描 + 历史笔记
 *
 * 注意：这里不做“公告只追加”的缓存优化；那是下一步（L2 缓存插槽）。
 */

import type { BrainDefinition } from '@witcode/protocol';
import type { ProjectMemory } from './project-memory.js';

export function buildSystemPrompt(brain: BrainDefinition, memory: ProjectMemory): string {
  const parts: string[] = [];

  parts.push(brain.identity.trim());

  if (brain.rules.length > 0) {
    parts.push(['## 硬规则', ...brain.rules.map((rule) => `- ${rule}`)].join('\n'));
  }

  for (const section of brain.context?.sections ?? []) {
    parts.push(`## ${section.title}\n\n${section.content.trim()}`);
  }

  if (brain.context?.projectMemory !== false && memory.context) {
    parts.push(memory.context);
  }

  const text = parts.filter((part) => part.trim().length > 0).join('\n\n');
  // system prompt 预算 200K token（按 chars/4 估算约 800K 字符）；多了也不用。
  const MAX_SYSTEM_CHARS = 800_000;
  if (text.length <= MAX_SYSTEM_CHARS) return text;
  return `${text.slice(0, MAX_SYSTEM_CHARS)}\n\n（system prompt 超出 200K token 预算，已截断）`;
}
