import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ToolDefinition } from '@witcode/protocol';
import { createMcpManager, toolNameFor } from '../src/mcp.ts';

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'witcode-mcp-'));
}

interface Recorder {
  tools: Map<string, ToolDefinition>;
  registered: string[];
  disposed: string[];
  register(tool: ToolDefinition): () => void;
}

function recorder(): Recorder {
  const tools = new Map<string, ToolDefinition>();
  const registered: string[] = [];
  const disposed: string[] = [];
  return {
    tools,
    registered,
    disposed,
    register(tool) {
      tools.set(tool.name, tool);
      registered.push(tool.name);
      return () => {
        tools.delete(tool.name);
        disposed.push(tool.name);
      };
    },
  };
}

const FAKE_SERVER_SOURCE = `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  if (!req || req.id === undefined) return;
  let result;
  if (req.method === 'initialize') {
    result = {
      protocolVersion: (req.params && req.params.protocolVersion) || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'fake-mcp-server', version: '1.0.0' },
    };
  } else if (req.method === 'tools/list') {
    result = {
      tools: [
        {
          name: 'echo',
          description: 'Echo the given text',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
          },
        },
        {
          name: 'boom',
          description: 'Always fails',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    };
  } else if (req.method === 'tools/call') {
    const params = req.params || {};
    if (params.name === 'boom') {
      result = { content: [{ type: 'text', text: 'kaboom' }], isError: true };
    } else {
      const text = (params.arguments && params.arguments.text) || '';
      result = {
        content: [
          { type: 'text', text: 'echo:' + text },
          { type: 'text', text: 'second' },
        ],
      };
    }
  } else if (req.method === 'ping') {
    result = {};
  } else {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Method not found' } }) + '\\n');
    return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\\n');
});
`;

async function writeFakeServer(dir: string): Promise<string> {
  const script = path.join(dir, 'fake-mcp-server.mjs');
  await fs.writeFile(script, FAKE_SERVER_SOURCE, 'utf8');
  return script;
}

test('toolNameFor：清洗为 [a-zA-Z0-9_-] 并加 mcp__<server>__<tool> 前缀', () => {
  assert.equal(toolNameFor('filesystem', 'read_file'), 'mcp__filesystem__read_file');
  assert.equal(toolNameFor('my server.v2', 'read/file!'), 'mcp__my_server_v2__read_file_');
  assert.equal(toolNameFor('a/b c.d', 'x-y_z'), 'mcp__a_b_c_d__x-y_z');
  assert.equal(toolNameFor('!!!', '???'), `mcp__${'___'}__${'___'}`);
  assert.ok(/^mcp__[a-zA-Z0-9_-]+__[a-zA-Z0-9_-]+$/.test(toolNameFor('a b', 'c d')));
});

test('save（disabled）：mcp.json 原子落盘，env 明文只落服务端，对外只有 envKeys', async () => {
  const dir = await tempDir();
  const rec = recorder();
  const manager = await createMcpManager({ dataDir: dir, registerTool: rec.register });

  const items = await manager.save({
    name: 'Local Demo',
    command: '__no_such_command__',
    args: ['--flag'],
    env: { TOKEN: 'secret-123', MODE: 'test' },
    enabled: false,
  });

  assert.equal(items.length, 1);
  const item = items[0]!;
  assert.ok(item.id.length > 0);
  assert.equal(item.name, 'Local Demo');
  assert.deepEqual(item.args, ['--flag']);
  assert.deepEqual(item.envKeys, ['TOKEN', 'MODE']);
  assert.equal(item.status, 'disabled');
  assert.equal(item.toolCount, 0);
  assert.equal(item.error, undefined);
  assert.equal('env' in item, false);
  assert.deepEqual(rec.registered, []);

  const persisted = JSON.parse(await fs.readFile(path.join(dir, 'mcp.json'), 'utf8'));
  assert.deepEqual(persisted.servers[0].env, { TOKEN: 'secret-123', MODE: 'test' });
  assert.equal(persisted.servers[0].command, '__no_such_command__');
  assert.equal(persisted.servers[0].enabled, false);

  await manager.close();
});

test('配置重载、按 id 更新、同名拒绝、remove / reconnect 未知 id', async () => {
  const dir = await tempDir();
  const rec = recorder();
  const first = await createMcpManager({ dataDir: dir, registerTool: rec.register });
  const saved = await first.save({
    name: 'alpha',
    command: '__no_such_command__',
    args: [],
    enabled: false,
  });
  const id = saved[0]!.id;

  const second = await createMcpManager({ dataDir: dir, registerTool: rec.register });
  assert.deepEqual(second.list(), saved);

  const updated = await second.save({
    id,
    name: 'alpha',
    command: 'other-command',
    args: ['x'],
    env: { A: '1' },
    enabled: false,
  });
  assert.equal(updated.length, 1);
  assert.equal(updated[0]!.id, id);
  assert.equal(updated[0]!.command, 'other-command');
  assert.deepEqual(updated[0]!.envKeys, ['A']);

  await assert.rejects(
    second.save({ name: 'alpha', command: 'x', args: [], enabled: false }),
    /名称已存在/,
  );
  await assert.rejects(second.remove('missing-id'), /未知/);
  await assert.rejects(second.reconnect('missing-id'), /未知/);

  const removed = await second.remove(id);
  assert.equal(removed.length, 0);
  const persisted = JSON.parse(await fs.readFile(path.join(dir, 'mcp.json'), 'utf8'));
  assert.deepEqual(persisted.servers, []);

  await first.close();
  await second.close();
});

test('配置校验：空命令、非数组 args、非字符串 env、空名称、损坏文件容错', async () => {
  const dir = await tempDir();
  const rec = recorder();
  const manager = await createMcpManager({ dataDir: dir, registerTool: rec.register });
  const base = { name: 'v', command: 'cmd', args: [] as string[], enabled: false };

  await assert.rejects(manager.save({ ...base, command: '   ' }), /command/);
  await assert.rejects(manager.save({ ...base, args: '--flag' as never }), /args/);
  await assert.rejects(manager.save({ ...base, args: [1] as never }), /args/);
  await assert.rejects(manager.save({ ...base, env: { TOKEN: 123 } as never }), /env\.TOKEN/);
  await assert.rejects(manager.save({ ...base, env: [] as never }), /env/);
  await assert.rejects(manager.save({ ...base, name: '' }), /name/);
  await assert.rejects(manager.save({ ...base, enabled: 'yes' as never }), /enabled/);
  await assert.rejects(manager.save(42 as never), /对象/);
  assert.deepEqual(manager.list(), []);

  await fs.writeFile(path.join(dir, 'mcp.json'), '{not json', 'utf8');
  const recovered = await createMcpManager({ dataDir: dir, registerTool: rec.register });
  assert.deepEqual(recovered.list(), []);

  await manager.close();
  await recovered.close();
});

test('连接失败：status=error、toolCount=0 且带错误信息，不注册任何工具', async () => {
  const dir = await tempDir();
  const rec = recorder();
  const manager = await createMcpManager({ dataDir: dir, registerTool: rec.register });

  await manager.save({
    name: 'broken',
    command: process.execPath,
    args: ['-e', 'process.exit(1)'],
    enabled: true,
  });

  const item = manager.list()[0]!;
  assert.equal(item.status, 'error');
  assert.equal(item.toolCount, 0);
  assert.ok(item.error && item.error.length > 0);
  assert.deepEqual(rec.registered, []);

  await manager.close();
});

test('集成：stdio MCP server 的连接、工具注册/执行、重连、禁用、close 与删除', async () => {
  const dir = await tempDir();
  const script = await writeFakeServer(dir);
  const rec = recorder();
  const manager = await createMcpManager({ dataDir: dir, registerTool: rec.register });

  try {
    const config = {
      name: 'Fake.Server/v1',
      command: process.execPath,
      args: [script],
      env: { MCP_TEST_FLAG: 'yes' },
      enabled: true,
    };
    const items = await manager.save(config);
    const item = items[0]!;
    assert.equal(item.status, 'connected');
    assert.equal(item.toolCount, 2);
    assert.equal(item.error, undefined);
    assert.deepEqual(item.envKeys, ['MCP_TEST_FLAG']);

    const echo = rec.tools.get('mcp__Fake_Server_v1__echo');
    assert.ok(echo);
    assert.equal(echo.readOnly, false);
    assert.equal(echo.riskLevel, 'medium');
    assert.match(echo.description, /^\[MCP:Fake\.Server\/v1\] Echo the given text$/);
    assert.deepEqual(echo.inputSchema, {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    });
    assert.deepEqual(await echo.execute({ text: 'hi' }, { workspace: dir }), {
      ok: true,
      content: 'echo:hi\nsecond',
    });

    const boom = rec.tools.get('mcp__Fake_Server_v1__boom')!;
    const bad = await boom.execute({}, { workspace: dir });
    assert.equal(bad.ok, false);
    assert.equal(bad.content, 'kaboom');
    assert.equal(bad.error, 'kaboom');

    // reconnect：先注销旧工具，再注册同名新工具。
    const registeredBefore = rec.registered.length;
    const reconnected = await manager.reconnect(item.id);
    assert.equal(reconnected[0]!.status, 'connected');
    assert.equal(rec.disposed.filter((name) => name.endsWith('__echo')).length, 1);
    assert.ok(rec.registered.length > registeredBefore);
    assert.ok(rec.tools.has('mcp__Fake_Server_v1__echo'));

    // 禁用后重连：注销工具，状态 disabled。
    const disabled = await manager.save({ ...config, id: item.id, enabled: false });
    assert.equal(disabled[0]!.status, 'disabled');
    assert.equal(disabled[0]!.toolCount, 0);
    assert.ok(!rec.tools.has('mcp__Fake_Server_v1__echo'));
  } finally {
    await manager.close();
  }

  assert.ok(!rec.tools.has('mcp__Fake_Server_v1__echo'));

  const reopened = await createMcpManager({ dataDir: dir, registerTool: rec.register });
  const removed = await reopened.remove(
    JSON.parse(await fs.readFile(path.join(dir, 'mcp.json'), 'utf8')).servers[0].id,
  );
  assert.equal(removed.length, 0);
  await reopened.close();
});

test('startAll：只连接 enabled 的 server，并执行一次全量断开', async () => {
  const dir = await tempDir();
  const script = await writeFakeServer(dir);
  const rec = recorder();
  const first = await createMcpManager({ dataDir: dir, registerTool: rec.register });

  await first.save({
    name: 'on',
    command: process.execPath,
    args: [script],
    enabled: true,
  });
  await first.save({
    name: 'off',
    command: process.execPath,
    args: [script],
    enabled: false,
  });
  await first.close();

  const second = await createMcpManager({ dataDir: dir, registerTool: rec.register });
  assert.deepEqual(
    second.list().map((item) => item.status),
    ['error', 'disabled'],
  );

  await second.startAll();
  const items = second.list();
  assert.equal(items.find((item) => item.name === 'on')?.status, 'connected');
  assert.equal(items.find((item) => item.name === 'on')?.toolCount, 2);
  assert.equal(items.find((item) => item.name === 'off')?.status, 'disabled');
  assert.deepEqual([...rec.tools.keys()].sort(), ['mcp__on__boom', 'mcp__on__echo']);

  await second.close();
  assert.equal(rec.tools.size, 0);
});
