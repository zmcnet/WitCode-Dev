import type {
  ChatMessage,
  ModelChunk,
  ModelProvider,
  ModelRequest,
} from '@witcode/protocol';

export interface OpenAIProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 统一最大输出；不传则 128K。 */
  maxOutputTokens?: number;
}

interface CompletionChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface PendingToolCall {
  id: string;
  name: string;
  args: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function completionUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (normalized.endsWith('/chat/completions')) return normalized;
  return `${normalized}/chat/completions`;
}

function toOpenAIMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.map((message) =>
    message.role === 'tool'
      ? {
          role: 'tool',
          content: message.content,
          tool_call_id: message.toolCallId ?? '',
        }
      : { role: message.role, content: message.content },
  );
}

function parseArguments(raw: string): unknown {
  const text = raw.trim();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function* drainToolCalls(pending: Map<number, PendingToolCall>): Generator<ModelChunk> {
  const indexes = [...pending.keys()].sort((a, b) => a - b);
  for (const index of indexes) {
    const call = pending.get(index);
    if (!call) continue;
    pending.delete(index);
    yield {
      type: 'tool-call',
      call: {
        id: call.id || `call_${index}`,
        name: call.name,
        input: parseArguments(call.args),
      },
    };
  }
}

async function* parseEventStream(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<ModelChunk> {
  const reader = response.body?.getReader();
  if (!reader) {
    yield { type: 'error', message: '模型服务没有返回可读的响应流' };
    return;
  }

  const pending = new Map<number, PendingToolCall>();
  const state: {
    done: boolean;
    failed: boolean;
    usage?: { input: number; output: number };
  } = { done: false, failed: false };

  function* consumeLine(line: string): Generator<ModelChunk> {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;

    const data = trimmed.slice('data:'.length).trim();
    if (data === '[DONE]') {
      state.done = true;
      return;
    }
    if (!data) return;

    let chunk: CompletionChunk;
    try {
      chunk = JSON.parse(data) as CompletionChunk;
    } catch {
      state.failed = true;
      state.done = true;
      yield { type: 'error', message: '无法解析模型服务返回的 SSE 数据' };
      return;
    }

    if (chunk.usage) {
      state.usage = {
        input: chunk.usage.prompt_tokens ?? 0,
        output: chunk.usage.completion_tokens ?? 0,
      };
    }

    const choice = chunk.choices?.[0];
    const text = choice?.delta?.content;
    if (typeof text === 'string' && text.length > 0) {
      yield { type: 'text', text };
    }

    for (const fragment of choice?.delta?.tool_calls ?? []) {
      const index = fragment.index ?? 0;
      const call = pending.get(index) ?? { id: '', name: '', args: '' };
      if (fragment.id) call.id = fragment.id;
      if (fragment.function?.name) call.name += fragment.function.name;
      if (fragment.function?.arguments) call.args += fragment.function.arguments;
      pending.set(index, call);
    }

    // finish_reason 表示本轮生成结束，此时参数片段已完整。
    if (choice?.finish_reason) {
      yield* drainToolCalls(pending);
    }
  }

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (!state.done) {
      const { value, done: readerDone } = await reader.read();
      if (readerDone) break;

      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        yield* consumeLine(line);
        if (state.done) break;
        newline = buffer.indexOf('\n');
      }
    }

    // 有些实现最后一行不带换行符。
    if (!state.done && buffer.length > 0) {
      yield* consumeLine(buffer);
    }

    if (!state.failed) {
      yield* drainToolCalls(pending);
      yield { type: 'done', usage: state.usage };
    }
  } catch (error) {
    if (signal?.aborted) return;
    yield { type: 'error', message: `模型响应流中断：${errorMessage(error)}` };
  } finally {
    reader.releaseLock();
  }
}

export function createOpenAIProvider(config: OpenAIProviderConfig): ModelProvider {
  const url = completionUrl(config.baseUrl);

  return {
    id: `openai:${config.model}`,

    async *stream(request: ModelRequest, signal?: AbortSignal): AsyncGenerator<ModelChunk> {
      const body: Record<string, unknown> = {
        model: config.model,
        messages: toOpenAIMessages(request.messages),
        stream: true,
        max_tokens: config.maxOutputTokens ?? 128_000,
      };
      if (request.tools && request.tools.length > 0) {
        body.tools = request.tools.map((tool) => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        }));
      }

      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify(body),
          signal,
        });
      } catch (error) {
        if (signal?.aborted) return;
        yield { type: 'error', message: `无法连接模型服务：${errorMessage(error)}` };
        return;
      }

      if (!response.ok) {
        let detail = '';
        try {
          detail = (await response.text()).slice(0, 500);
        } catch {
          // 响应体不可读时只报告状态码。
        }
        yield {
          type: 'error',
          message: `模型服务返回 ${response.status}${detail ? `：${detail}` : ''}`,
        };
        return;
      }

      yield* parseEventStream(response, signal);
    },
  };
}

function readEnv(name: string): string {
  return (process.env[name] ?? '').trim();
}

export function createProviderFromEnv(): ModelProvider | null {
  const baseUrl = readEnv('WITCODE_BASE_URL');
  const apiKey = readEnv('WITCODE_API_KEY');
  const model = readEnv('WITCODE_MODEL');
  if (!baseUrl || !apiKey || !model) return null;
  return createOpenAIProvider({ baseUrl, apiKey, model });
}
