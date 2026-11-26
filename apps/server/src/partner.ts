/**
 * 伙伴（Partner）：另一个脑子的只读视角。
 *
 * 伙伴和主智能体是平级同事，不是手下：它共享主会话的完整上下文，但只能给意见，
 * 不能写文件、不能跑命令。因此这里只暴露只读工具视图，且不把 brain.execution
 * 的任何执行策略带进 runAgentLoop——伙伴的脑子只用来组装 system prompt。
 *
 * 每个会话有 2 个伙伴槽位。consult 可以按槽位咨询、临时指派脑子/模型，
 * 模型优先级为：单次入参 model > 槽位 model > 主会话（不传 selection，由网关注入）。
 */

import { getBrain } from '@witcode/brains';
import type { ChatMessage, ModelProvider, ModelSelection, ToolService } from '@witcode/protocol';
import { runAgentLoop } from './agent-loop.ts';
import { createPartnerRegistry, type PartnerRegistry } from './partner-registry.ts';

export interface PartnerServiceOptions {
  provider: ModelProvider;
  tools: ToolService;
  workspace: string;
  /** 单次会话最多咨询次数，默认 5。 */
  maxConsults?: number;
  /** 会话级槽位存储；不传则内部创建一个。 */
  registry?: PartnerRegistry;
}

export interface PartnerConsultInput {
  /** 读哪个会话的槽位；不传用 'default'。 */
  sessionId?: string;
  /** 按槽位咨询；槽位未启用时拒绝。 */
  slot?: 1 | 2;
  /** 临时指派脑子，不改槽位；要求该会话至少有一个启用的伙伴。 */
  brainId?: string;
  /** 临时模型；优先级高于槽位模型，不传且槽位未配置则不指定，走主会话模型。 */
  model?: ModelSelection;
  question: string;
  /** 主会话的完整消息历史（system / user / assistant / tool）。 */
  history?: ChatMessage[];
  signal?: AbortSignal;
}

export interface PartnerConsultResult {
  brainId: string;
  answer: string;
}

export interface PartnerService {
  consult(input: PartnerConsultInput): Promise<PartnerConsultResult>;
  remaining(): number;
}

export function createPartnerService(options: PartnerServiceOptions): PartnerService {
  const max = options.maxConsults ?? 5;
  const registry = options.registry ?? createPartnerRegistry();
  let used = 0;

  return {
    async consult(input) {
      const { question, history, signal } = input;
      const slots = registry.get(input.sessionId ?? 'default');
      let brainId: string;
      let slotModel: ModelSelection | undefined;

      if (input.slot !== undefined) {
        if (input.slot !== 1 && input.slot !== 2) {
          throw new Error(`非法的伙伴槽位：${String(input.slot)}`);
        }
        const slot = slots.find((item) => item.slot === input.slot);
        if (!slot?.enabled) {
          throw new Error(`伙伴槽位 ${input.slot} 未启用`);
        }
        brainId = slot.brainId;
        slotModel = slot.model;
      } else if (input.brainId !== undefined) {
        // 临时指派也要求会话里至少有一个启用的伙伴：两个都禁用时拒绝咨询。
        if (!slots.some((item) => item.enabled)) {
          throw new Error('本会话没有启用伙伴');
        }
        brainId = input.brainId;
      } else {
        const enabled = slots.find((item) => item.enabled);
        if (!enabled) {
          throw new Error('本会话没有启用伙伴');
        }
        brainId = enabled.brainId;
        slotModel = enabled.model;
      }

      const brain = getBrain(brainId);
      if (!brain) {
        throw new Error(`未知的伙伴脑子：${brainId}`);
      }
      if (used >= max) {
        throw new Error('伙伴咨询次数已用完');
      }
      used += 1;

      // 只读工具视图：list 只给只读工具；run 也只放行只读工具，
      // 防止模型直接点名调用未列出的写/命令工具。
      const readOnlyTools: ToolService = {
        register() {
          return () => {};
        },
        list() {
          return options.tools.list().filter((tool) => tool.readOnly === true);
        },
        async run(name, input, ctx) {
          const allowed = options.tools
            .list()
            .some((tool) => tool.name === name && tool.readOnly === true);
          if (!allowed) {
            return { ok: false, content: '', error: `伙伴不允许调用工具：${name}` };
          }
          return options.tools.run(name, input, ctx);
        },
      };

      const systemParts = [
        '你正在作为伙伴，回答主智能体的问题；只给建议，不执行操作。',
        brain.identity.trim(),
      ];
      if (brain.rules.length > 0) {
        systemParts.push(['## 硬规则', ...brain.rules.map((rule) => `- ${rule}`)].join('\n'));
      }

      // 伙伴用自己的脑子：丢掉主会话的 system，保留全部对话内容。
      const conversation = (history ?? []).filter((item) => item.role !== 'system');
      const messages: ChatMessage[] = [
        { role: 'system', content: systemParts.join('\n\n') },
        ...conversation,
        { role: 'user', content: question },
      ];

      // selection 通过装饰 provider 注入到每次 stream 请求；不改 agent-loop 的循环逻辑。
      // 没有 selection 时不装饰，网关会注入主会话当前的模型，符合优先级第三档。
      const selection = input.model ?? slotModel;
      const provider: ModelProvider = selection
        ? {
            id: options.provider.id,
            stream(request, providerSignal) {
              return options.provider.stream({ ...request, selection }, providerSignal);
            },
          }
        : options.provider;

      let answer = '';
      await runAgentLoop(messages, {
        provider,
        tools: readOnlyTools,
        workspace: options.workspace,
        // 不传 brain：execution / tool / loop 策略属于主会话，伙伴只拿提示词。
        maxSteps: 5,
        signal,
        onText: (text) => {
          answer += text;
        },
      });

      return { brainId: brain.id, answer };
    },

    remaining() {
      return Math.max(0, max - used);
    },
  };
}
