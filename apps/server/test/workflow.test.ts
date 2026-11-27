import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { WorkflowRun } from '@witcode/protocol';
import {
  createWorkflowService,
  type WorkflowService,
  type WorkflowSpawnResult,
} from '../src/workflow.ts';

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'witcode-workflow-'));
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('等待超时');
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function readRuns(dir: string): Promise<WorkflowRun[]> {
  return fs
    .readFile(path.join(dir, 'workflow-runs.json'), 'utf8')
    .then((raw) => JSON.parse(raw) as WorkflowRun[]);
}

test('正常脚本：phase/agent/ask/artifact 顺序记录，输出与产物回填，onUpdate 推送终态', async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const updates: WorkflowRun[] = [];
  const asked: Array<{ task: string; actorName: string }> = [];
  const service: WorkflowService = await createWorkflowService({
    dataDir: dir,
    spawn: async (task, actorName) => {
      asked.push({ task, actorName });
      return { ok: true, output: `结果:${task}` };
    },
    onUpdate: (run) => updates.push(run),
  });

  const started = await service.start({
    name: '示例',
    script:
      "phase('分析'); const a = agent('架构师'); const out = await a.ask('分析需求'); " +
      "phase('产出'); artifact('分析报告', out);",
  });
  assert.equal(started.status, 'running');
  assert.equal(started.name, '示例');

  const done = await service.wait(started.id);
  assert.equal(done?.status, 'completed');
  assert.deepEqual(
    done?.phases.map((phase) => phase.name),
    ['分析', '产出'],
  );
  assert.equal(done?.phases[0]?.status, 'done');
  assert.deepEqual(
    done?.phases[0]?.actors.map((actor) => ({
      name: actor.name,
      status: actor.status,
      output: actor.output,
    })),
    [{ name: '架构师', status: 'done', output: '结果:分析需求' }],
  );
  assert.equal(done?.artifacts.length, 1);
  assert.equal(done?.artifacts[0]?.title, '分析报告');
  assert.equal(done?.artifacts[0]?.content, '结果:分析需求');
  assert.equal(done?.artifacts[0]?.kind, 'markdown');
  assert.ok((done?.updatedAt ?? 0) >= (done?.createdAt ?? 0));
  assert.deepEqual(asked, [{ task: '分析需求', actorName: '架构师' }]);

  assert.ok(updates.length >= 4);
  assert.equal(updates.at(-1)?.status, 'completed');
  assert.equal(updates.at(-1)?.id, started.id);
});

test('ask 失败：ok=false 与 spawn 抛异常都使 run 进入 failed 并留下 actor error', async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  let throwNext = false;
  const service = await createWorkflowService({
    dataDir: dir,
    spawn: async () => {
      if (throwNext) throw new Error('spawn 崩溃');
      return { ok: false, output: '', error: '模型不可用' };
    },
  });
  const script =
    "phase('分析'); const a = agent('甲'); await a.ask('任务'); artifact('不该出现', 'x');";

  const first = await service.start({ name: '失败一', script });
  const failedOne = await service.wait(first.id);
  assert.equal(failedOne?.status, 'failed');
  assert.match(failedOne?.error ?? '', /模型不可用/);
  assert.equal(failedOne?.phases[0]?.actors[0]?.status, 'failed');
  assert.equal(failedOne?.phases[0]?.actors[0]?.error, '模型不可用');
  assert.equal(failedOne?.artifacts.length, 0);

  throwNext = true;
  const second = await service.start({ name: '失败二', script });
  const failedTwo = await service.wait(second.id);
  assert.equal(failedTwo?.status, 'failed');
  assert.match(failedTwo?.error ?? '', /spawn 崩溃/);
});

test('语法错误：run 进入 failed 并记录错误，不产生产物', async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const service = await createWorkflowService({
    dataDir: dir,
    spawn: async () => ({ ok: true, output: '' }),
  });
  const started = await service.start({ name: '语法错误', script: "phase('x'); const = ;" });
  const done = await service.wait(started.id);

  assert.equal(done?.status, 'failed');
  assert.ok((done?.error ?? '').length > 0);
  assert.equal(done?.artifacts.length, 0);
});

test('cancel：杀掉子进程并置为 cancelled，wait 与持久化均反映终态', async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  let release: ((result: WorkflowSpawnResult) => void) | undefined;
  const service = await createWorkflowService({
    dataDir: dir,
    spawn: () =>
      new Promise<WorkflowSpawnResult>((resolve) => {
        release = resolve;
      }),
  });

  const started = await service.start({
    name: '可取消',
    script: "phase('分析'); const a = agent('甲'); artifact('报告', await a.ask('长任务'));",
  });
  await waitFor(() => release !== undefined);

  const cancelled = await service.cancel(started.id);
  assert.equal(cancelled?.status, 'cancelled');
  assert.equal((await service.wait(started.id))?.status, 'cancelled');
  assert.equal((await service.cancel(started.id))?.status, 'cancelled');
  assert.equal((await readRuns(dir))[0]?.status, 'cancelled');
  release?.({ ok: true, output: '迟到的结果' });
});

test('wait：终态立即返回，未知 id 返回 undefined，多个等待者都能被唤醒', async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const service = await createWorkflowService({
    dataDir: dir,
    spawn: async (task) => ({ ok: true, output: task }),
  });
  assert.equal(await service.wait('不存在'), undefined);

  const started = await service.start({
    name: '等待',
    script: "const a = agent('甲'); artifact('A', await a.ask('go'));",
  });
  const [first, second] = await Promise.all([service.wait(started.id), service.wait(started.id)]);
  assert.equal(first?.status, 'completed');
  assert.equal(second?.status, 'completed');
  assert.deepEqual(await service.wait(started.id), first);
});

test('持久化：完成后重开恢复；落盘不含脚本；重启把 running 转为 failed', async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const service = await createWorkflowService({
    dataDir: dir,
    spawn: async (task) => ({ ok: true, output: task }),
  });
  const started = await service.start({
    name: '持久化',
    script: "phase('P'); const a = agent('甲'); artifact('T', await a.ask('q'));",
  });
  await service.wait(started.id);

  const stored = await readRuns(dir);
  assert.equal(stored.length, 1);
  assert.ok(!Object.prototype.hasOwnProperty.call(stored[0] ?? {}, 'script'));
  assert.equal(stored[0]?.artifacts[0]?.content, 'q');

  const reopened = await createWorkflowService({
    dataDir: dir,
    spawn: async () => ({ ok: true, output: '' }),
  });
  const restored = reopened.get(started.id);
  assert.equal(restored?.status, 'completed');
  assert.equal(restored?.phases[0]?.name, 'P');
  assert.equal(restored?.artifacts[0]?.title, 'T');

  const stale: WorkflowRun = {
    id: 'wf-stale',
    name: '遗留',
    status: 'running',
    phases: [],
    artifacts: [],
    createdAt: 1,
    updatedAt: 2,
  };
  await fs.writeFile(path.join(dir, 'workflow-runs.json'), `${JSON.stringify([stale])}\n`);
  const afterRestart = await createWorkflowService({
    dataDir: dir,
    spawn: async () => ({ ok: true, output: '' }),
  });
  assert.equal(afterRestart.get('wf-stale')?.status, 'failed');
  assert.match(afterRestart.get('wf-stale')?.error ?? '', /重启/);
});

test('maxRuns：超出上限的旧 run 被淘汰，内存与磁盘一致并按 updatedAt 倒序', async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const service = await createWorkflowService({
    dataDir: dir,
    maxRuns: 2,
    spawn: async (task) => ({ ok: true, output: task }),
  });
  const ids: string[] = [];
  for (const name of ['一号', '二号', '三号']) {
    const run = await service.start({ name, script: `artifact('T', '${name}');` });
    ids.push(run.id);
    await service.wait(run.id);
  }

  const list = service.list();
  assert.equal(list.length, 2);
  assert.deepEqual(
    list.map((run) => run.id),
    [ids[2], ids[1]],
  );
  assert.equal(service.get(ids[0] ?? ''), undefined);
  const stored = await readRuns(dir);
  assert.deepEqual(
    stored.map((run) => run.id),
    [ids[2], ids[1]],
  );
});

test('并发两个 run 使用独立子进程，阶段/角色/产物互不串扰', async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const service = await createWorkflowService({
    dataDir: dir,
    spawn: async (task) => ({ ok: true, output: `out:${task}` }),
  });
  const [one, two] = await Promise.all([
    service.start({
      name: '甲',
      script: "phase('P1'); const a = agent('甲'); artifact('T1', await a.ask('task-A'));",
    }),
    service.start({
      name: '乙',
      script: "phase('P2'); const b = agent('乙'); artifact('T2', await b.ask('task-B'));",
    }),
  ]);
  assert.notEqual(one.id, two.id);
  // 脚本很短时可能在断言前已经完成；这里只要求处于运行中或已完成。
  assert.ok(one.status === 'running' || one.status === 'completed');
  assert.ok(two.status === 'running' || two.status === 'completed');

  const [doneOne, doneTwo] = await Promise.all([service.wait(one.id), service.wait(two.id)]);
  assert.equal(doneOne?.status, 'completed');
  assert.equal(doneTwo?.status, 'completed');
  assert.deepEqual(doneOne?.phases.map((phase) => phase.name), ['P1']);
  assert.deepEqual(doneTwo?.phases.map((phase) => phase.name), ['P2']);
  assert.equal(doneOne?.phases[0]?.actors[0]?.name, '甲');
  assert.equal(doneTwo?.phases[0]?.actors[0]?.name, '乙');
  assert.equal(doneOne?.artifacts[0]?.content, 'out:task-A');
  assert.equal(doneTwo?.artifacts[0]?.content, 'out:task-B');
  assert.equal((await readRuns(dir)).length, 2);
});

test('入参校验：name/script 为空与 script 超长都拒绝启动', async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const service = await createWorkflowService({
    dataDir: dir,
    spawn: async () => ({ ok: true, output: '' }),
  });
  await assert.rejects(service.start({ name: '', script: 'x' }), /name/);
  await assert.rejects(service.start({ name: 'x', script: '   ' }), /script/);
  await assert.rejects(service.start({ name: 'x', script: 'a'.repeat(20_001) }), /20000/);
  assert.deepEqual(service.list(), []);
});
