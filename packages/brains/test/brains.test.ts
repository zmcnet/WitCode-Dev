import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BrainDefinition } from '@witcode/protocol';
import {
  defaultBrainId,
  getBrain,
  listBrains,
  listOfficialBrains,
  officialBrainIds,
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
  codingBrain,
  standardBrain,
  professionBrain,
} from '../src/index.ts';

const REFERENCE_IDS = [
  'native', 'zcode', 'dsh',
  'opencode', 'pi', 'cline', 'codex', 'goose',
  'herdr', 'hermes', 'autogpt', 'openclaw',
] as const;

const IDS = ['coding', 'standard', 'profession', ...REFERENCE_IDS] as const;

// 用 BrainDefinition 类型接收，下面所有字段访问都由 tsc 校验：
// 拼错字段名或写入契约中不存在的字段都会在 typecheck 阶段报错。
const definitions: readonly BrainDefinition[] = [
  codingBrain, standardBrain, professionBrain,
  nativeBrain, zcodeBrain, dshBrain,
  opencodeBrain, piBrain, clineBrain, codexBrain, gooseBrain,
  herdrBrain, hermesBrain, autogptBrain, openclawBrain,
];

// ---------------------------------------------------------------------------
// 必填字段 / 注册表
// ---------------------------------------------------------------------------

test('15 个 Brain 的必填字段齐全：identity / rules / tools 与摘要字段', () => {
  assert.equal(definitions.length, IDS.length);

  for (const brain of definitions) {
    assert.equal(typeof brain.id, 'string');
    assert.ok(brain.id.length > 0);
    assert.equal(typeof brain.name, 'string');
    assert.ok(brain.name.length > 0);
    assert.equal(typeof brain.description, 'string');
    assert.ok(brain.description.length > 0);
    assert.ok(Array.isArray(brain.bestFor));
    assert.ok(brain.bestFor.length > 0);
    assert.ok(brain.bestFor.every((item) => typeof item === 'string'));

    assert.equal(typeof brain.identity, 'string');
    assert.ok(brain.identity.trim().length > 0);
    assert.ok(Array.isArray(brain.rules));
    assert.ok(brain.rules.length > 0);
    assert.ok(brain.rules.every((rule) => typeof rule === 'string' && rule.length > 0));
    assert.equal(typeof brain.tools, 'object');
    assert.notEqual(brain.tools, null);
  }
});

test('15 个 id 唯一，参照脑集合不变，默认 Brain 为 standard', () => {
  const summary = listBrains();
  const ids = summary.map((item) => item.id);

  assert.equal(ids.length, 15);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual([...ids].sort(), [...IDS].sort());

  const refs = ids.filter((id) => (REFERENCE_IDS as readonly string[]).includes(id));
  assert.deepEqual([...refs].sort(), [...REFERENCE_IDS].sort());

  for (const brain of definitions) {
    assert.strictEqual(getBrain(brain.id), brain);
  }
  assert.equal(getBrain('does-not-exist'), undefined);
  assert.equal(getBrain('witcode'), undefined);

  const defaultId = defaultBrainId();
  assert.equal(defaultId, 'standard');
  assert.ok(getBrain(defaultId));
  assert.ok((officialBrainIds as readonly string[]).includes(defaultId));
});

test('summary 可 JSON 序列化，且返回副本不污染注册表', () => {
  const first = listBrains();
  const roundTrip = JSON.parse(JSON.stringify(first)) as typeof first;
  assert.deepEqual(roundTrip, first);

  const mutated = listBrains();
  const target = mutated[0];
  assert.ok(target);
  target.name = '改坏了';
  target.bestFor.push('额外项');

  const fresh = listBrains();
  assert.notEqual(fresh[0]?.name, '改坏了');
  assert.ok(!fresh[0]?.bestFor.includes('额外项'));
});

// ---------------------------------------------------------------------------
// 官方模式脑
// ---------------------------------------------------------------------------

test('officialBrainIds：三个官方脑顺序正确、全部已注册，listOfficialBrains 与之一致', () => {
  assert.deepEqual([...officialBrainIds], ['coding', 'standard', 'profession']);

  const official = listOfficialBrains();
  assert.equal(official.length, officialBrainIds.length);
  assert.deepEqual(
    official.map((item) => item.id),
    [...officialBrainIds],
  );

  for (const id of officialBrainIds) {
    assert.ok(getBrain(id), `${id} 必须已注册`);
  }

  // 返回副本，不污染注册表。
  const mutated = listOfficialBrains();
  const target = mutated[0];
  assert.ok(target);
  target.name = '改坏了';
  assert.notEqual(listOfficialBrains()[0]?.name, '改坏了');
});

test('三个官方脑：必填字段齐全，rules 至少 8 条，execution 六项完整', () => {
  for (const id of officialBrainIds) {
    const brain = getBrain(id);
    assert.ok(brain, `${id} 不存在`);
    assert.equal(brain.id, id);
    assert.equal(typeof brain.identity, 'string');
    assert.ok(brain.identity.trim().length > 0);
    assert.ok(Array.isArray(brain.bestFor) && brain.bestFor.length > 0);
    assert.ok(brain.rules.length >= 8, `${id} 规则至少 8 条`);
    assert.ok(brain.rules.every((rule) => typeof rule === 'string' && rule.length > 0));

    const execution = brain.execution;
    assert.ok(execution, `${id} 的 execution 必须存在`);
    assert.ok(execution.permission, `${id} 缺少 execution.permission`);
    assert.ok(execution.tool, `${id} 缺少 execution.tool`);
    assert.ok(execution.scheduler, `${id} 缺少 execution.scheduler`);
    assert.ok(execution.verify, `${id} 缺少 execution.verify`);
    assert.ok(execution.compaction, `${id} 缺少 execution.compaction`);
    assert.ok(execution.approval, `${id} 缺少 execution.approval`);
  }
});

test('官方脑执行契约取值：standard 全能 / coding 编码 / profession 严谨', () => {
  const standard = getBrain('standard');
  assert.ok(standard);
  assert.equal(standard.execution?.permission?.preferredMode, 'normal');
  assert.equal(standard.execution?.tool?.contract, 'dsh');
  assert.equal(standard.execution?.scheduler?.parallel, true);
  assert.equal(standard.execution?.scheduler?.maxConcurrent, 4);
  assert.equal(standard.execution?.verify?.afterWrite, 'none');
  assert.equal(standard.execution?.compaction?.strategy, 'acp');
  assert.equal(standard.execution?.approval, 'ask');
  assert.ok(standard.modes?.some((mode) => mode.id === 'plan' && mode.readOnly === true));
  assert.ok(standard.modes?.some((mode) => mode.id === 'guarded'));
  assert.match(standard.prompts?.compact as string, /<summary>/);

  const coding = getBrain('coding');
  assert.ok(coding);
  assert.equal(coding.execution?.permission?.preferredMode, 'normal');
  assert.equal(coding.execution?.tool?.contract, 'zcode');
  assert.equal(coding.execution?.scheduler?.parallel, false);
  assert.equal(coding.execution?.verify?.afterWrite, 'typecheck');
  assert.equal(coding.execution?.compaction?.strategy, 'summary');
  assert.equal(coding.execution?.approval, 'ask');

  const profession = getBrain('profession');
  assert.ok(profession);
  assert.equal(profession.execution?.permission?.preferredMode, 'normal');
  assert.equal(profession.execution?.tool?.contract, 'zcode');
  assert.equal(profession.execution?.scheduler?.parallel, false);
  assert.equal(profession.execution?.verify?.afterWrite, 'test');
  assert.equal(profession.execution?.compaction?.strategy, 'summary');
  assert.equal(profession.execution?.approval, 'fail-closed');
  assert.ok(profession.modes?.some((mode) => mode.id === 'plan' && mode.readOnly === true));
  assert.ok(profession.modes?.some((mode) => mode.id === 'review' && mode.readOnly === true));
});

// ---------------------------------------------------------------------------
// 工具描述
// ---------------------------------------------------------------------------

test('zcode / dsh / standard 的工具描述覆盖读写运行，且写清何时用/何时不用', () => {
  for (const id of ['zcode', 'dsh', 'standard']) {
    const brain = getBrain(id);
    assert.ok(brain);
    const descriptions = brain.tools.descriptions;
    assert.ok(descriptions);

    for (const key of ['read_file', 'write_file', 'grep', 'run_command']) {
      const text: string | undefined = descriptions[key];
      assert.equal(typeof text, 'string', `${id} 缺少 ${key} 描述`);
      assert.match(text as string, /何时用/);
      assert.match(text as string, /何时不用/);
    }
  }
});

// ---------------------------------------------------------------------------
// 关键策略
// ---------------------------------------------------------------------------

test('zcode：工具前置 + summary 压缩 + ask 审批 + GLM 画像', () => {
  const brain = getBrain('zcode');
  assert.ok(brain);
  assert.equal(brain.flow?.tool?.resolveBeforePermission, true);
  assert.equal(brain.flow?.compaction?.strategy, 'summary');
  assert.equal(brain.flow?.approval, 'ask');

  assert.deepEqual(brain.modelProfile?.preferredModels, ['glm-*']);
  assert.equal(brain.modelProfile?.reasoning, 'separate');
  assert.equal(brain.modelProfile?.cache, 'prefix');
  assert.equal(brain.modelProfile?.emptyResponseRetry, true);
});

test('dsh：工具前置 + acp 压缩 + fail-closed 审批 + DeepSeek 画像', () => {
  const brain = getBrain('dsh');
  assert.ok(brain);
  assert.equal(brain.flow?.tool?.resolveBeforePermission, true);
  assert.equal(brain.flow?.compaction?.strategy, 'acp');
  assert.equal(brain.flow?.approval, 'fail-closed');

  assert.deepEqual(brain.modelProfile?.preferredModels, ['deepseek-*']);
  assert.equal(brain.modelProfile?.reasoning, 'separate');
  assert.equal(brain.modelProfile?.toolCallFormat, 'anthropic');
  assert.equal(brain.modelProfile?.cache, 'prefix');
  assert.equal(brain.modelProfile?.emptyResponseRetry, true);
});

// ---------------------------------------------------------------------------
// 模式与压缩模板
// ---------------------------------------------------------------------------

test('模式：zcode 的 plan 只读、guarded 先问；dsh 的 plan/goal 为软正文', () => {
  const zcode = getBrain('zcode');
  assert.ok(zcode);
  const zcodePlan = zcode.modes?.find((mode) => mode.id === 'plan');
  assert.ok(zcodePlan);
  assert.equal(zcodePlan.readOnly, true);
  assert.ok(zcode.modes?.some((mode) => mode.id === 'guarded'));

  const dsh = getBrain('dsh');
  assert.ok(dsh);
  const dshPlan = dsh.modes?.find((mode) => mode.id === 'plan');
  const dshGoal = dsh.modes?.find((mode) => mode.id === 'goal');
  assert.ok(dshPlan);
  assert.ok(dshGoal);
  assert.match(dshPlan.prompt, /软/);
  assert.match(dshGoal.prompt, /续轮/);
  assert.match(dshGoal.prompt, /阻塞/);
});

test('压缩提示词保留各自的结构标记与约束', () => {
  const zcode = getBrain('zcode');
  assert.ok(zcode);
  assert.match(zcode.prompts?.compact as string, /<analysis>/);
  assert.match(zcode.prompts?.compact as string, /<summary>/);

  const dsh = getBrain('dsh');
  assert.ok(dsh);
  const compact = dsh.prompts?.compact as string;
  assert.match(compact, /\(none\)/);
  assert.match(compact, /<compacted-summary>/);
  assert.match(compact, /原样保留/);
  assert.match(compact, /不要提本次摘要请求/);
});

// ---------------------------------------------------------------------------
// 新增 9 个 Brain 抽查
// ---------------------------------------------------------------------------

test('新增 Brain 抽查：opencode 的多模型画像与压缩策略', () => {
  const brain = getBrain('opencode');
  assert.ok(brain);
  assert.deepEqual(brain.modelProfile?.preferredModels, [
    'gpt-*', 'claude-*', 'kimi*', 'trinity*', 'muse*',
  ]);
  assert.equal(brain.modelProfile?.reasoning, 'separate');
  assert.equal(brain.modelProfile?.toolCallFormat, 'anthropic');
  assert.equal(brain.modelProfile?.cache, 'prefix');
  assert.equal(brain.modelProfile?.emptyResponseRetry, true);
  assert.equal(brain.flow?.compaction?.strategy, 'summary');
  assert.equal(brain.flow?.approval, 'ask');
});

test('新增 Brain 抽查：cline 的 plan 只读与三态模式', () => {
  const brain = getBrain('cline');
  assert.ok(brain);
  const plan = brain.modes?.find((mode) => mode.id === 'plan');
  assert.ok(plan);
  assert.equal(plan.readOnly, true);
  assert.ok(brain.modes?.some((mode) => mode.id === 'act'));
  assert.ok(brain.modes?.some((mode) => mode.id === 'yolo'));
});

test('新增 Brain 抽查：codex 的审批与并发策略', () => {
  const brain = getBrain('codex');
  assert.ok(brain);
  assert.equal(brain.flow?.approval, 'ask');
  assert.equal(brain.flow?.tool?.resolveBeforePermission, true);
  assert.equal(brain.flow?.tool?.parallel, true);
  assert.equal(brain.flow?.tool?.maxConcurrent, 10);
  assert.equal(brain.flow?.compaction?.failureLimit, 3);
  assert.equal(brain.modelProfile?.emptyResponseRetry, false);
});

test('autogpt：identity/rules 为中文重写，不含参照原文长句', () => {
  const brain = getBrain('autogpt');
  assert.ok(brain);
  assert.match(brain.identity, /[\u4e00-\u9fa5]/);
  assert.doesNotMatch(brain.identity, /You are|IMPORTANT:|You must/);
  for (const rule of brain.rules) {
    assert.doesNotMatch(rule, /You are|IMPORTANT:|You must/);
  }
});
