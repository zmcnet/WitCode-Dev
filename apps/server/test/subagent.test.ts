import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import type {
  ModelChunk,
  ModelProvider,
  SessionStore,
  ToolContext,
  ToolDefinition,
  ToolResult,
  ToolService,
} from '@witcode/protocol';
import { createSqliteSessionStore } from '@witcode/session';

import { createSubagentService } from '../src/subagent.ts';
import { subagentTool } from '../src/subagent-tool.ts';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'witcode-subagent-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  // Windows 下 SQLite 仍持有文件句柄，删除失败可忽略；目录位于系统临时区。
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function storeIn(dir: string): SessionStore {
  return createSqliteSessionStore({ dbPath: join(dir, 'witcode.db') });
}

/** 按调用次数给剧本：第 0 轮可以吐工具调用，之后只吐文本，避免死循环。 */
function fakeProvider(
  script: ModelChunk[] | ((callIndex: number) => ModelChunk[]),
  failure?: string,
): ModelProvider {
  let index = 0;
  return {
    id: 'fake',
    async *stream() {
      if (failure) throw new Error(failure);
      const chunks = typeof script === 'function' ? script(index++) : script;
      for (const chunk of chunks) yield chunk;
    },
  };
}

function fakeTools(definitions: ToolDefinition[]): ToolService {
  return {
    register: () => () => {},
    list: () => definitions,
    async run(name, input, ctx) {
      const tool = definitions.find((item) => item.name === name);
      if (!tool) return { ok: false, content: '', error: `unknown tool: ${name}` };
      return tool.execute(input, ctx);
    },
  };
}

function stubTool(name: string, execute: ToolDefinition['execute']): ToolDefinition {
  return {
    name,
    description: name,
    inputSchema: { type: 'object' },
    riskLevel: 'low',
    execute,
  };
}

test('正常 spawn 返回 done 与输出，并透传文本事件', async () => {
  const dir = tempDir();
  const sessions = storeIn(dir);
  const provider = fakeProvider([
    { type: 'text', text: '已完成补丁' },
    { type: 'done' },
  ]);
  const service = createSubagentService({ provider, tools: fakeTools([]), sessions, workspace: dir });
  const events: string[] = [];

  const result = await service.spawn({
    task: '给本次改动补测试',
    onEvent: (event) => events.push(event.text),
  });

  assert.equal(result.status, 'done');
  assert.equal(result.output, '已完成补丁');
  assert.deepEqual(result.filesChanged, []);
  assert.deepEqual(events, ['已完成补丁']);
  assert.equal(service.remaining(), 2);
});

test('子 session 被创建，标题带层级前缀并落任务与最终回答', async () => {
  const dir = tempDir();
  const sessions = storeIn(dir);
  const provider = fakeProvider([{ type: 'text', text: '结论' }]);
  const service = createSubagentService({ provider, tools: fakeTools([]), sessions, workspace: dir });

  const result = await service.spawn({ task: '检查类型错误' });
  const record = await sessions.get(result.id);

  assert.ok(record);
  assert.equal(record.title, '子任务[L0]:检查类型错误');
  assert.deepEqual(
    record.messages.map((message) => message.role),
    ['user', 'assistant'],
  );
  assert.equal(record.messages[0]?.content, '检查类型错误');
  assert.equal(record.messages[1]?.content, '结论');
});

test('超过 maxSubagents 抛错', async () => {
  const dir = tempDir();
  const sessions = storeIn(dir);
  const provider = fakeProvider([{ type: 'text', text: 'ok' }]);
  const service = createSubagentService({
    provider,
    tools: fakeTools([]),
    sessions,
    workspace: dir,
    maxSubagents: 1,
  });

  await service.spawn({ task: '第一件' });
  assert.equal(service.remaining(), 0);
  await assert.rejects(() => service.spawn({ task: '第二件' }), /上限/);
});

test('provider 抛错时返回 failed，不抛给主智能体', async () => {
  const dir = tempDir();
  const sessions = storeIn(dir);
  const provider = fakeProvider([], '模型不可用');
  const service = createSubagentService({ provider, tools: fakeTools([]), sessions, workspace: dir });

  const result = await service.spawn({ task: '会失败的任务' });

  assert.equal(result.status, 'failed');
  assert.match(result.output, /模型不可用/);
  assert.deepEqual(result.filesChanged, []);
  const record = await sessions.get(result.id);
  assert.deepEqual(
    record?.messages.map((message) => message.role),
    ['user'],
  );
});

test('深度上限 3 层：depth>=3 拒绝，子 loop 拿到 depth+1', async () => {
  const dir = tempDir();
  const sessions = storeIn(dir);
  const depths: Array<number | undefined> = [];
  const tools = fakeTools([
    stubTool('probe', async (_input, ctx: ToolContext) => {
      depths.push(ctx.depth);
      return { ok: true, content: '' };
    }),
  ]);
  const provider = fakeProvider((callIndex) =>
    callIndex === 0
      ? [{ type: 'tool-call', call: { id: '1', name: 'probe', input: {} } }]
      : [{ type: 'text', text: 'ok' }],
  );
  const service = createSubagentService({
    provider,
    tools,
    sessions,
    workspace: dir,
    maxSubagents: 5,
  });

  const result = await service.spawn({ task: '第三层', depth: 2 });
  assert.equal(result.status, 'done');
  assert.deepEqual(depths, [3]);

  await assert.rejects(() => service.spawn({ task: '第四层', depth: 3 }), /最多 3 层/);
});

test('tools allowlist 只放行列出的工具，且粗提变更文件', async () => {
  const dir = tempDir();
  const sessions = storeIn(dir);
  let writeRan = false;
  const tools = fakeTools([
    stubTool('read_file', async () => ({ ok: true, content: 'read' })),
    stubTool('write_file', async () => {
      writeRan = true;
      return { ok: true, content: 'Wrote 3 bytes to src/x.ts' };
    }),
  ]);
  const makeProvider = () =>
    fakeProvider((callIndex) =>
      callIndex === 0
        ? [
            {
              type: 'tool-call',
              call: { id: '1', name: 'write_file', input: { path: 'src/x.ts', content: 'abc' } },
            },
          ]
        : [{ type: 'text', text: 'ok' }],
    );
  const makeService = () =>
    createSubagentService({ provider: makeProvider(), tools, sessions, workspace: dir });

  const blocked = await makeService().spawn({ task: '越权写文件', tools: ['read_file'] });
  assert.equal(blocked.status, 'done');
  assert.equal(writeRan, false);
  assert.deepEqual(blocked.filesChanged, []);

  const allowed = await makeService().spawn({ task: '允许写文件', tools: ['write_file'] });
  assert.equal(allowed.status, 'done');
  assert.equal(writeRan, true);
  assert.deepEqual(allowed.filesChanged, ['src/x.ts']);
});

test('spawn_subagent 工具：元数据正确、task 非空校验、结果回填', async () => {
  const dir = tempDir();
  const sessions = storeIn(dir);
  const provider = fakeProvider([{ type: 'text', text: '子任务结果' }]);
  const service = createSubagentService({ provider, tools: fakeTools([]), sessions, workspace: dir });
  const tool = subagentTool(service);

  assert.equal(tool.name, 'spawn_subagent');
  assert.equal(tool.destructive, false);
  assert.equal(tool.riskLevel, 'low');
  assert.equal(tool.concurrentSafe, false);

  const ctx = { workspace: dir };
  for (const bad of [{}, { task: '   ' }, { task: 42 }]) {
    const result: ToolResult = await tool.execute(bad, ctx);
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /task/);
  }

  const good = await tool.execute({ task: '做一件事' }, ctx);
  assert.equal(good.ok, true);
  assert.equal(good.content, '子任务结果');
});
