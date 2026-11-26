export interface ToolCallEntry {
  id: string;
  name: string;
  input: unknown;
  result?: { ok: boolean; content: string };
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  streaming?: boolean;
  /** 思考过程。目前协议没有该字段，空值时不渲染。 */
  reasoning?: string;
  toolCalls: ToolCallEntry[];
  /** 到达序号，用于和协作卡片在消息流里按时间排序。 */
  order?: number;
}

export type PartnerCardStatus = 'running' | 'done';

/** 另一个脑子的咨询意见；只展示，不和助手正文混排。 */
export interface PartnerCard {
  id: string;
  brainId: string;
  question: string;
  answer?: string;
  status: PartnerCardStatus;
  order: number;
  /** 服务端事件只带 brainId，以下三项由本地槽位配置反查，缺失时不显示。 */
  slot?: 1 | 2;
  brainName?: string;
  modelLabel?: string;
}

export type SubagentCardStatus = 'running' | 'done' | 'failed' | 'cancelled';

/** 独立执行的任务卡片。 */
export interface SubagentCard {
  id: string;
  task: string;
  status: SubagentCardStatus;
  output?: string;
  order: number;
}
