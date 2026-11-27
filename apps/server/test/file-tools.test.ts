import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolContext, ToolDefinition, ToolResult } from '@witcode/protocol';
import { createFileTools } from '../src/file-tools.ts';

const tools = createFileTools();

function getTool(name: string): ToolDefinition {
  const found = tools.find((tool) => tool.name === name);
  assert.ok(found, `tool "${name}" should be registered`);
  return found;
}

function workspace(): { ws: string; cleanup: () => void } {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'witcode-file-tools-'));
  return { ws, cleanup: () => fs.rmSync(ws, { recursive: true, force: true }) };
}

function ctx(ws: string): ToolContext {
  return { workspace: ws };
}

function write(ws: string, rel: string, content: string): string {
  const abs = path.join(ws, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

function read(ws: string, rel: string): string {
  return fs.readFileSync(path.join(ws, rel), 'utf8');
}

function run(tool: ToolDefinition, input: unknown, ws: string): Promise<ToolResult> {
  return tool.execute(input, ctx(ws));
}

// ---------------------------------------------------------------------------
// metadata
// ---------------------------------------------------------------------------

test('工具元数据：名称、风险标记与输入 schema', () => {
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['edit_file', 'apply_patch', 'glob'],
  );

  const edit = getTool('edit_file');
  assert.equal(edit.readOnly, false);
  assert.equal(edit.destructive, true);
  assert.equal(edit.riskLevel, 'medium');
  assert.match(edit.description, /exact/i);

  const patch = getTool('apply_patch');
  assert.equal(patch.readOnly, false);
  assert.equal(patch.destructive, true);
  assert.equal(patch.riskLevel, 'high');

  const glob = getTool('glob');
  assert.equal(glob.readOnly, true);
  assert.equal(glob.riskLevel, 'low');

  for (const tool of tools) {
    assert.equal((tool.inputSchema as { type?: string }).type, 'object');
    assert.ok(tool.description.length > 0);
  }
});

// ---------------------------------------------------------------------------
// edit_file
// ---------------------------------------------------------------------------

test('edit_file：唯一匹配被精确替换', async () => {
  const { ws, cleanup } = workspace();
  try {
    write(ws, 'app.txt', 'hello world\nsecond line\n');
    const result = await run(getTool('edit_file'), {
      path: 'app.txt',
      old_string: 'world',
      new_string: 'WIT',
    }, ws);
    assert.equal(result.ok, true, result.error);
    assert.equal(read(ws, 'app.txt'), 'hello WIT\nsecond line\n');
  } finally {
    cleanup();
  }
});

test('edit_file：零次匹配报错', async () => {
  const { ws, cleanup } = workspace();
  try {
    write(ws, 'app.txt', 'hello world\n');
    const result = await run(getTool('edit_file'), {
      path: 'app.txt',
      old_string: 'missing',
      new_string: 'x',
    }, ws);
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /not found/i);
    assert.equal(read(ws, 'app.txt'), 'hello world\n');
  } finally {
    cleanup();
  }
});

test('edit_file：多处匹配报错并提示补充上下文或使用 replace_all', async () => {
  const { ws, cleanup } = workspace();
  try {
    write(ws, 'app.txt', 'one fish\ntwo fish\n');
    const result = await run(getTool('edit_file'), {
      path: 'app.txt',
      old_string: 'fish',
      new_string: 'cat',
    }, ws);
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /2 times/);
    assert.match(result.error ?? '', /more context/);
    assert.match(result.error ?? '', /replace_all/);
    assert.equal(read(ws, 'app.txt'), 'one fish\ntwo fish\n');
  } finally {
    cleanup();
  }
});

test('edit_file：replace_all 替换全部且带更多上下文可唯一匹配', async () => {
  const { ws, cleanup } = workspace();
  try {
    write(ws, 'app.txt', 'one fish\ntwo fish\n');
    const all = await run(getTool('edit_file'), {
      path: 'app.txt',
      old_string: 'fish',
      new_string: 'cat',
      replace_all: true,
    }, ws);
    assert.equal(all.ok, true, all.error);
    assert.equal(read(ws, 'app.txt'), 'one cat\ntwo cat\n');

    const unique = await run(getTool('edit_file'), {
      path: 'app.txt',
      old_string: 'two cat',
      new_string: 'three cat',
    }, ws);
    assert.equal(unique.ok, true, unique.error);
    assert.equal(read(ws, 'app.txt'), 'one cat\nthree cat\n');
  } finally {
    cleanup();
  }
});

test('edit_file：保留 CRLF 换行风格', async () => {
  const { ws, cleanup } = workspace();
  try {
    write(ws, 'crlf.txt', 'one\r\ntwo\r\n');
    const result = await run(getTool('edit_file'), {
      path: 'crlf.txt',
      old_string: 'one\ntwo',
      new_string: 'three\nfour',
    }, ws);
    assert.equal(result.ok, true, result.error);
    assert.equal(read(ws, 'crlf.txt'), 'three\r\nfour\r\n');
  } finally {
    cleanup();
  }
});

test('edit_file：拒绝逃逸路径（相对与绝对）', async () => {
  const { ws, cleanup } = workspace();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'witcode-outside-'));
  try {
    const outsideFile = path.join(outside, 'secret.txt');
    fs.writeFileSync(outsideFile, 'secret', 'utf8');

    const viaRelative = await run(getTool('edit_file'), {
      path: `../${path.basename(outside)}/secret.txt`,
      old_string: 'secret',
      new_string: 'changed',
    }, ws);
    assert.equal(viaRelative.ok, false);
    assert.match(viaRelative.error ?? '', /escapes workspace/);

    const viaAbsolute = await run(getTool('edit_file'), {
      path: outsideFile,
      old_string: 'secret',
      new_string: 'changed',
    }, ws);
    assert.equal(viaAbsolute.ok, false);
    assert.match(viaAbsolute.error ?? '', /escapes workspace/);

    assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'secret');
  } finally {
    cleanup();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('edit_file：文件不存在与非法参数均返回 ok:false', async () => {
  const { ws, cleanup } = workspace();
  try {
    const tool = getTool('edit_file');
    const missing = await run(tool, { path: 'missing.txt', old_string: 'a', new_string: 'b' }, ws);
    assert.equal(missing.ok, false);
    assert.match(missing.error ?? '', /not found/i);

    const badInput = [
      null,
      { path: 'x.txt', new_string: 'b' },
      { path: 'x.txt', old_string: '', new_string: 'b' },
      { path: 'x.txt', old_string: 'a' },
      { path: 'x.txt', old_string: 'a', new_string: 1 },
      { path: 'x.txt', old_string: 'a', new_string: 'b', replace_all: 'yes' },
      { path: '', old_string: 'a', new_string: 'b' },
    ];
    for (const input of badInput) {
      const result = await run(tool, input, ws);
      assert.equal(result.ok, false, `expected failure for ${JSON.stringify(input)}`);
    }
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// apply_patch
// ---------------------------------------------------------------------------

test('apply_patch：单文件 Update 精确修改', async () => {
  const { ws, cleanup } = workspace();
  try {
    write(ws, 'src/app.ts', 'export function hello() {\n  return 1;\n}\n');
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/app.ts',
      '@@',
      ' export function hello() {',
      '-  return 1;',
      '+  return 2;',
      ' }',
      '*** End Patch',
    ].join('\n');
    const result = await run(getTool('apply_patch'), { patch }, ws);
    assert.equal(result.ok, true, result.error);
    assert.equal(read(ws, 'src/app.ts'), 'export function hello() {\n  return 2;\n}\n');
  } finally {
    cleanup();
  }
});

test('apply_patch：多个 hunk 按先后顺序应用', async () => {
  const { ws, cleanup } = workspace();
  try {
    write(ws, 'lines.txt', 'one\ntwo\nthree\nfour\nfive\n');
    const patch = [
      '*** Begin Patch',
      '*** Update File: lines.txt',
      '@@',
      ' one',
      '-two',
      '+TWO',
      '@@',
      '-four',
      '+FOUR',
      '*** End Patch',
    ].join('\n');
    const result = await run(getTool('apply_patch'), { patch }, ws);
    assert.equal(result.ok, true, result.error);
    assert.equal(read(ws, 'lines.txt'), 'one\nTWO\nthree\nFOUR\nfive\n');
  } finally {
    cleanup();
  }
});

test('apply_patch：上下文不匹配时报错并指出行号', async () => {
  const { ws, cleanup } = workspace();
  try {
    write(ws, 'lines.txt', 'one\ntwo\n');
    const patch = [
      '*** Begin Patch',
      '*** Update File: lines.txt',
      '@@',
      '-three',
      '+THREE',
      '*** End Patch',
    ].join('\n');
    const result = await run(getTool('apply_patch'), { patch }, ws);
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /mismatch/);
    assert.match(result.error ?? '', /line 1/);
    assert.equal(read(ws, 'lines.txt'), 'one\ntwo\n');
  } finally {
    cleanup();
  }
});

test('apply_patch：Add File 新建文件（含子目录）', async () => {
  const { ws, cleanup } = workspace();
  try {
    const patch = [
      '*** Begin Patch',
      '*** Add File: new/added.txt',
      '+hello',
      '+world',
      '*** End Patch',
    ].join('\n');
    const result = await run(getTool('apply_patch'), { patch }, ws);
    assert.equal(result.ok, true, result.error);
    assert.equal(read(ws, 'new/added.txt'), 'hello\nworld\n');
  } finally {
    cleanup();
  }
});

test('apply_patch：Delete File 删除文件', async () => {
  const { ws, cleanup } = workspace();
  try {
    write(ws, 'old.txt', 'bye\n');
    const patch = [
      '*** Begin Patch',
      '*** Delete File: old.txt',
      '*** End Patch',
    ].join('\n');
    const result = await run(getTool('apply_patch'), { patch }, ws);
    assert.equal(result.ok, true, result.error);
    assert.equal(fs.existsSync(path.join(ws, 'old.txt')), false);
  } finally {
    cleanup();
  }
});

test('apply_patch：单 patch 修改多个文件', async () => {
  const { ws, cleanup } = workspace();
  try {
    write(ws, 'a.txt', 'x\n');
    write(ws, 'b.txt', 'y\n');
    const patch = [
      '*** Begin Patch',
      '*** Update File: a.txt',
      '@@',
      '-x',
      '+A',
      '*** Update File: b.txt',
      '@@',
      '-y',
      '+B',
      '*** End Patch',
    ].join('\n');
    const result = await run(getTool('apply_patch'), { patch }, ws);
    assert.equal(result.ok, true, result.error);
    assert.equal(read(ws, 'a.txt'), 'A\n');
    assert.equal(read(ws, 'b.txt'), 'B\n');
  } finally {
    cleanup();
  }
});

test('apply_patch：拒绝逃逸路径与非法 patch', async () => {
  const { ws, cleanup } = workspace();
  try {
    const tool = getTool('apply_patch');
    const escape = await run(tool, {
      patch: [
        '*** Begin Patch',
        '*** Update File: ../escape.txt',
        '@@',
        '-a',
        '+b',
        '*** End Patch',
      ].join('\n'),
    }, ws);
    assert.equal(escape.ok, false);
    assert.match(escape.error ?? '', /escapes workspace/);

    const inputs: unknown[] = [
      null,
      { patch: '' },
      { patch: 'just some text' },
      { patch: ['*** Begin Patch', '@@', '-a', '+b', '*** End Patch'].join('\n') },
    ];
    for (const input of inputs) {
      const result = await run(tool, input, ws);
      assert.equal(result.ok, false, `expected failure for ${JSON.stringify(input)}`);
    }
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// glob
// ---------------------------------------------------------------------------

test('glob：递归匹配、排序并跳过忽略目录', async () => {
  const { ws, cleanup } = workspace();
  try {
    write(ws, 'a.ts', '');
    write(ws, 'src/b.ts', '');
    write(ws, 'src/deep/c.ts', '');
    write(ws, 'node_modules/d.ts', '');
    write(ws, '.git/e.ts', '');
    write(ws, 'dist/f.ts', '');
    write(ws, 'README.md', '');

    const result = await run(getTool('glob'), { pattern: '**/*.ts' }, ws);
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(JSON.parse(result.content), ['a.ts', 'src/b.ts', 'src/deep/c.ts']);
  } finally {
    cleanup();
  }
});

test('glob：? 通配符与默认按文件名匹配', async () => {
  const { ws, cleanup } = workspace();
  try {
    write(ws, 'a1.txt', '');
    write(ws, 'src/a2.txt', '');
    write(ws, 'a12.txt', '');

    const question = await run(getTool('glob'), { pattern: 'a?.txt' }, ws);
    assert.equal(question.ok, true, question.error);
    assert.deepEqual(JSON.parse(question.content), ['a1.txt', 'src/a2.txt']);

    const star = await run(getTool('glob'), { pattern: '*.txt' }, ws);
    assert.deepEqual(JSON.parse(star.content), ['a1.txt', 'a12.txt', 'src/a2.txt']);
  } finally {
    cleanup();
  }
});

test('glob：limit 限制返回数量', async () => {
  const { ws, cleanup } = workspace();
  try {
    for (const name of ['f1.txt', 'f2.txt', 'f3.txt']) write(ws, name, '');
    const result = await run(getTool('glob'), { pattern: '*.txt', limit: 2 }, ws);
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(JSON.parse(result.content), ['f1.txt', 'f2.txt']);
  } finally {
    cleanup();
  }
});

test('glob：非法参数返回 ok:false', async () => {
  const { ws, cleanup } = workspace();
  try {
    const tool = getTool('glob');
    const inputs: unknown[] = [
      null,
      {},
      { pattern: '' },
      { pattern: '*.ts', limit: 0 },
      { pattern: '*.ts', limit: 1.5 },
      { pattern: '*.ts', limit: '2' },
    ];
    for (const input of inputs) {
      const result = await run(tool, input, ws);
      assert.equal(result.ok, false, `expected failure for ${JSON.stringify(input)}`);
    }
  } finally {
    cleanup();
  }
});
