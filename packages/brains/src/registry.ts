import type { BrainDefinition, BrainSummary } from '@witcode/protocol';
import { nativeBrain } from './native.ts';
import { zcodeBrain } from './zcode.ts';
import { dshBrain } from './dsh.ts';
import { opencodeBrain } from './opencode.ts';
import { piBrain } from './pi.ts';
import { clineBrain } from './cline.ts';
import { codexBrain } from './codex.ts';
import { gooseBrain } from './goose.ts';
import { herdrBrain } from './herdr.ts';
import { hermesBrain } from './hermes.ts';
import { autogptBrain } from './autogpt.ts';
import { openclawBrain } from './openclaw.ts';
import { codingBrain } from './coding.ts';
import { standardBrain } from './standard.ts';
import { professionBrain } from './profession.ts';

const DEFAULT_BRAIN_ID = 'standard';

/** 三个 WitCode 官方模式脑，顺序即 UI 分组展示顺序；第四种「自定义」是 UI 入口，不是 Brain。 */
export const officialBrainIds = ['coding', 'standard', 'profession'] as const;

const brains: BrainDefinition[] = [
  codingBrain,
  standardBrain,
  professionBrain,
  nativeBrain,
  zcodeBrain,
  dshBrain,
  opencodeBrain,
  piBrain,
  clineBrain,
  codexBrain,
  gooseBrain,
  herdrBrain,
  hermesBrain,
  autogptBrain,
  openclawBrain,
];

/** 运行时注册的 Brain（数据型插件）；卸载时移除。 */
const customBrains = new Map<string, BrainDefinition>();

/** 注册一个外部 Brain；返回撤销函数。id 冲突直接拒绝。 */
export function registerBrain(brain: BrainDefinition): () => void {
  if (!brain.id || !brain.name || !brain.identity) {
    throw new Error('Brain 需要非空的 id / name / identity');
  }
  if (getBrain(brain.id)) {
    throw new Error(`Brain id 已存在：${brain.id}`);
  }
  customBrains.set(brain.id, brain);
  return () => {
    customBrains.delete(brain.id);
  };
}

/** 卸载运行时 Brain；内置 Brain 不允许卸载。 */
export function unregisterBrain(id: string): boolean {
  return customBrains.delete(id);
}

/** 展示用摘要；每次返回新对象，避免调用方改到注册表内部。 */
export function listBrains(): BrainSummary[] {
  return [...brains, ...customBrains.values()].map((brain) => ({
    id: brain.id,
    name: brain.name,
    description: brain.description,
    bestFor: [...brain.bestFor],
  }));
}

/** 只返回官方模式脑的摘要，供 UI 前三个模式分组使用。 */
export function listOfficialBrains(): BrainSummary[] {
  return officialBrainIds
    .map((id) => getBrain(id))
    .filter((brain): brain is BrainDefinition => brain !== undefined)
    .map((brain) => ({
      id: brain.id,
      name: brain.name,
      description: brain.description,
      bestFor: [...brain.bestFor],
    }));
}

export function getBrain(id: string): BrainDefinition | undefined {
  return customBrains.get(id) ?? brains.find((brain) => brain.id === id);
}

export function defaultBrainId(): string {
  return DEFAULT_BRAIN_ID;
}
