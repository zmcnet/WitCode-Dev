import type { Context, Disposer, EventHandler, KernelOptions, Plugin } from './types.js';

interface PluginRecord {
  plugin: Plugin;
  disposers: Disposer[];
}

/**
 * 插座板：服务容器 + 插件生命周期 + 事件总线。
 *
 * 设计约束：
 * - 内核不超过 1000 行；长了说明能力放错了地方。
 * - 插件注册的一切都必须可撤销。
 * - 依赖按服务名匹配，不按 import 顺序。
 */
export class Kernel implements Context {
  readonly name = 'root';

  private readonly services = new Map<string, unknown>();
  private readonly listeners = new Map<string, Set<EventHandler>>();
  private readonly plugins = new Map<string, PluginRecord>();
  private pending: Plugin[] = [];
  private flushing = false;
  private readonly options: KernelOptions;

  constructor(options: KernelOptions = {}) {
    this.options = options;
  }

  get<T = unknown>(service: string): T {
    if (!this.services.has(service)) {
      throw new Error(`[witcode] service not found: ${service}`);
    }
    return this.services.get(service) as T;
  }

  has(service: string): boolean {
    return this.services.has(service);
  }

  provide<T>(service: string, value: T): Disposer {
    if (this.services.has(service)) {
      throw new Error(`[witcode] service already provided: ${service}`);
    }
    this.services.set(service, value);
    void this.flushPending();
    return () => {
      if (this.services.get(service) === value) {
        this.services.delete(service);
      }
    };
  }

  on(event: string, handler: EventHandler): Disposer {
    const set = this.listeners.get(event) ?? new Set<EventHandler>();
    set.add(handler);
    this.listeners.set(event, set);
    return () => {
      set.delete(handler);
      if (set.size === 0) {
        this.listeners.delete(event);
      }
    };
  }

  emit(event: string, ...args: unknown[]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        handler(...args);
      } catch (error) {
        this.report(error);
      }
    }
  }

  async waterfall<T>(event: string, value: T, ...args: unknown[]): Promise<T> {
    const set = this.listeners.get(event);
    if (!set) return value;
    let current = value;
    for (const handler of [...set]) {
      try {
        const next = await handler(current, ...args);
        if (next !== undefined) {
          current = next as T;
        }
      } catch (error) {
        this.report(error);
      }
    }
    return current;
  }

  effect(setup: () => Disposer): Disposer {
    return setup();
  }

  async plugin(plugin: Plugin): Promise<Disposer> {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`[witcode] plugin already loaded: ${plugin.name}`);
    }

    const missing = (plugin.inject ?? []).filter((name) => !this.services.has(name));
    if (missing.length > 0) {
      this.pending.push(plugin);
      return () => {
        // 取消排队；如果它已经被依赖满足后自动加载，则正常卸载。
        this.pending = this.pending.filter((item) => item !== plugin);
        if (this.plugins.has(plugin.name)) {
          return this.unload(plugin.name);
        }
      };
    }

    return this.load(plugin);
  }

  /** 当前已加载的插件名（按加载顺序）。 */
  list(): string[] {
    return [...this.plugins.keys()];
  }

  private async load(plugin: Plugin): Promise<Disposer> {
    const disposers: Disposer[] = [];
    const scoped = this.scoped(plugin.name, disposers);

    try {
      await plugin.apply(scoped);
    } catch (error) {
      // apply 失败：把已注册的服务/监听/副作用全部收回，不留泄漏。
      for (const dispose of [...disposers].reverse()) {
        try {
          await dispose();
        } catch (cleanupError) {
          this.report(cleanupError, plugin.name);
        }
      }
      throw error;
    }

    this.plugins.set(plugin.name, { plugin, disposers });
    this.emit('plugin/loaded', plugin.name);

    return () => this.unload(plugin.name);
  }

  private async unload(name: string): Promise<void> {
    const record = this.plugins.get(name);
    if (!record) return;

    this.plugins.delete(name);

    for (const dispose of [...record.disposers].reverse()) {
      try {
        await dispose();
      } catch (error) {
        this.report(error, name);
      }
    }

    this.emit('plugin/unloaded', name);
  }

  private scoped(name: string, disposers: Disposer[]): Context {
    const root = this;

    return {
      name,
      get: (service) => root.get(service),
      has: (service) => root.has(service),
      provide: (service, value) => {
        const dispose = root.provide(service, value);
        disposers.push(dispose);
        return dispose;
      },
      on: (event, handler) => {
        const dispose = root.on(event, handler);
        disposers.push(dispose);
        return dispose;
      },
      emit: (event, ...args) => root.emit(event, ...args),
      waterfall: (event, value, ...args) => root.waterfall(event, value, ...args),
      effect: (setup) => {
        const dispose = setup();
        disposers.push(dispose);
        return dispose;
      },
      plugin: (child) => root.plugin(child),
    };
  }

  private async flushPending(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;

    try {
      let progressed = true;
      while (progressed) {
        progressed = false;

        const ready = this.pending.filter((plugin) =>
          (plugin.inject ?? []).every((name) => this.services.has(name)),
        );
        if (ready.length === 0) return;

        this.pending = this.pending.filter((plugin) => !ready.includes(plugin));

        for (const plugin of ready) {
          try {
            await this.load(plugin);
            progressed = true;
          } catch (error) {
            this.report(error, plugin.name);
          }
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private report(error: unknown, plugin?: string): void {
    if (this.options.onError) {
      this.options.onError(error, plugin);
      return;
    }
    console.error(`[witcode]${plugin ? ` plugin ${plugin}:` : ''}`, error);
  }
}
