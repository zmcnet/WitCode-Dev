import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatMessage, ToolContext } from '@witcode/protocol';
import {
  createContextManager,
  contextTools,
  fromCoreMessages,
  toCoreMessages,
  type ContextChatMessage,
  type ContextState,
  type ContextStateStore,
} from '../src/index.ts';

const toolCtx: ToolContext = { workspace: process.cwd() };

class MemoryStore implements ContextStateStore {
  readonly states = new Map<string, ContextState>();

  async get(sessionId: string): Promise<ContextState | null> {
    return this.states.get(sessionId) ?? null;
  }
  async set(sessionId: string, state: ContextState): Promise<void> {
    this.states.set(sessionId, state);
  }
  async delete(sessionId: string): Promise<void> {
    this.states.delete(sessionId);
  }
}

test('conversion roundtrip preserves role, tool call, toolCallId and reasoning', () => {
  const messages: ContextChatMessage[] = [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'read a.txt' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call-1', name: 'read_file', input: { path: 'a.txt' } }],
    },
    { role: 'tool', content: 'file body', toolCallId: 'call-1', toolName: 'read_file' },
    {
      role: 'assistant',
      content: 'done',
      reasoning: 'The file contains the answer.',
      toolCalls: [{ id: 'call-2', name: 'write_file', input: { path: 'b.txt', content: 'x' } }],
    },
  ];

  const cores = toCoreMessages(messages);
  assert.deepEqual(
    cores.map((core) => core.contentType),
    ['text', 'text', 'tool-call', 'tool-result', 'reasoning', 'text', 'tool-call'],
  );
  assert.equal(new Set(cores.map((core) => core.id)).size, cores.length);
  const callCore = cores[2]!;
  assert.equal(callCore.role, 'assistant');
  assert.equal(callCore.toolName, 'read_file');
  assert.equal(callCore.toolCallId, 'call-1');
  const resultCore = cores[3]!;
  assert.equal(resultCore.role, 'tool');
  assert.equal(resultCore.toolName, 'read_file');
  assert.equal(resultCore.toolCallId, 'call-1');
  assert.equal(cores[4]!.contentType, 'reasoning');

  const back = fromCoreMessages(cores);
  assert.equal(back.length, messages.length);
  assert.deepEqual(back[0], messages[0]);
  assert.deepEqual(back[1], messages[1]);
  assert.deepEqual(back[2]!.toolCalls, messages[2]!.toolCalls);
  assert.deepEqual(back[3], messages[3]);
  assert.equal((back[4] as ContextChatMessage).reasoning, 'The file contains the answer.');
  assert.equal(back[4]!.content, 'done');
  assert.deepEqual(back[4]!.toolCalls, messages[4]!.toolCalls);
});

test('off mode returns messages unchanged and registers no tools', async () => {
  const manager = createContextManager({ mode: 'off' });
  const messages: ChatMessage[] = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'hello' },
  ];
  const result = await manager.beforeRequest('off-session', messages);
  assert.deepEqual(result.messages, messages);
  assert.equal(result.nudge, undefined);
  assert.deepEqual(contextTools(manager), []);
});

test('summary mode keeps the most recent N messages and summarizes the rest', async () => {
  const summarized: ChatMessage[][] = [];
  const manager = createContextManager({
    mode: 'summary',
    keepRecent: 5,
    async summarize(messages) {
      summarized.push(messages);
      return 'Earlier discussion about migration.';
    },
  });
  const messages: ChatMessage[] = Array.from({ length: 30 }, (_, index) => ({
    role: 'user',
    content: `message-${index}`,
  }));

  const result = await manager.beforeRequest('summary-session', messages);
  assert.equal(result.messages.length, 6);
  assert.equal(result.messages[0]!.role, 'system');
  assert.match(result.messages[0]!.content, /25 条消息/);
  assert.match(result.messages[0]!.content, /migration/);
  assert.deepEqual(summarized[0], messages.slice(0, 25));
  assert.deepEqual(result.messages.slice(1), messages.slice(-5));
});

test('summary mode without summarize uses a placeholder', async () => {
  const manager = createContextManager({ mode: 'summary', keepRecent: 2 });
  const messages: ChatMessage[] = Array.from({ length: 5 }, (_, index) => ({
    role: 'user',
    content: `message-${index}`,
  }));
  const result = await manager.beforeRequest('summary-placeholder', messages);
  assert.equal(result.messages[0]!.content, '更早的 3 条消息已省略。');
  assert.deepEqual(result.messages.slice(1), messages.slice(-2));
});

test('acp mode processes turns, persists state, compresses, expands and searches', async () => {
  const store = new MemoryStore();
  const manager = createContextManager({
    mode: 'acp',
    stateStore: store,
    modelContextLimit: 200_000,
  });

  // 内核默认 preserveRecentTokens=5000：消息要足够长，早期消息才落在可压缩区。
  const messages: ChatMessage[] = Array.from({ length: 20 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message ${index} alpha bravo charlie delta `.repeat(55),
  }));

  const prepared = await manager.beforeRequest('acp-session', messages);
  assert.ok(prepared.messages.length > 0);
  assert.equal(prepared.nudge, undefined);

  const state = await store.get('acp-session');
  assert.ok(state);
  const startRef = state!.messageRefs.byRaw['msg-0']!;
  const endRef = state!.messageRefs.byRaw['msg-5']!;
  assert.ok(startRef);
  assert.ok(endRef);

  const summary =
    'The early discussion covered migration planning, schema review and deployment steps in detail.';
  const applied = await manager.applyCompression('acp-session', {
    mode: 'range',
    ranges: [{ startRef, endRef, summary, topic: 'migration plan' }],
  });
  assert.deepEqual(applied.errors, []);
  assert.equal(applied.blocksCreated, 1);
  assert.ok(applied.tokensCompressed > 0);

  const saved = await store.get('acp-session');
  const block = saved!.blocks.find((item) => item.active);
  assert.ok(block);

  const expanded = await manager.decompress('acp-session', block!.blockId);
  assert.equal(expanded?.summary, summary);
  assert.equal(expanded?.topic, 'migration plan');

  const hits = await manager.search('acp-session', 'migration');
  assert.ok(hits.some((item) => item.blockId === block!.blockId));

  const status = (await manager.status('acp-session')) as { activeBlocks: number; mode: string };
  assert.equal(status.mode, 'acp');
  assert.ok(status.activeBlocks >= 1);

  await manager.reset('acp-session');
  assert.equal(await store.get('acp-session'), null);
  assert.equal(await manager.decompress('acp-session', block!.blockId), undefined);
});

test('context tools validate arguments and return ok:false on bad input', async () => {
  const manager = createContextManager({ mode: 'acp' });
  const tools = contextTools(manager);
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ['acp_status', 'compress', 'decompress', 'search_context'],
  );

  const compress = tools.find((tool) => tool.name === 'compress')!;
  assert.equal((await compress.execute({ ranges: [] }, toolCtx)).ok, false);
  assert.equal(
    (
      await compress.execute(
        { ranges: [{ startRef: 'm00001', endRef: 'm00002' }] },
        toolCtx,
      )
    ).ok,
    false,
  );
  const decompress = tools.find((tool) => tool.name === 'decompress')!;
  assert.equal((await decompress.execute({}, toolCtx)).ok, false);
  const search = tools.find((tool) => tool.name === 'search_context')!;
  assert.equal((await search.execute({ query: '' }, toolCtx)).ok, false);
});
