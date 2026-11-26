import type { BrainSummary } from '@witcode/protocol';

/** 三个官方模式的副标题；协议只下发 id 列表，展示文案由前端固定。 */
export const OFFICIAL_MODE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  coding: '编码专精：先读再改、小步验证',
  standard: '全能：规划、执行、交付',
  profession: '专业严谨：证据优先、边界优先',
};

export interface BrainGroups {
  official: BrainSummary[];
  custom: BrainSummary[];
}

/**
 * 按服务端下发的 official 顺序拆成「官方模式 / 参照大脑」两组。
 * official 缺失时全部归入 custom，界面降级为原来的单列表。
 */
export function splitBrains(brains: BrainSummary[], official?: readonly string[]): BrainGroups {
  const ids = new Set(official ?? []);
  const seen = new Set<string>();
  const groups: BrainGroups = { official: [], custom: [] };
  for (const id of official ?? []) {
    if (seen.has(id)) continue;
    seen.add(id);
    const brain = brains.find((item) => item.id === id);
    if (brain) groups.official.push(brain);
  }
  for (const brain of brains) {
    if (!ids.has(brain.id)) groups.custom.push(brain);
  }
  return groups;
}

/** 官方模式用固定副标题，参照大脑沿用服务端描述。 */
export function brainDescription(brain: BrainSummary, officialIds: readonly string[]): string {
  return officialIds.includes(brain.id)
    ? OFFICIAL_MODE_DESCRIPTIONS[brain.id] ?? brain.description
    : brain.description;
}
