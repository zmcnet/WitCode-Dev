import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getBrain } from '@witcode/brains';
import type {
  ChatMessage,
  ModelProvider,
  ModelRequest,
  ModelSelection,
  ToolContext,
  ToolDefinition,
  ToolService,
} from '@witcode/protocol';
import { createPartnerService } from '../src/partner.ts';
import { partnerTool } from '../src/partner-tool.ts';
import { createPartnerRegistry, type PartnerRegistry } from '../src/partner-registry.ts';

function makeProvider(text: string, onRequest?: (request: ModelRequest) => void): ModelProvider {
  return {
    id: 'fake-partner-provider',
    async *stream(request) {
      onRequest?.(request);
      yield { type: 'text', text };
      yield { type: 'done', usage: { input: 1, output: 1 } };
    },
  };
}

interface FakeTools extends ToolService {
  runs: Array<{ name: string; input: unknown }>;
}

function makeTools(): FakeTools {
  const defs: ToolDefinition[] = [
    {
      name: 'read_file',
      description: 'read',
      inputSchema: { type: 'object' },
      readOnly: true,
      async execute() {
        return { ok: true, content: 'file content' };
      },
    },
    {
      name: 'write_file',
      description: 'write',
      inputSchema: { type: 'object' },
      async execute() {
        return { ok: true, content: 'written' };
      },
    },
    {
      name: 'run_command',
      description: 'run',
      inputSchema: { type: 'object' },
      async execute() {
        return { ok: true, content: 'ran' };
      },
    },
  ];

  const runs: Array<{ name: string; input: unknown }> = [];
  return {
    runs,
    register() {
      return () => {};
    },
    list() {
      return [...defs];
    },
    async run(name, input) {
      runs.push({ name, input });
      const def = defs.find((item) => item.name === name);
      if (!def) return { ok: false, content: '', error: `unknown tool: ${name}` };
      return def.execute(input, { workspace: '/tmp' });
    },
  };
}

const ctx: ToolContext = { workspace: '/tmp' };

function serviceWithRegistry(
  registry: PartnerRegistry,
  onRequest?: (request: ModelRequest) => void,
) {
  return createPartnerService({
    provider: makeProvider('ok', onRequest),
    tools: makeTools(),
    workspace: '/tmp',
    registry,
  });
}

function systemOf(request: ModelRequest): string {
  return request.messages.find((item) => item.role === 'system')?.content ?? '';
}

// ---------------------------------------------------------------------------
// 原有行为：consult 基础链路
// ---------------------------------------------------------------------------

test('consult：正常咨询返回文本并扣减次数', async () => {
  const service = createPartnerService({
    provider: makeProvider('这是伙伴的意见'),
    tools: makeTools(),
    workspace: '/tmp',
  });

  const result = await service.consult({ brainId: 'profession', question: '审查一下方案' });

  assert.equal(result.brainId, 'profession');
  assert.equal(result.answer, '这是伙伴的意见');
  assert.equal(service.remaining(), 4);
});

test('consult：未知的 brainId 抛错且不扣次数', async () => {
  const service = createPartnerService({
    provider: makeProvider('x'),
    tools: makeTools(),
    workspace: '/tmp',
  });

  await assert.rejects(
    () => service.consult({ brainId: 'does-not-exist', question: 'q' }),
    /未知的伙伴脑子/,
  );
  assert.equal(service.remaining(), 5);
});

test('consult：超过 maxConsults 抛错', async () => {
  const service = createPartnerService({
    provider: makeProvider('ok'),
    tools: makeTools(),
    workspace: '/tmp',
    maxConsults: 1,
  });

  assert.equal((await service.consult({ brainId: 'coding', question: 'one' })).answer, 'ok');
  assert.equal(service.remaining(), 0);
  await assert.rejects(
    () => service.consult({ brainId: 'coding', question: 'two' }),
    /伙伴咨询次数已用完/,
  );
});

test('consult：传给 runAgentLoop 的工具列表只有只读工具', async () => {
  let names: string[] = [];
  const service = createPartnerService({
    provider: makeProvider('ok', (request) => {
      names = (request.tools ?? []).map((tool) => tool.name);
    }),
    tools: makeTools(),
    workspace: '/tmp',
  });

  await service.consult({ brainId: 'profession', question: 'q' });

  assert.deepEqual(names, ['read_file']);
});

test('consult：模型点名写工具也被只读视图拒绝', async () => {
  let step = 0;
  const provider: ModelProvider = {
    id: 'fake-tool-call',
    async *stream() {
      if (step++ === 0) {
        yield { type: 'tool-call', call: { id: 'c1', name: 'write_file', input: { path: 'x' } } };
      } else {
        yield { type: 'text', text: '我不能写文件' };
      }
    },
  };
  const tools = makeTools();
  const service = createPartnerService({ provider, tools, workspace: '/tmp' });

  const result = await service.consult({ brainId: 'profession', question: 'q' });

  assert.equal(result.answer, '我不能写文件');
  assert.deepEqual(tools.runs, []);
});

test('consult：完整转发 history 内容，并始终使用伙伴自己的 system', async () => {
  const history: ChatMessage[] = [
    { role: 'user', content: '第一条用户消息' },
    { role: 'assistant', content: '第一条助手回复' },
    { role: 'tool', content: '工具结果', toolCallId: 't1', toolName: 'read_file' },
  ];
  let received: ChatMessage[] = [];
  const service = createPartnerService({
    provider: makeProvider('ok', (request) => {
      received = [...request.messages];
    }),
    tools: makeTools(),
    workspace: '/tmp',
  });

  await service.consult({ brainId: 'profession', question: '请审查', history });

  assert.equal(received.length, history.length + 2);
  assert.deepEqual(received.slice(1, -1), history);
  assert.deepEqual(received[received.length - 1], { role: 'user', content: '请审查' });
  assert.equal(received[0]?.role, 'system');
  const brain = getBrain('profession');
  assert.ok(brain);
  assert.ok((received[0]?.content ?? '').includes(brain.identity.trim()));
});

test('consult：history 里的 system 被替换为伙伴自己的 system', async () => {
  const history: ChatMessage[] = [
    { role: 'system', content: '主会话系统提示' },
    { role: 'user', content: 'u' },
  ];
  let received: ChatMessage[] = [];
  const service = createPartnerService({
    provider: makeProvider('ok', (request) => {
      received = [...request.messages];
    }),
    tools: makeTools(),
    workspace: '/tmp',
  });

  await service.consult({ brainId: 'profession', question: '请审查', history });

  const systems = received.filter((item) => item.role === 'system');
  assert.equal(systems.length, 1);
  assert.ok(!(systems[0]?.content ?? '').includes('主会话系统提示'));
  assert.ok((systems[0]?.content ?? '').includes('伙伴'));
  // 非 system 内容（对话）仍然保留
  assert.ok(received.some((item) => item.role === 'user' && item.content === 'u'));
  assert.deepEqual(received[received.length - 1], { role: 'user', content: '请审查' });
});

// ---------------------------------------------------------------------------
// 槽位注册表
// ---------------------------------------------------------------------------

test('registry：默认两个槽位，会话之间互不影响', () => {
  const registry = createPartnerRegistry();
  assert.deepEqual(registry.get('s1'), [
    { slot: 1, enabled: true, brainId: 'profession' },
    { slot: 2, enabled: false, brainId: 'codex' },
  ]);

  registry.set('s1', { slot: 2, enabled: true, brainId: 'coding' });
  assert.deepEqual(registry.get('s2'), [
    { slot: 1, enabled: true, brainId: 'profession' },
    { slot: 2, enabled: false, brainId: 'codex' },
  ]);
});

test('registry：set 生效并返回最新两个槽位，reset 恢复默认', () => {
  const registry = createPartnerRegistry();
  const model: ModelSelection = { providerId: 'p1', model: 'm1' };
  const next = registry.set('s1', { slot: 2, enabled: true, brainId: 'coding', model });

  assert.equal(next.length, 2);
  assert.deepEqual(next[0], { slot: 1, enabled: true, brainId: 'profession' });
  assert.deepEqual(next[1], { slot: 2, enabled: true, brainId: 'coding', model });
  assert.deepEqual(registry.get('s1'), next);

  // 外部改返回值不影响注册表内部状态
  const snapshot = registry.get('s1');
  if (snapshot[0]) snapshot[0].brainId = 'mutated';
  assert.equal(registry.get('s1')[0]?.brainId, 'profession');

  registry.reset('s1');
  assert.equal(registry.get('s1')[1]?.enabled, false);
});

test('registry：非法 slot 与未知 brainId 报错，且不污染已有状态', () => {
  const registry = createPartnerRegistry();

  assert.throws(
    () => registry.set('s1', { slot: 3 as 1 | 2, enabled: true, brainId: 'coding' }),
    /非法的伙伴槽位/,
  );
  assert.throws(
    () => registry.set('s1', { slot: 1, enabled: true, brainId: 'does-not-exist' }),
    /未知的伙伴脑子/,
  );
  assert.deepEqual(registry.get('s1'), [
    { slot: 1, enabled: true, brainId: 'profession' },
    { slot: 2, enabled: false, brainId: 'codex' },
  ]);
});

// ---------------------------------------------------------------------------
// consult 槽位规则
// ---------------------------------------------------------------------------

test('consult：按 slot 咨询使用对应槽位的脑子', async () => {
  const registry = createPartnerRegistry();
  registry.set('s1', { slot: 2, enabled: true, brainId: 'coding' });
  let system = '';
  const service = serviceWithRegistry(registry, (request) => {
    system = systemOf(request);
  });

  const slot2 = await service.consult({ sessionId: 's1', slot: 2, question: 'q' });
  assert.equal(slot2.brainId, 'coding');
  assert.ok(system.includes(getBrain('coding')?.identity.trim() ?? ''));

  const slot1 = await service.consult({ sessionId: 's1', slot: 1, question: 'q' });
  assert.equal(slot1.brainId, 'profession');
});

test('consult：槽位禁用时拒绝且不扣咨询次数', async () => {
  const service = serviceWithRegistry(createPartnerRegistry());
  await assert.rejects(
    () => service.consult({ sessionId: 's1', slot: 2, question: 'q' }),
    /伙伴槽位 2 未启用/,
  );
  assert.equal(service.remaining(), 5);
});

test('consult：两个槽位都禁用时，临时 brainId 与默认咨询都拒绝', async () => {
  const registry = createPartnerRegistry();
  registry.set('s1', { slot: 1, enabled: false, brainId: 'profession' });
  const service = serviceWithRegistry(registry);

  await assert.rejects(
    () => service.consult({ sessionId: 's1', brainId: 'codex', question: 'q' }),
    /本会话没有启用伙伴/,
  );
  await assert.rejects(
    () => service.consult({ sessionId: 's1', question: 'q' }),
    /本会话没有启用伙伴/,
  );
});

test('consult：临时 brainId 单次生效，不改会话槽位', async () => {
  const registry = createPartnerRegistry();
  const service = serviceWithRegistry(registry);

  const result = await service.consult({ sessionId: 's1', brainId: 'codex', question: 'q' });
  assert.equal(result.brainId, 'codex');
  assert.deepEqual(registry.get('s1'), [
    { slot: 1, enabled: true, brainId: 'profession' },
    { slot: 2, enabled: false, brainId: 'codex' },
  ]);

  const viaSlot = await service.consult({ sessionId: 's1', slot: 1, question: 'q' });
  assert.equal(viaSlot.brainId, 'profession');
});

test('consult：模型优先级为入参 > 槽位 > 主会话（不传 selection）', async () => {
  const registry = createPartnerRegistry();
  const slotModel: ModelSelection = { providerId: 'slot-p', model: 'slot-m' };
  registry.set('s1', { slot: 1, enabled: true, brainId: 'profession', model: slotModel });

  const seen: Array<ModelSelection | undefined> = [];
  const service = createPartnerService({
    provider: makeProvider('ok', (request) => seen.push(request.selection)),
    tools: makeTools(),
    workspace: '/tmp',
    registry,
  });

  await service.consult({ sessionId: 's1', slot: 1, question: 'q' });
  assert.deepEqual(seen[0], slotModel);

  const tmpModel: ModelSelection = { providerId: 'tmp-p', model: 'tmp-m' };
  await service.consult({ sessionId: 's1', slot: 1, question: 'q', model: tmpModel });
  assert.deepEqual(seen[1], tmpModel);

  // 清掉槽位模型：不传 selection，由网关注入主会话模型。
  registry.set('s1', { slot: 1, enabled: true, brainId: 'profession' });
  await service.consult({ sessionId: 's1', slot: 1, question: 'q' });
  assert.equal(seen[2], undefined);
});

// ---------------------------------------------------------------------------
// consult_partner 工具
// ---------------------------------------------------------------------------

test('consult_partner：execute 校验参数并映射成功/失败结果', async () => {
  const service = createPartnerService({
    provider: makeProvider('伙伴答复'),
    tools: makeTools(),
    workspace: '/tmp',
  });
  const tool = partnerTool(service);

  assert.equal(tool.name, 'consult_partner');
  assert.equal(tool.readOnly, true);
  assert.equal(tool.riskLevel, 'low');
  assert.equal(tool.concurrentSafe, true);

  const missingQuestion = await tool.execute({ brainId: 'profession' }, ctx);
  assert.equal(missingQuestion.ok, false);
  assert.match(missingQuestion.error ?? '', /question/);

  const badShape = await tool.execute(null, ctx);
  assert.equal(badShape.ok, false);

  const unknownBrain = await tool.execute({ brainId: 'nope', question: 'q' }, ctx);
  assert.equal(unknownBrain.ok, false);
  assert.match(unknownBrain.error ?? '', /未知的伙伴脑子/);

  const good = await tool.execute({ brainId: 'profession', question: '审查方案' }, ctx);
  assert.deepEqual(good, { ok: true, content: '伙伴答复' });
});

test('consult_partner：按 slot 透传并把禁用/无伙伴错误写进 error', async () => {
  const registry = createPartnerRegistry();
  registry.set('s1', { slot: 2, enabled: true, brainId: 'coding' });
  registry.set('s2', { slot: 1, enabled: false, brainId: 'profession' });
  let system = '';
  const service = serviceWithRegistry(registry, (request) => {
    system = systemOf(request);
  });
  const tool = partnerTool(service);

  const good = await tool.execute({ slot: 2, question: 'q' }, { workspace: '/tmp', sessionId: 's1' });
  assert.equal(good.ok, true);
  assert.ok(system.includes(getBrain('coding')?.identity.trim() ?? ''));

  const disabled = await tool.execute(
    { slot: 1, question: 'q' },
    { workspace: '/tmp', sessionId: 's2' },
  );
  assert.equal(disabled.ok, false);
  assert.match(disabled.error ?? '', /伙伴槽位 1 未启用/);

  const noPartner = await tool.execute(
    { brainId: 'codex', question: 'q' },
    { workspace: '/tmp', sessionId: 's2' },
  );
  assert.equal(noPartner.ok, false);
  assert.match(noPartner.error ?? '', /本会话没有启用伙伴/);
});

test('consult_partner：slot/brainId 至少一个，model 形状校验，schema 声明完整', async () => {
  const tool = partnerTool(
    createPartnerService({ provider: makeProvider('ok'), tools: makeTools(), workspace: '/tmp' }),
  );
  const schema = tool.inputSchema as {
    required?: string[];
    anyOf?: unknown[];
    properties?: Record<string, { enum?: number[] }>;
  };
  assert.deepEqual(schema.required, ['question']);
  assert.deepEqual(schema.properties?.slot?.enum, [1, 2]);
  assert.ok(schema.properties?.model);
  assert.ok(schema.anyOf);

  assert.match((await tool.execute({ question: 'q' }, ctx)).error ?? '', /slot 或 brainId/);
  assert.match(
    (await tool.execute({ slot: 3, question: 'q' }, ctx)).error ?? '',
    /slot 只能是 1 或 2/,
  );
  assert.match(
    (await tool.execute({ slot: 1, question: 'q', model: { providerId: 'p' } }, ctx)).error ?? '',
    /model 需要 providerId 和 model/,
  );
});
