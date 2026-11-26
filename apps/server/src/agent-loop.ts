/**
 * 工作循环：想 → 调工具 → 看结果 → 再想。
 *
 * 这是 WitCode 的「大脑」最小版本。它不关心模型是谁、工具怎么实现，
 * 只依赖协议里的三个接口：ModelProvider、ToolService、ChatMessage。
 *
 * 设计约束：
 * - 有最大步数，避免无限循环。
 * - 每轮把 assistant 的文本与工具调用都写回历史。
 * - 工具失败不崩，作为 tool 消息回给模型，让它自己决定下一步。
 */

import type {
  BrainDefinition,
  ChatMessage,
  ModelProvider,
  RiskLevel,
  ToolCall,
  ToolResult,
  ToolService,
} from '@witcode/protocol';
import type { Security } from '@witcode/security';

export interface AgentLoopOptions {
  provider: ModelProvider;
  tools: ToolService;
  workspace: string;
  /** 当前会话 id；透传给工具。 */
  sessionId?: string;
  /** 子智能体深度：0=主智能体，1..3=子智能体。 */
  depth?: number;
  /** 当前会话使用的脑子：影响工具过滤/描述与步数。 */
  brain?: BrainDefinition;
  /** 安全引擎：权限/路径/命令检查。 */
  security?: Security;
  /** 需要确认时的回调；不提供则按 fail-closed 拒绝。 */
  requestApproval?: (request: {
    tool: string;
    input: unknown;
    title: string;
    detail: string;
    riskLevel: RiskLevel;
    reason: string;
  }) => Promise<'allow' | 'deny'>;
  /** 最多几轮「模型 + 工具」，优先于 brain.loop.maxSteps。 */
  maxSteps?: number;
  signal?: AbortSignal;
  onText?: (text: string) => void;
  onToolCall?: (call: ToolCall) => void;
  onToolResult?: (call: ToolCall, result: ToolResult) => void;
  onStep?: (step: number) => void;
}

export interface AgentLoopResult {
  messages: ChatMessage[];
  steps: number;
  /** 循环是因为达到上限而结束，而不是模型自己说完。 */
  hitLimit: boolean;
}

export async function runAgentLoop(
  input: ChatMessage[],
  options: AgentLoopOptions,
): Promise<AgentLoopResult> {
  const history = [...input];
  const maxSteps = options.maxSteps ?? options.brain?.loop?.maxSteps ?? 20;
  const brain = options.brain;
  const allowed = new Set(brain?.tools.enabled ?? []);
  const blocked = new Set(brain?.tools.disabled ?? []);
  let steps = 0;

  while (steps < maxSteps) {
    if (options.signal?.aborted) {
      return { messages: history, steps, hitLimit: false };
    }

    options.onStep?.(steps);
    steps += 1;

    const toolSchemas = options.tools
      .list()
      .filter(
        (tool) =>
          (allowed.size === 0 || allowed.has(tool.name)) && !blocked.has(tool.name),
      )
      .map((tool) => ({
        name: tool.name,
        description: brain?.tools.descriptions?.[tool.name] ?? tool.description,
        inputSchema: tool.inputSchema,
      }));

    const toolCalls: ToolCall[] = [];
    let text = '';
    let failed: string | null = null;

    for await (const chunk of options.provider.stream(
      { messages: history, tools: toolSchemas },
      options.signal,
    )) {
      if (chunk.type === 'text') {
        text += chunk.text;
        options.onText?.(chunk.text);
      } else if (chunk.type === 'tool-call') {
        toolCalls.push(chunk.call);
      } else if (chunk.type === 'error') {
        failed = chunk.message;
      }
    }

    if (failed) {
      throw new Error(failed);
    }

    if (text.length > 0 || toolCalls.length > 0) {
      history.push({
        role: 'assistant',
        content: text,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      });
    }

    if (toolCalls.length === 0) {
      return { messages: history, steps, hitLimit: false };
    }

    for (const call of toolCalls) {
      if (options.signal?.aborted) {
        return { messages: history, steps, hitLimit: false };
      }

      options.onToolCall?.(call);

      let result: ToolResult;
      const ctx = {
        workspace: options.workspace,
        signal: options.signal,
        sessionId: options.sessionId,
        depth: options.depth ?? 0,
      };
      const tool = options.tools.list().find((item) => item.name === call.name);

      try {
        if (options.security && tool) {
          const resolved = tool.resolveInput
            ? await tool.resolveInput(call.input, ctx)
            : call.input;

          // 路径检查：权限引擎只管模式/命令，路径边界必须在执行前单独校验。
          const targetPath =
            typeof (resolved as { path?: unknown })?.path === 'string'
              ? (resolved as { path: string }).path
              : undefined;
          if (targetPath) {
            const content = (resolved as { content?: unknown })?.content;
            const sizeBytes =
              typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : undefined;
            const pathCheck = tool.readOnly
              ? await options.security.pathGuard.checkForRead(targetPath)
              : await options.security.pathGuard.checkForWrite(targetPath, { sizeBytes });
            if (!pathCheck.ok) {
              options.security.permission.audit({
                at: Date.now(),
                tool: call.name,
                mode: options.security.permission.getMode(),
                decision: 'deny',
                reason: pathCheck.reason ?? '路径不允许',
                riskLevel: tool.riskLevel ?? (tool.destructive ? 'high' : 'low'),
                source: 'rule',
              });
              throw new Error(`路径拒绝：${pathCheck.reason ?? '不允许的路径'}`);
            }
          }

          const decision = options.security.permission.check({
            tool: call.name,
            input: resolved,
            readOnly: tool.readOnly ?? false,
            destructive: tool.destructive ?? false,
            path:
              typeof (resolved as { path?: unknown })?.path === 'string'
                ? (resolved as { path: string }).path
                : undefined,
            command:
              typeof (resolved as { command?: unknown })?.command === 'string'
                ? (resolved as { command: string }).command
                : undefined,
          });

          if (decision.decision === 'deny') {
            result = {
              ok: false,
              content: '',
              error: `权限拒绝：${decision.reason}`,
            };
          } else if (decision.decision === 'ask') {
            if (!options.requestApproval) {
              result = {
                ok: false,
                content: '',
                error: `需要确认，但确认通道不可用：${decision.reason}`,
              };
            } else {
              const preview = tool.prepareApproval
                ? await tool.prepareApproval(resolved, ctx)
                : {
                    title: call.name,
                    detail: JSON.stringify(resolved).slice(0, 500),
                    riskLevel: decision.riskLevel,
                  };
              const answer = await options.requestApproval({
                tool: call.name,
                input: resolved,
                title: preview.title,
                detail: preview.detail,
                riskLevel: preview.riskLevel,
                reason: decision.reason,
              });

              if (answer === 'allow') {
                result = await options.tools.run(call.name, resolved, ctx);
                options.security.permission.audit({
                  at: Date.now(),
                  tool: call.name,
                  mode: options.security.permission.getMode(),
                  decision: 'allow',
                  reason: '用户确认',
                  riskLevel: decision.riskLevel,
                  source: 'user',
                });
              } else {
                result = {
                  ok: false,
                  content: '',
                  error: '用户拒绝了该操作',
                };
                options.security.permission.audit({
                  at: Date.now(),
                  tool: call.name,
                  mode: options.security.permission.getMode(),
                  decision: 'deny',
                  reason: '用户拒绝',
                  riskLevel: decision.riskLevel,
                  source: 'user',
                });
              }
            }
          } else {
            result = await options.tools.run(call.name, resolved, ctx);
          }
        } else {
          result = await options.tools.run(call.name, call.input, ctx);
        }
      } catch (error) {
        result = {
          ok: false,
          content: '',
          error: error instanceof Error ? error.message : String(error),
        };
      }

      options.onToolResult?.(call, result);

      history.push({
        role: 'tool',
        content: result.ok ? result.content : `ERROR: ${result.error ?? 'tool failed'}`,
        toolCallId: call.id,
        toolName: call.name,
      });
    }
  }

  return { messages: history, steps, hitLimit: true };
}
