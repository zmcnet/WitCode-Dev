/**
 * 伙伴槽位注册表：每个会话固定 2 个槽位，可独立启用/禁用、选脑子与模型。
 *
 * 会话之间互不影响；未设置过的会话返回默认槽位（1=profession 启用，2=codex 禁用）。
 */

import { getBrain } from '@witcode/brains';
import type { ModelSelection, PartnerConfig } from '@witcode/protocol';

export interface PartnerRegistry {
  get(sessionId: string): PartnerConfig[];
  set(sessionId: string, partner: PartnerConfig): PartnerConfig[];
  reset(sessionId: string): void;
}

function defaultSlots(): PartnerConfig[] {
  return [
    { slot: 1, enabled: true, brainId: 'profession' },
    { slot: 2, enabled: false, brainId: 'codex' },
  ];
}

/** 返回副本，避免调用方改到注册表内部状态。 */
function clone(partner: PartnerConfig): PartnerConfig {
  return {
    slot: partner.slot,
    enabled: partner.enabled,
    brainId: partner.brainId,
    ...(partner.model ? { model: { ...partner.model } } : {}),
  };
}

export function createPartnerRegistry(): PartnerRegistry {
  const sessions = new Map<string, PartnerConfig[]>();

  return {
    get(sessionId) {
      const stored = sessions.get(sessionId);
      return (stored ?? defaultSlots()).map(clone);
    },

    set(sessionId, partner) {
      if (partner.slot !== 1 && partner.slot !== 2) {
        throw new Error(`非法的伙伴槽位：${String(partner.slot)}（只允许 1 或 2）`);
      }
      if (typeof partner.brainId !== 'string' || !getBrain(partner.brainId)) {
        throw new Error(`未知的伙伴脑子：${String(partner.brainId)}`);
      }
      if (typeof partner.enabled !== 'boolean') {
        throw new Error('伙伴槽位 enabled 必须是布尔值');
      }
      const model = partner.model as ModelSelection | undefined;
      if (
        model !== undefined &&
        (typeof model !== 'object' ||
          model === null ||
          typeof model.providerId !== 'string' ||
          typeof model.model !== 'string')
      ) {
        throw new Error('伙伴模型需要 providerId 和 model 两个字符串');
      }

      const next = (sessions.get(sessionId) ?? defaultSlots()).map(clone);
      next[partner.slot - 1] = clone(partner);
      sessions.set(sessionId, next);
      return next.map(clone);
    },

    reset(sessionId) {
      sessions.delete(sessionId);
    },
  };
}
