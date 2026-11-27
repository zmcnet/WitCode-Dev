/**
 * 内置会话工具：session_search / session_export。
 *
 * search 用来找以前的对话（跨会话全文检索），export 用来导出当前会话或指定会话。
 * 两者只读，不修改会话存储。
 */

import type {
  SessionRecord,
  SessionStore,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '@witcode/protocol';

const MAX_EXPORT_CHARS = 50_000;
const TRUNCATED_MARKER = '\n\n…（已截断，超过 50000 字符）';

const SEARCH_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    query: { type: 'string', description: '要搜索的关键词（首尾空白会被忽略）' },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 20,
      description: '最多返回几条会话，默认 10，取值范围 1..20',
    },
  },
  required: ['query'],
};

const EXPORT_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    sessionId: { type: 'string', description: '要导出的会话 ID；不填则导出当前会话' },
    format: {
      type: 'string',
      enum: ['markdown', 'json'],
      description: '导出格式，默认 markdown',
    },
  },
};

function ok(content: string): ToolResult {
  return { ok: true, content };
}

function fail(error: string): ToolResult {
  return { ok: false, content: '', error };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  return input as Record<string, unknown>;
}

function formatTime(timestamp: number): string {
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : String(timestamp);
}

function capExport(text: string): string {
  if (text.length <= MAX_EXPORT_CHARS) return text;
  return `${text.slice(0, MAX_EXPORT_CHARS - TRUNCATED_MARKER.length)}${TRUNCATED_MARKER}`;
}

function renderMarkdown(record: SessionRecord): string {
  const lines: string[] = [
    `# ${record.title}`,
    '',
    `- 会话 ID: ${record.id}`,
    `- 创建时间: ${formatTime(record.createdAt)}`,
    `- 更新时间: ${formatTime(record.updatedAt)}`,
    '',
    '## 消息',
    '',
  ];
  record.messages.forEach((message, index) => {
    lines.push(`### ${index + 1}. ${message.role}`, '');
    if (message.content) lines.push(message.content, '');
    if (message.toolCalls && message.toolCalls.length > 0) {
      lines.push('工具调用:', '', '```json', JSON.stringify(message.toolCalls, null, 2), '```', '');
    }
  });
  return lines.join('\n').trimEnd();
}

export function createSessionTools(store: SessionStore): ToolDefinition[] {
  const sessionSearch: ToolDefinition = {
    name: 'session_search',
    description:
      '跨所有历史会话搜索消息内容，用来找以前的对话。输入关键词（可传 limit，1..20，默认 10），返回按会话更新时间倒序的编号列表，每项包含标题、更新时间、命中片段和 sessionId；拿到 sessionId 后可用 session_export 导出全文。',
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    riskLevel: 'low',
    inputSchema: SEARCH_INPUT_SCHEMA,
    async execute(input: unknown, _ctx: ToolContext | undefined): Promise<ToolResult> {
      const args = asRecord(input);
      if (!args) return fail('invalid input: expected an object');

      const query = typeof args['query'] === 'string' ? args['query'].trim() : '';
      if (!query) return fail('query 不能为空');

      let limit = 10;
      if (args['limit'] !== undefined) {
        if (typeof args['limit'] !== 'number' || !Number.isFinite(args['limit'])) {
          return fail('limit 必须是数字');
        }
        limit = Math.min(20, Math.max(1, Math.trunc(args['limit'])));
      }

      try {
        const hits = await store.search(query, limit);
        if (hits.length === 0) return ok('未找到匹配的会话。');
        return ok(
          hits
            .map(
              (hit, index) =>
                `${index + 1}. ${hit.title}\n` +
                `   时间: ${formatTime(hit.updatedAt)}\n` +
                `   片段: ${hit.snippet}\n` +
                `   sessionId: ${hit.sessionId}`,
            )
            .join('\n\n'),
        );
      } catch (err) {
        return fail(`搜索失败：${errorMessage(err)}`);
      }
    },
  };

  const sessionExport: ToolDefinition = {
    name: 'session_export',
    description:
      '导出会话全文：不传 sessionId 时导出当前会话，也可指定 sessionId 导出以前的对话。format=markdown（默认）生成可读 Markdown，含标题、时间、每条消息的 role 与正文，工具调用以 JSON 代码块呈现；format=json 返回原始记录。输出上限 50000 字符。',
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    riskLevel: 'low',
    inputSchema: EXPORT_INPUT_SCHEMA,
    async execute(input: unknown, ctx: ToolContext | undefined): Promise<ToolResult> {
      const args = asRecord(input) ?? {};

      const rawId = args['sessionId'];
      const fromInput = typeof rawId === 'string' ? rawId.trim() : '';
      const sessionId = fromInput || (typeof ctx?.sessionId === 'string' ? ctx.sessionId.trim() : '');
      if (!sessionId) return fail('缺少 sessionId：请传入 sessionId，或在会话上下文中导出当前会话');

      const format = args['format'] ?? 'markdown';
      if (format !== 'markdown' && format !== 'json') {
        return fail('format 只能是 markdown 或 json');
      }

      try {
        const record = await store.get(sessionId);
        if (!record) return fail(`会话不存在 (not found): ${sessionId}`);
        const text = format === 'json' ? JSON.stringify(record, null, 2) : renderMarkdown(record);
        return ok(capExport(text));
      } catch (err) {
        return fail(`导出失败：${errorMessage(err)}`);
      }
    },
  };

  return [sessionSearch, sessionExport];
}
