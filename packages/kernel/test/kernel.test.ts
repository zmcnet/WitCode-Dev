import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Kernel } from '../src/kernel.ts';

/** 让内核里所有 await（flushPending / unload）走完微任务队列。 */
const tick = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

// ---------------------------------------------------------------------------
// 服务容器
// ---------------------------------------------------------------------------

test('provide/get/has：注册、读取与重复注册报错', () => {
  const kernel = new Kernel();

  assert.equal(kernel.has('db'), false);
  assert.throws(() => kernel.get('db'), /service not found: db/);

  const value = { url: 'sqlite::memory:' };
  const dispose = kernel.provide('db', value);

  assert.equal(kernel.has('db'), true);
  assert.strictEqual(kernel.get('db'), value);
  assert.throws(() => kernel.provide('db', 'other'), /service already provided: db/);

  dispose();
  assert.equal(kernel.has('db'), false);
});

test('provide 的 disposer 按值身份删除，不会误删后注册的同名服务', () => {
  const kernel = new Kernel();

  const first = kernel.provide('cfg', 'first');
  first();

  const second = kernel.provide('cfg', 'second');
  first(); // 过期的 disposer 再次调用应当无效

  assert.equal(kernel.get('cfg'), 'second');
  second();
  assert.equal(kernel.has('cfg'), false);
});

// ---------------------------------------------------------------------------
// 事件总线
// ---------------------------------------------------------------------------

test('on/emit：emit 同步广播，不等待返回值，返回 undefined', async () => {
  const kernel = new Kernel();
  const calls: string[] = [];

  const off1 = kernel.on('ping', (n) => {
    calls.push(`sync:${String(n)}`);
  });
  const off2 = kernel.on('ping', () => {
    calls.push('async-start');
    return Promise.resolve().then(() => {
      calls.push('async-end');
    });
  });

  assert.equal(kernel.emit('ping', 7), undefined);
  assert.deepEqual(calls, ['sync:7', 'async-start']);

  await tick();
  assert.deepEqual(calls, ['sync:7', 'async-start', 'async-end']);

  off1();
  off2();
  kernel.emit('ping', 8);
  assert.equal(calls.length, 3);
});

test('emit 使用监听器快照：回调中取消监听不影响本次广播', () => {
  const kernel = new Kernel();
  const calls: string[] = [];

  let offSecond: (() => void) | undefined;
  offSecond = kernel.on('e', () => {
    calls.push('second');
  });
  kernel.on('e', () => {
    offSecond?.();
    calls.push('remover');
  });

  kernel.emit('e');
  assert.deepEqual(calls, ['second', 'remover']);

  kernel.emit('e');
  assert.deepEqual(calls, ['second', 'remover', 'remover']);
});

test('emit：单个 handler 抛错被隔离并通过 onError 上报', () => {
  const errors: Array<{ error: unknown; plugin?: string }> = [];
  const kernel = new Kernel({
    onError: (error, plugin) => {
      errors.push({ error, plugin });
    },
  });
  const calls: string[] = [];

  const off = kernel.on('e', () => {
    throw new Error('boom');
  });
  kernel.on('e', () => {
    calls.push('after');
  });

  assert.doesNotThrow(() => kernel.emit('e'));
  assert.deepEqual(calls, ['after']);
  assert.equal(errors.length, 1);
  assert.match((errors[0]?.error as Error).message, /boom/);
  off();
});

test('waterfall：按顺序传递返回值，异步 handler 也串行', async () => {
  const kernel = new Kernel();
  const order: string[] = [];

  kernel.on('pipe', (value) => {
    order.push('h1');
    return `${String(value)}a`;
  });
  kernel.on('pipe', async (value) => {
    await tick();
    order.push('h2');
    return `${String(value)}b`;
  });

  assert.equal(await kernel.waterfall('pipe', ''), 'ab');
  assert.deepEqual(order, ['h1', 'h2']);
});

test('waterfall：无监听返回原值；返回 undefined 保持当前值并透传额外参数', async () => {
  const kernel = new Kernel();

  assert.equal(await kernel.waterfall('p', 'seed'), 'seed');

  const seen: unknown[][] = [];
  const off1 = kernel.on('p', (value, extra) => {
    seen.push([value, extra]);
    return undefined;
  });
  const off2 = kernel.on('p', (value, extra) => {
    seen.push([value, extra]);
    return `${String(value)}-x`;
  });

  assert.equal(await kernel.waterfall('p', 'v', 'arg'), 'v-x');
  assert.deepEqual(seen, [
    ['v', 'arg'],
    ['v', 'arg'],
  ]);

  off1();
  off2();
});

test('waterfall：handler 抛错被上报且链继续', async () => {
  const errors: unknown[] = [];
  const kernel = new Kernel({
    onError: (error) => {
      errors.push(error);
    },
  });

  kernel.on('p', () => {
    throw new Error('boom');
  });
  kernel.on('p', (value) => `${String(value)}!`);

  assert.equal(await kernel.waterfall('p', 'v'), 'v!');
  assert.equal(errors.length, 1);
});

// ---------------------------------------------------------------------------
// 插件生命周期
// ---------------------------------------------------------------------------

test('plugin：立即加载、触发 plugin/loaded，同名插件重复加载报错', async () => {
  const kernel = new Kernel();
  const loaded: string[] = [];
  kernel.on('plugin/loaded', (name) => {
    loaded.push(String(name));
  });

  const dispose = await kernel.plugin({ name: 'p', apply() {} });

  assert.deepEqual(kernel.list(), ['p']);
  assert.deepEqual(loaded, ['p']);
  await assert.rejects(kernel.plugin({ name: 'p', apply() {} }), /plugin already loaded: p/);

  await dispose();
  assert.deepEqual(kernel.list(), []);
});

test('plugin：inject 缺依赖时排队，依赖出现后自动加载', async () => {
  const kernel = new Kernel();
  const applied: string[] = [];

  const unload = await kernel.plugin({
    name: 'repo',
    inject: ['db'],
    apply(ctx) {
      applied.push('repo');
      ctx.provide('repository', `${String(ctx.get('db'))}/repo`);
    },
  });

  assert.deepEqual(kernel.list(), []);
  assert.deepEqual(applied, []);
  assert.equal(kernel.has('repository'), false);

  kernel.provide('db', 'main');
  await tick();

  assert.deepEqual(kernel.list(), ['repo']);
  assert.deepEqual(applied, ['repo']);
  assert.equal(kernel.get('repository'), 'main/repo');

  // 注意：unload() 是排队阶段返回的「取消排队」函数，依赖满足后它不会变成
  // 真正的卸载函数；该缺陷见下面的 test.skip。
  assert.equal(typeof unload, 'function');
});

test('plugin：pending 插件的 disposer 可以取消排队', async () => {
  const kernel = new Kernel();
  let applied = false;

  const cancel = await kernel.plugin({
    name: 'waiting',
    inject: ['db'],
    apply() {
      applied = true;
    },
  });

  await cancel();
  kernel.provide('db', 1);
  await tick();

  assert.equal(applied, false);
  assert.deepEqual(kernel.list(), []);
});

test('plugin：卸载清理它注册的服务、监听与 effect（逆序）', async () => {
  const kernel = new Kernel();
  const cleanupOrder: string[] = [];
  let hits = 0;

  const unload = await kernel.plugin({
    name: 'feature',
    apply(ctx) {
      assert.equal(ctx.name, 'feature');
      ctx.provide('svc', 42);
      ctx.on('evt', () => {
        hits += 1;
      });
      ctx.effect(() => {
        cleanupOrder.push('setup-1');
        return () => {
          cleanupOrder.push('clean-1');
        };
      });
      ctx.effect(() => {
        cleanupOrder.push('setup-2');
        return () => {
          cleanupOrder.push('clean-2');
        };
      });
    },
  });

  assert.equal(kernel.get('svc'), 42);
  kernel.emit('evt');
  assert.equal(hits, 1);

  await unload();

  assert.equal(kernel.has('svc'), false);
  kernel.emit('evt');
  assert.equal(hits, 1);
  assert.deepEqual(cleanupOrder, ['setup-1', 'setup-2', 'clean-2', 'clean-1']);
});

test('plugin：apply 抛错不会注册插件，也不影响其他插件', async () => {
  const kernel = new Kernel();
  const loaded: string[] = [];
  kernel.on('plugin/loaded', (name) => {
    loaded.push(String(name));
  });

  const unloadA = await kernel.plugin({
    name: 'a',
    apply(ctx) {
      ctx.provide('a', 1);
    },
  });

  await assert.rejects(
    kernel.plugin({
      name: 'bad',
      apply() {
        throw new Error('boom');
      },
    }),
    /boom/,
  );

  const unloadB = await kernel.plugin({
    name: 'b',
    apply(ctx) {
      ctx.provide('b', 2);
    },
  });

  assert.deepEqual(kernel.list(), ['a', 'b']);
  assert.deepEqual(loaded, ['a', 'b']);
  assert.equal(kernel.get('a'), 1);
  assert.equal(kernel.get('b'), 2);

  await unloadA();
  await unloadB();
});

test('plugin：排队的插件 apply 抛错时通过 onError 上报且保持未加载', async () => {
  const errors: Array<{ error: unknown; plugin?: string }> = [];
  const kernel = new Kernel({
    onError: (error, plugin) => {
      errors.push({ error, plugin });
    },
  });

  await kernel.plugin({
    name: 'bad-pending',
    inject: ['dep'],
    apply() {
      throw new Error('boom');
    },
  });

  kernel.provide('dep', 1);
  await tick();

  assert.deepEqual(kernel.list(), []);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.plugin, 'bad-pending');
  assert.match((errors[0]?.error as Error).message, /boom/);
});

test('[已修复] 排队插件加载后，plugin() 返回的 disposer 应能卸载它', async () => {
  const kernel = new Kernel();

  const dispose = await kernel.plugin({
    name: 'deferred',
    inject: ['dep'],
    apply(ctx) {
      ctx.provide('feature', 1);
    },
  });
  kernel.provide('dep', 1);
  await tick();

  // 当前实现中 dispose 只是把插件从 pending 里过滤掉；插件一旦通过
  // flushPending 加载，这个 disposer 就再也不能卸载它了。
  await dispose();
  assert.deepEqual(kernel.list(), []);
  assert.equal(kernel.has('feature'), false);
});

test('[已修复] apply 抛错时应回滚该插件已注册的服务/监听', async () => {
  const kernel = new Kernel();

  await assert.rejects(
    kernel.plugin({
      name: 'leaky',
      apply(ctx) {
        ctx.provide('leaked', 1);
        throw new Error('boom');
      },
    }),
    /boom/,
  );

  // kernel.ts 的 load() 在 apply 抛错时不会写入 plugins，也不会执行已收集的
  // disposers，因此 ctx.provide/ctx.on 的副作用会残留在 root 上。修复后断言应通过。
  assert.equal(kernel.has('leaked'), false);
});
