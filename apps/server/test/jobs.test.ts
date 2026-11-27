import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { ToolContext, ToolDefinition, ToolResult } from '@witcode/protocol';
import { createJobTools, type JobToolsOptions } from '../src/jobs.ts';

interface JobOutput {
  id: string;
  status: 'running' | 'exited' | 'killed';
  exitCode: number | null;
  pid: number | null;
  stdout: string;
  stderr: string;
  truncated: { stdout: boolean; stderr: boolean };
  error: string | null;
}

interface Harness {
  dir: string;
  tools: ToolDefinition[];
  ctx: ToolContext;
  ids: string[];
}

async function setup(t: TestContext, sessionId = 's', options: JobToolsOptions = {}): Promise<Harness> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'witcode-jobs-'));
  const tools = createJobTools(options);
  const ctx: ToolContext = { workspace: dir, sessionId };
  const ids: string[] = [];
  t.after(async () => {
    for (const id of ids) {
      try {
        await invoke(tools, 'job_kill', { id }, ctx);
      } catch {
        /* already gone */
      }
    }
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { dir, tools, ctx, ids };
}

async function invoke(
  tools: ToolDefinition[],
  name: string,
  input: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `missing tool: ${name}`);
  return tool.execute(input, ctx);
}

async function start(
  h: Harness,
  command: string,
  ctx: ToolContext = h.ctx,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const result = await invoke(h.tools, 'run_background', { command, ...extra }, ctx);
  assert.equal(result.ok, true, result.error);
  const started = JSON.parse(result.content) as { id: string; pid: number | null };
  assert.ok(started.id, 'job id must be returned immediately');
  assert.equal(typeof started.pid, 'number', 'pid must be returned immediately');
  h.ids.push(started.id);
  return started.id;
}

async function output(h: Harness, id: string, ctx: ToolContext = h.ctx, tail?: number): Promise<JobOutput> {
  const result = await invoke(h.tools, 'job_output', tail === undefined ? { id } : { id, tail }, ctx);
  assert.equal(result.ok, true, result.error);
  return JSON.parse(result.content) as JobOutput;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error('等待超时');
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

/** 用绝对 node 路径 -e 执行纯单引号 JS，cmd.exe 与 sh 都兼容，且无需网络。 */
function nodeCmd(code: string): string {
  assert.ok(!code.includes('"'), 'helper only accepts code with single quotes');
  return `"${process.execPath}" -e "${code}"`;
}

test('短命令：成功任务退出码为 0，stdout 可读', async (t) => {
  const h = await setup(t);
  const id = await start(h, nodeCmd("process.stdout.write('hello-job')"));
  await waitFor(async () => (await output(h, id)).status === 'exited');

  const out = await output(h, id);
  assert.equal(out.status, 'exited');
  assert.equal(out.exitCode, 0);
  assert.match(out.stdout, /hello-job/);
  assert.equal(out.stderr, '');
  assert.equal(out.truncated.stdout, false);
});

test('短命令：失败任务保留非零退出码与 stderr', async (t) => {
  const h = await setup(t);
  const id = await start(h, nodeCmd("process.stderr.write('bad-thing');process.exit(7)"));
  await waitFor(async () => (await output(h, id)).status === 'exited');

  const out = await output(h, id);
  assert.equal(out.status, 'exited');
  assert.equal(out.exitCode, 7);
  assert.match(out.stderr, /bad-thing/);
});

test('长命令：启动后立即 running，轮询可见增量输出', async (t) => {
  const h = await setup(t);
  const id = await start(h, nodeCmd("var n=0;setInterval(function(){process.stdout.write(String(n++)+';')},20)"));

  const first = await output(h, id);
  assert.equal(first.status, 'running');
  assert.equal(first.exitCode, null);

  await waitFor(async () => (await output(h, id)).stdout.includes('5;'));
  const later = await output(h, id);
  assert.equal(later.status, 'running');
  assert.ok(later.stdout.length > first.stdout.length);

  const listed = JSON.parse((await invoke(h.tools, 'job_list', {}, h.ctx)).content) as {
    jobs: Array<{ id: string; status: string; command: string; pid: number; startedAt: number }>;
  };
  const entry = listed.jobs.find((job) => job.id === id);
  assert.ok(entry);
  assert.equal(entry.status, 'running');
  assert.equal(typeof entry.pid, 'number');
  assert.ok(entry.startedAt > 0);
});

test('job_kill：终止进程树，状态变为 killed 且输出仍可读', async (t) => {
  const h = await setup(t);
  const id = await start(h, nodeCmd('setInterval(function(){},1000)'));

  const killed = await invoke(h.tools, 'job_kill', { id }, h.ctx);
  assert.equal(killed.ok, true, killed.error);
  assert.deepEqual(JSON.parse(killed.content), { id, status: 'killed', exitCode: null });

  await waitFor(async () => (await output(h, id)).status === 'killed');
  const out = await output(h, id);
  assert.equal(out.status, 'killed');
  assert.equal(out.exitCode, null);
});

test('会话隔离：另一会话看不到、读不到也杀不掉任务', async (t) => {
  const h = await setup(t, 'A');
  const other: ToolContext = { workspace: h.dir, sessionId: 'B' };
  const id = await start(h, nodeCmd('setInterval(function(){},1000)'));

  const listB = JSON.parse((await invoke(h.tools, 'job_list', {}, other)).content) as { jobs: unknown[] };
  assert.deepEqual(listB.jobs, []);

  const readB = await invoke(h.tools, 'job_output', { id }, other);
  assert.equal(readB.ok, false);
  assert.match(readB.error ?? '', /unknown job id/);

  const killB = await invoke(h.tools, 'job_kill', { id }, other);
  assert.equal(killB.ok, false);
  assert.equal((await output(h, id)).status, 'running');

  const killA = await invoke(h.tools, 'job_kill', { id }, h.ctx);
  assert.equal(killA.ok, true, killA.error);
});

test('并发上限：达到上限后拒绝，结束的任务释放名额', async (t) => {
  const h = await setup(t, 's', { maxJobs: 2 });
  const long = nodeCmd('setInterval(function(){},1000)');
  const first = await start(h, long);
  const second = await start(h, long);

  const third = await invoke(h.tools, 'run_background', { command: long }, h.ctx);
  assert.equal(third.ok, false);
  assert.match(third.error ?? '', /at most 2 active jobs/);

  await invoke(h.tools, 'job_kill', { id: second }, h.ctx);
  const replacement = await start(h, long);
  assert.notEqual(replacement, first);
  assert.equal((await output(h, first)).status, 'running');
  assert.equal((await output(h, replacement)).status, 'running');
});

test('未知 id：读取和终止都失败', async (t) => {
  const h = await setup(t);
  const read = await invoke(h.tools, 'job_output', { id: 'job-nope' }, h.ctx);
  assert.equal(read.ok, false);
  assert.match(read.error ?? '', /unknown job id/);

  const kill = await invoke(h.tools, 'job_kill', { id: 'job-nope' }, h.ctx);
  assert.equal(kill.ok, false);
  assert.match(kill.error ?? '', /unknown job id/);
});

test('cwd：相对目录生效，逃逸 workspace 被拒绝', async (t) => {
  const h = await setup(t);
  const sub = path.join(h.dir, 'sub');
  await fs.mkdir(sub);

  const id = await start(h, nodeCmd("process.stdout.write(process.cwd())"), h.ctx, { cwd: 'sub' });
  await waitFor(async () => (await output(h, id)).status === 'exited');
  assert.equal((await output(h, id)).stdout, await fs.realpath(sub));

  for (const bad of ['..', path.resolve(h.dir, '..')]) {
    const result = await invoke(
      h.tools,
      'run_background',
      { command: nodeCmd("process.stdout.write('x')"), cwd: bad },
      h.ctx,
    );
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /escape|escapes workspace/);
  }
});

test('环形缓冲：超出上限只保留最新字节并标记 truncated', async (t) => {
  const h = await setup(t, 's', { maxBufferBytes: 30 });
  const id = await start(h, nodeCmd("process.stdout.write('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz')"));
  await waitFor(async () => (await output(h, id)).status === 'exited');

  const out = await output(h, id);
  assert.equal(out.status, 'exited');
  assert.equal(out.truncated.stdout, true);
  assert.equal(out.stdout.length, 30);
  assert.ok(out.stdout.endsWith('wxyz'));
  assert.ok(!out.stdout.startsWith('0123'));
});

test('job_output：tail 控制返回末尾字符数，默认返回全部', async (t) => {
  const h = await setup(t);
  const id = await start(h, nodeCmd("process.stdout.write('abcdef')"));
  await waitFor(async () => (await output(h, id)).status === 'exited');

  assert.equal((await output(h, id)).stdout, 'abcdef');
  assert.equal((await output(h, id, h.ctx, 1)).stdout, 'f');
  assert.equal((await output(h, id, h.ctx, 3)).stdout, 'def');
});

test('安全：调用方传入的 env 不会进入子进程', async (t) => {
  const h = await setup(t);
  const id = await start(
    h,
    nodeCmd("process.stdout.write(String(process.env.WITCODE_JOBS_MUST_NOT_LEAK||'none'))"),
    h.ctx,
    { env: { WITCODE_JOBS_MUST_NOT_LEAK: 'leaked' } },
  );
  await waitFor(async () => (await output(h, id)).status === 'exited');
  assert.equal((await output(h, id)).stdout, 'none');
});
