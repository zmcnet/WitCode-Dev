import type { ChatMessage } from '@witcode/protocol';
import { historyToMessages } from '../src/history.ts';

function same(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}\n  expected: ${e}\n  actual:   ${a}`);
}

function basicAndToolResult(): void {
  const history: ChatMessage[] = [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: '读一下 a.txt' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'read_file', input: { path: 'a.txt' } }],
    },
    { role: 'tool', content: 'hello', toolCallId: 'c1', toolName: 'read_file' },
    { role: 'assistant', content: '读到了 hello' },
  ];

  same(
    historyToMessages(history),
    [
      {
        id: 'history-1',
        role: 'user',
        text: '读一下 a.txt',
        streaming: false,
        toolCalls: [],
      },
      {
        id: 'history-2',
        role: 'assistant',
        text: '',
        streaming: false,
        toolCalls: [
          {
            id: 'history-2-0-c1',
            name: 'read_file',
            input: { path: 'a.txt' },
            result: { ok: true, content: 'hello' },
          },
        ],
      },
      {
        id: 'history-4',
        role: 'assistant',
        text: '读到了 hello',
        streaming: false,
        toolCalls: [],
      },
    ],
    'system 被忽略、tool 归入对应卡片、消息不流式',
  );
}

function failedResult(): void {
  const history: ChatMessage[] = [
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c2', name: 'run_command', input: { command: 'bad' } }],
    },
    {
      role: 'tool',
      content: 'ERROR: command failed',
      toolCallId: 'c2',
      toolName: 'run_command',
    },
  ];

  const messages = historyToMessages(history);
  const call = messages[0]?.toolCalls[0];
  same(
    call?.result,
    { ok: false, content: 'command failed' },
    'ERROR: 前缀映射为失败结果并去掉前缀',
  );
}

function nameFallback(): void {
  const history: ChatMessage[] = [
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'a1', name: 'read_file', input: {} },
        { id: 'a2', name: 'read_file', input: {} },
      ],
    },
    { role: 'tool', content: 'first', toolName: 'read_file' },
    { role: 'tool', content: 'ERROR: second failed', toolName: 'read_file' },
  ];

  const call = historyToMessages(history)[0]?.toolCalls;
  same(call?.[0]?.result, { ok: true, content: 'first' }, '无名结果按名字 FIFO 匹配第一个调用');
  same(
    call?.[1]?.result,
    { ok: false, content: 'second failed' },
    '无名结果按名字 FIFO 匹配第二个调用',
  );
}

function idWinsOverName(): void {
  const history: ChatMessage[] = [
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'x', name: 'grep', input: {} },
        { id: 'y', name: 'grep', input: {} },
      ],
    },
    { role: 'tool', content: 'by-name', toolName: 'grep' },
    { role: 'tool', content: 'by-id', toolCallId: 'y', toolName: 'grep' },
  ];

  const call = historyToMessages(history)[0]?.toolCalls;
  same(call?.[0]?.result, { ok: true, content: 'by-name' }, '无 id 的调用用名字兜底');
  same(call?.[1]?.result, { ok: true, content: 'by-id' }, 'toolCallId 优先于名字');
}

basicAndToolResult();
failedResult();
nameFallback();
idWinsOverName();
console.log('history.test.ts: 4 checks passed');
