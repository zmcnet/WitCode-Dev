/**
 * consult_partner：主智能体向伙伴请教的工具。
 *
 * 这是「找另一个脑子想想」，不是「让别人替我干活」：伙伴只读、只给意见，
 * 真正写文件/跑命令仍由主智能体自己完成。
 *
 * 入参可以指定槽位（slot）、临时脑子（brainId）、临时模型（model）；
 * slot 与 brainId 至少提供一个。sessionId 从 ToolContext 取，主会话历史由 server 注入。
 */

import type {
  ChatMessage,
  ModelSelection,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '@witcode/protocol';
import type { createPartnerService } from './partner.ts';

interface ParsedInput {
  question: string;
  slot?: 1 | 2;
  brainId?: string;
  model?: ModelSelection;
  history?: ChatMessage[];
}

type ParseResult = { ok: true; value: ParsedInput } | { ok: false; error: string };

export function partnerTool(service: ReturnType<typeof createPartnerService>): ToolDefinition {
  return {
    name: 'consult_partner',
    description: [
      '用另一个 Brain（伙伴）的视角回答一个问题。伙伴共享完整对话历史，但只读、只给建议，不会写文件或跑命令。',
      '用 slot 按会话槽位咨询（1 或 2），或用 brainId 临时指定脑子（单次生效）；两者至少提供一个。model 可临时指定模型，优先级高于槽位模型。',
      '什么时候用：审查方案、评估风险、换一种思路、要第二意见时。',
      '什么时候不用：需要真正执行任务（读写文件、运行命令、改代码）时——那应由主智能体自己或其他工具完成，不要用它。',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        slot: {
          type: 'integer',
          enum: [1, 2],
          description: '伙伴槽位（1 或 2）；与 brainId 至少提供一个',
        },
        brainId: {
          type: 'string',
          description: '临时指定的 Brain id（如 profession / coding），单次生效、不改槽位',
        },
        model: {
          type: 'object',
          properties: {
            providerId: { type: 'string', description: '模型提供商 id' },
            model: { type: 'string', description: '模型 id' },
          },
          required: ['providerId', 'model'],
          description: '临时模型；优先级高于槽位配置，不传则用槽位模型或主会话模型',
        },
        question: { type: 'string', description: '要问伙伴的问题' },
      },
      required: ['question'],
      anyOf: [{ required: ['slot'] }, { required: ['brainId'] }],
    },
    readOnly: true,
    riskLevel: 'low',
    concurrentSafe: true,
    async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = parseInput(input);
      if (!parsed.ok) {
        return { ok: false, content: '', error: parsed.error };
      }
      try {
        // 主会话历史由调用方（server）注入；模型本身不需要、也不应该自己拼历史。
        const result = await service.consult({
          sessionId: ctx.sessionId,
          slot: parsed.value.slot,
          brainId: parsed.value.brainId,
          model: parsed.value.model,
          question: parsed.value.question,
          history: parsed.value.history,
          signal: ctx.signal,
        });
        return { ok: true, content: result.answer };
      } catch (error) {
        return {
          ok: false,
          content: '',
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

function parseInput(input: unknown): ParseResult {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, error: 'consult_partner 需要对象类型的入参' };
  }
  const raw = input as Record<string, unknown>;

  if (typeof raw.question !== 'string' || raw.question.trim() === '') {
    return { ok: false, error: 'consult_partner 需要字符串类型的 question' };
  }

  let slot: 1 | 2 | undefined;
  if (raw.slot !== undefined) {
    if (raw.slot !== 1 && raw.slot !== 2) {
      return { ok: false, error: 'consult_partner 的 slot 只能是 1 或 2' };
    }
    slot = raw.slot;
  }

  let brainId: string | undefined;
  if (raw.brainId !== undefined) {
    if (typeof raw.brainId !== 'string' || raw.brainId.trim() === '') {
      return { ok: false, error: 'consult_partner 的 brainId 必须是非空字符串' };
    }
    brainId = raw.brainId;
  }

  if (slot === undefined && brainId === undefined) {
    return { ok: false, error: 'consult_partner 需要提供 slot 或 brainId 之一' };
  }

  let model: ModelSelection | undefined;
  if (raw.model !== undefined) {
    if (typeof raw.model !== 'object' || raw.model === null) {
      return { ok: false, error: 'consult_partner 的 model 需要 providerId 和 model' };
    }
    const candidate = raw.model as Record<string, unknown>;
    if (typeof candidate.providerId !== 'string' || typeof candidate.model !== 'string') {
      return { ok: false, error: 'consult_partner 的 model 需要 providerId 和 model' };
    }
    model = { providerId: candidate.providerId, model: candidate.model };
  }

  const history = Array.isArray(raw.history) ? (raw.history as ChatMessage[]) : undefined;
  return {
    ok: true,
    value: { question: raw.question, slot, brainId, model, history },
  };
}
