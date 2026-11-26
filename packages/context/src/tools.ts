import type { ToolContext, ToolDefinition, ToolResult } from '@witcode/protocol';
import type { CompressRangeSpec } from 'acp-kernel';
import type { ContextManager } from './types.ts';

function ok(content: string): ToolResult {
  return { ok: true, content };
}

function fail(message: string): ToolResult {
  return { ok: false, content: message, error: message };
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  return input as Record<string, unknown>;
}

function sessionIdOf(
  input: Record<string, unknown>,
  ctx: ToolContext,
  fallback: string,
): string {
  const fromInput = input['sessionId'];
  if (typeof fromInput === 'string' && fromInput) return fromInput;
  const fromCtx = (ctx as ToolContext & { sessionId?: string }).sessionId;
  return typeof fromCtx === 'string' && fromCtx ? fromCtx : fallback;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseRanges(value: unknown): CompressRangeSpec[] | string {
  if (!Array.isArray(value) || value.length === 0) {
    return 'invalid input: "ranges" must be a non-empty array';
  }
  const ranges: CompressRangeSpec[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const item = asRecord(value[i]);
    if (!item) return `invalid input: ranges[${i}] must be an object`;
    const startRef = readString(item['startRef']);
    const endRef = readString(item['endRef']);
    const summary = readString(item['summary']);
    if (!startRef) return `invalid input: ranges[${i}].startRef must be a non-empty string`;
    if (!endRef) return `invalid input: ranges[${i}].endRef must be a non-empty string`;
    if (!summary) return `invalid input: ranges[${i}].summary must be a non-empty string`;
    const topic = item['topic'];
    if (topic !== undefined && typeof topic !== 'string') {
      return `invalid input: ranges[${i}].topic must be a string`;
    }
    ranges.push(
      topic === undefined
        ? { startRef, endRef, summary }
        : { startRef, endRef, summary, topic },
    );
  }
  return ranges;
}

/**
 * 注册上下文工具。mode !== 'acp' 时不注册任何工具。
 * sessionId 可在构造时绑定，也可由工具调用方通过 input/context 传入。
 */
export function contextTools(
  manager: ContextManager,
  sessionId = 'default',
): ToolDefinition[] {
  if (manager.mode !== 'acp') return [];

  return [
    {
      name: 'compress',
      description:
        'Compress a range of earlier messages into a summary written by you. Use refs from acp_status or the <acp> tags in the conversation.',
      inputSchema: {
        type: 'object',
        properties: {
          ranges: {
            type: 'array',
            description: 'Ranges to compress; each becomes one compression block.',
            items: {
              type: 'object',
              properties: {
                startRef: { type: 'string', description: 'First message ref, e.g. m00005' },
                endRef: { type: 'string', description: 'Last message ref, e.g. m00020' },
                summary: { type: 'string', description: 'Your summary of the range' },
                topic: { type: 'string', description: 'Optional short topic label' },
              },
              required: ['startRef', 'endRef', 'summary'],
            },
          },
        },
        required: ['ranges'],
      },
      async execute(input, ctx) {
        const args = asRecord(input);
        if (!args) return fail('invalid input: expected an object');
        const ranges = parseRanges(args['ranges']);
        if (typeof ranges === 'string') return fail(ranges);
        const result = await manager.applyCompression(sessionIdOf(args, ctx, sessionId), {
          mode: 'range',
          ranges,
        });
        return ok(JSON.stringify(result));
      },
    },
    {
      name: 'decompress',
      description: 'Expand a compressed block and read its stored summary.',
      inputSchema: {
        type: 'object',
        properties: {
          blockId: { type: 'string', description: 'Block id, e.g. b1' },
        },
        required: ['blockId'],
      },
      async execute(input, ctx) {
        const args = asRecord(input);
        if (!args) return fail('invalid input: expected an object');
        const blockId = readString(args['blockId']);
        if (!blockId) return fail('invalid input: "blockId" must be a non-empty string');
        const block = await manager.decompress(sessionIdOf(args, ctx, sessionId), blockId);
        if (!block) return ok(`block ${blockId} not found`);
        return ok(
          JSON.stringify({
            blockId: block.blockId,
            topic: block.topic,
            summary: block.summary,
          }),
        );
      },
    },
    {
      name: 'search_context',
      description: 'Search summaries of compressed blocks by keyword.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keywords to look for' },
        },
        required: ['query'],
      },
      async execute(input, ctx) {
        const args = asRecord(input);
        if (!args) return fail('invalid input: expected an object');
        const query = readString(args['query']);
        if (!query) return fail('invalid input: "query" must be a non-empty string');
        const blocks = await manager.search(sessionIdOf(args, ctx, sessionId), query);
        return ok(
          JSON.stringify(
            blocks.map((block) => ({
              blockId: block.blockId,
              topic: block.topic,
              summary: block.summary,
            })),
          ),
        );
      },
    },
    {
      name: 'acp_status',
      description: 'Report context usage and compression-block statistics.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      async execute(_input, ctx) {
        const status = await manager.status(sessionIdOf(asRecord(_input) ?? {}, ctx, sessionId));
        return ok(JSON.stringify(status));
      },
    },
  ];
}
