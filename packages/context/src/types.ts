import type { ChatMessage } from '@witcode/protocol';
import type {
  CompressionBlock,
  CompressCall,
  CompressionState,
  StatusReport,
} from 'acp-kernel';

export type ContextMode = 'off' | 'summary' | 'acp';

/** acp-kernel owns the per-session compression state; we persist it as-is. */
export type ContextState = CompressionState;

export type { CompressionBlock, CompressCall, StatusReport };

export interface ContextStateStore {
  get(sessionId: string): Promise<ContextState | null>;
  set(sessionId: string, state: ContextState): Promise<void>;
  delete(sessionId: string): Promise<void>;
}

export interface ContextManagerOptions {
  mode: ContextMode;
  /** summary 模式下的摘要函数；不传则退化为“保留最近 N 条 + 占位提示” */
  summarize?: (messages: ChatMessage[]) => Promise<string>;
  /** 保留最近多少条消息（默认 24） */
  keepRecent?: number;
  modelContextLimit?: number;
  stateStore?: ContextStateStore;
}

export interface BeforeRequestResult {
  messages: ChatMessage[];
  nudge?: string;
}

export interface ApplyCompressionResult {
  blocksCreated: number;
  tokensCompressed: number;
  errors: string[];
}

export interface ContextManager {
  /** 暴露模式供工具注册层判断是否注册 acp 工具。 */
  readonly mode: ContextMode;
  beforeRequest(
    sessionId: string,
    messages: ChatMessage[],
  ): Promise<BeforeRequestResult>;
  applyCompression(
    sessionId: string,
    call: CompressCall,
  ): Promise<ApplyCompressionResult>;
  decompress(sessionId: string, blockId: string): Promise<CompressionBlock | undefined>;
  search(sessionId: string, query: string): Promise<CompressionBlock[]>;
  status(sessionId: string): Promise<unknown>;
  reset(sessionId: string): Promise<void>;
}
