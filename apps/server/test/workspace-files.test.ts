import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkspaceFiles } from '../src/workspace-files.ts';

function tmp(): { ws: string; cleanup: () => void } {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'witcode-ws-files-'));
  return { ws, cleanup: () => fs.rmSync(ws, { recursive: true, force: true }) };
}

function write(ws: string, rel: string, data: string | Buffer): void {
  const abs = path.join(ws, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, data);
}

function git(ws: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', ws, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

function initRepo(ws: string): void {
  git(ws, 'init', '-q');
  git(ws, 'config', 'user.email', 'test@example.com');
  git(ws, 'config', 'user.name', 'Test');
  git(ws, 'checkout', '-q', '-b', 'main');
}

// ---------------------------------------------------------------------------
// tree
// ---------------------------------------------------------------------------

test('tree：单层列出、目录在前、按名字排序，文件带 size', async () => {
  const { ws, cleanup } = tmp();
  try {
    write(ws, 'b.txt', '12345');
    write(ws, 'a.txt', 'hi');
    write(ws, '.hidden', 'x');
    write(ws, path.join('zdir', 'child.txt'), 'child');
    write(ws, path.join('adir', 'child.txt'), 'child');

    const items = await createWorkspaceFiles({ workspace: ws }).tree();
    assert.deepEqual(
      items.map((i) => i.path),
      ['adir', 'zdir', '.hidden', 'a.txt', 'b.txt'],
    );
    assert.deepEqual(
      items.map((i) => i.type),
      ['dir', 'dir', 'file', 'file', 'file'],
    );
    assert.equal(items.find((i) => i.path === 'a.txt')?.size, 2);
    assert.equal(items.find((i) => i.path === 'adir')?.size, undefined);
  } finally {
    cleanup();
  }
});

test('tree：忽略 node_modules/.git/dist/.vitest/coverage，保留其他隐藏项', async () => {
  const { ws, cleanup } = tmp();
  try {
    for (const dir of ['node_modules', '.git', 'dist', '.vitest', 'coverage']) {
      write(ws, path.join(dir, 'x.txt'), 'x');
    }
    write(ws, '.env', 'SECRET=1');
    write(ws, path.join('.vscode', 'settings.json'), '{}');
    write(ws, path.join('src', 'index.ts'), '');

    const paths = new Set(
      (await createWorkspaceFiles({ workspace: ws }).tree()).map((i) => i.path),
    );
    for (const dir of ['node_modules', '.git', 'dist', '.vitest', 'coverage']) {
      assert.ok(!paths.has(dir), `${dir} should be skipped`);
    }
    for (const kept of ['.env', '.vscode', 'src']) {
      assert.ok(paths.has(kept), `${kept} should be kept`);
    }
  } finally {
    cleanup();
  }
});

test('tree：支持子目录，拒绝逃逸路径与不存在的路径', async () => {
  const { ws, cleanup } = tmp();
  try {
    write(ws, path.join('sub', 'x.txt'), 'x');
    write(ws, path.join('sub', 'deep', 'y.txt'), 'y');
    write(ws, 'file.txt', 'x');

    const wf = createWorkspaceFiles({ workspace: ws });
    assert.deepEqual(
      (await wf.tree('sub')).map((i) => i.path),
      ['sub/deep', 'sub/x.txt'],
    );
    await assert.rejects(() => wf.tree('../outside'), /escape/i);
    await assert.rejects(() => wf.tree(path.resolve(ws, '..')), /escape/i);
    await assert.rejects(() => wf.tree('missing'), /not found/i);
    await assert.rejects(() => wf.tree('file.txt'), /not a directory/i);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

test('read：UTF-8 文本、中文文件名与字节大小', async () => {
  const { ws, cleanup } = tmp();
  try {
    const content = '你好，世界\nhello\n';
    write(ws, '中文.txt', content);
    const file = await createWorkspaceFiles({ workspace: ws }).read('中文.txt');
    assert.equal(file.path, '中文.txt');
    assert.equal(file.content, content);
    assert.equal(file.size, Buffer.byteLength(content, 'utf8'));
    assert.equal(file.truncated, false);
    assert.equal(file.binary, false);
  } finally {
    cleanup();
  }
});

test('read：前 8KB 含 NUL 视为二进制；8KB 之后的 NUL 不算', async () => {
  const { ws, cleanup } = tmp();
  try {
    write(ws, 'bin.dat', Buffer.from([0x41, 0x00, 0x42, 0x43]));
    const binary = await createWorkspaceFiles({ workspace: ws }).read('bin.dat');
    assert.equal(binary.binary, true);
    assert.equal(binary.content, '');
    assert.equal(binary.size, 4);

    const late = Buffer.alloc(9000, 0x41);
    late[8500] = 0;
    write(ws, 'late.bin', late);
    const text = await createWorkspaceFiles({ workspace: ws }).read('late.bin');
    assert.equal(text.binary, false);
    assert.equal(text.content.length, 9000);
    assert.equal(text.size, 9000);
  } finally {
    cleanup();
  }
});

test('read：超过 maxFileBytes 截断，size 仍为完整字节数', async () => {
  const { ws, cleanup } = tmp();
  try {
    write(ws, 'big.txt', 'abcdefghijklmnopqrstuvwxyz');
    const file = await createWorkspaceFiles({ workspace: ws, maxFileBytes: 16 }).read('big.txt');
    assert.equal(file.content, 'abcdefghijklmnop');
    assert.equal(file.truncated, true);
    assert.equal(file.size, 26);
    assert.equal(file.binary, false);
  } finally {
    cleanup();
  }
});

test('read：checkRead 拒绝时抛错，允许时收到绝对路径', async () => {
  const { ws, cleanup } = tmp();
  try {
    write(ws, 'a.txt', 'x');
    let seen = '';
    const denied = createWorkspaceFiles({
      workspace: ws,
      checkRead: async (absPath) => {
        seen = absPath;
        return { ok: false, reason: 'blocked by policy' };
      },
    });
    await assert.rejects(() => denied.read('a.txt'), /blocked by policy/);
    assert.ok(path.isAbsolute(seen));
    assert.equal(path.basename(seen), 'a.txt');

    const calls: string[] = [];
    const allowed = createWorkspaceFiles({
      workspace: ws,
      checkRead: async (absPath) => {
        calls.push(absPath);
        return { ok: true };
      },
    });
    assert.equal((await allowed.read('a.txt')).content, 'x');
    assert.equal(calls.length, 1);
  } finally {
    cleanup();
  }
});

test('read：逃逸路径与不存在的路径报错', async () => {
  const { ws, cleanup } = tmp();
  try {
    write(ws, 'a.txt', 'x');
    const wf = createWorkspaceFiles({ workspace: ws });
    await assert.rejects(() => wf.read('../secret.txt'), /escape/i);
    await assert.rejects(() => wf.read(path.resolve(ws, '..', 'secret.txt')), /escape/i);
    await assert.rejects(() => wf.read('missing.txt'), /not found/i);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// git status / diff
// ---------------------------------------------------------------------------

test('git status：分支、修改/暂存/未跟踪状态', async () => {
  const { ws, cleanup } = tmp();
  try {
    initRepo(ws);
    write(ws, 'tracked.txt', 'v1\n');
    git(ws, 'add', '-A');
    git(ws, 'commit', '-qm', 'init');

    write(ws, 'tracked.txt', 'v2\n');
    write(ws, 'untracked.txt', 'u\n');
    write(ws, 'added.txt', 'a\n');
    git(ws, 'add', 'added.txt');

    const status = await createWorkspaceFiles({ workspace: ws }).gitStatus();
    assert.equal(status.branch, 'main');
    const byPath = new Map(status.items.map((i) => [i.path, i]));
    assert.deepEqual(byPath.get('tracked.txt'), { path: 'tracked.txt', status: 'M', staged: false });
    assert.deepEqual(byPath.get('untracked.txt'), { path: 'untracked.txt', status: '??', staged: false });
    assert.deepEqual(byPath.get('added.txt'), { path: 'added.txt', status: 'A', staged: true });
  } finally {
    cleanup();
  }
});

test('git status：重命名取新路径', async () => {
  const { ws, cleanup } = tmp();
  try {
    initRepo(ws);
    write(ws, 'old.txt', 'x\n');
    git(ws, 'add', '-A');
    git(ws, 'commit', '-qm', 'init');
    git(ws, 'mv', 'old.txt', 'new.txt');

    const status = await createWorkspaceFiles({ workspace: ws }).gitStatus();
    assert.deepEqual(status.items, [{ path: 'new.txt', status: 'R', staged: true }]);
  } finally {
    cleanup();
  }
});

test('git status：非 git 仓库返回空', async () => {
  const { ws, cleanup } = tmp();
  try {
    write(ws, 'a.txt', 'x');
    const wf = createWorkspaceFiles({ workspace: ws });
    assert.deepEqual(await wf.gitStatus(), { branch: '', items: [] });
    assert.equal(await wf.gitDiff('a.txt'), '');
  } finally {
    cleanup();
  }
});

test('git diff：返回改动内容，未跟踪文件为空', async () => {
  const { ws, cleanup } = tmp();
  try {
    initRepo(ws);
    write(ws, 'a.txt', 'line1\n');
    git(ws, 'add', '-A');
    git(ws, 'commit', '-qm', 'init');
    write(ws, 'a.txt', 'line2\n');
    write(ws, 'u.txt', 'untracked\n');

    const wf = createWorkspaceFiles({ workspace: ws });
    const diff = await wf.gitDiff('a.txt');
    assert.match(diff, /-line1/);
    assert.match(diff, /\+line2/);
    assert.match(diff, /a\.txt/);
    assert.equal(await wf.gitDiff('u.txt'), '');
    await assert.rejects(() => wf.gitDiff('../outside.txt'), /escape/i);
  } finally {
    cleanup();
  }
});

test('git status / git diff：中文文件名（含空格）', async () => {
  const { ws, cleanup } = tmp();
  try {
    initRepo(ws);
    const name = '中文 文件.txt';
    write(ws, name, '你好\n');
    const wf = createWorkspaceFiles({ workspace: ws });

    assert.deepEqual(await wf.gitStatus(), {
      branch: 'main',
      items: [{ path: name, status: '??', staged: false }],
    });

    git(ws, 'add', '-A');
    git(ws, 'commit', '-qm', 'init');
    write(ws, name, '世界\n');
    const diff = await wf.gitDiff(name);
    assert.match(diff, /-你好/);
    assert.match(diff, /\+世界/);
  } finally {
    cleanup();
  }
});
