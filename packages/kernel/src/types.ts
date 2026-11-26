/**
 * WitCode 内核的类型定义。
 *
 * 目标：内核只做四件事——注册服务、加载插件、发事件、卸载清理。
 * 任何具体能力（模型、工具、界面、存储）都应该是插件。
 */

export type Disposer = () => void | Promise<void>;

/** 插件清单（未来用于从磁盘/市场加载插件）。 */
export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  main?: string;
  /** 依赖的服务名；缺一个就排队等待。 */
  inject?: string[];
  /** 本插件提供的服务名。 */
  provides?: string[];
  /** 界面插件的入口（浏览器里以 iframe 加载）。 */
  web?: { entry: string };
}

/** 插件就是一个带名字的 apply 函数。 */
export interface Plugin {
  name: string;
  inject?: string[];
  apply: (ctx: Context) => void | Promise<void>;
  manifest?: PluginManifest;
}

export type EventHandler = (...args: unknown[]) => unknown;

/**
 * 插件拿到的上下文。
 *
 * 每个插件拿到的是自己的作用域：通过它注册的服务、事件、副作用
 * 都会在插件卸载时自动清理（逆序执行）。
 */
export interface Context {
  readonly name: string;

  get<T = unknown>(service: string): T;
  has(service: string): boolean;

  /** 注册一个服务；返回清理函数。 */
  provide<T>(service: string, value: T): Disposer;

  /** 监听事件；返回取消函数。 */
  on(event: string, handler: EventHandler): Disposer;

  /** 广播事件（同步，不等待返回值）。 */
  emit(event: string, ...args: unknown[]): void;

  /** 管道式事件：每个处理器的返回值作为下一个的输入。 */
  waterfall<T>(event: string, value: T, ...args: unknown[]): Promise<T>;

  /** 把任意副作用包起来，返回清理函数。 */
  effect(setup: () => Disposer): Disposer;

  /** 加载一个子插件。 */
  plugin(plugin: Plugin): Promise<Disposer>;
}

export interface KernelOptions {
  /** 插件抛错时的兜底处理；默认打印到 console.error。 */
  onError?: (error: unknown, plugin?: string) => void;
}
