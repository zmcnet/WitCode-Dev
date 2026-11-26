import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ApprovalRequest,
  BrainSummary,
  ClientMessage,
  ModelInfo,
  ModelSelection,
  PartnerConfig,
  PermissionMode,
  ProviderInput,
  ProviderPublic,
  ServerMessage,
  SessionSummary,
  UsageRecord,
  UsageSummary,
} from '@witcode/protocol';
import { historyToMessages } from './history';
import type { Message, PartnerCard, SubagentCard } from './ui-types';

export type View = 'chat' | 'settings';
export type SettingsTab = 'general' | 'models' | 'brains' | 'partners' | 'plugins' | 'data';

/** 服务端尚未下发槽位时的默认脑子；保证界面始终有 2 个槽位可选。 */
const DEFAULT_PARTNER_BRAINS: Record<1 | 2, string> = { 1: 'profession', 2: 'coding' };

/** 协议允许缺省槽位；本地统一补齐成两个，避免界面分支。 */
function normalizePartners(items: PartnerConfig[] | undefined): PartnerConfig[] {
  return ([1, 2] as const).map((slot) => {
    const found = items?.find((item) => item.slot === slot);
    return found
      ? { ...found, slot }
      : { slot, enabled: false, brainId: DEFAULT_PARTNER_BRAINS[slot] };
  });
}

interface UsageData {
  summary: UsageSummary | null;
  records: UsageRecord[];
}

interface PendingOperation {
  /** 本地生成的请求序号，用于避免旧回包覆盖新状态。 */
  id: number;
  kind: 'save' | 'delete';
  data: ProviderInput | string;
  resolve: () => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * 协议没有 requestId 回显，用提交内容做一次粗略配对：
 * 删除要求列表中不再含该 id，保存要求列表中出现同名（编辑时同 id）的提供商。
 */
function matchesPending(items: ProviderPublic[], op: PendingOperation): boolean {
  if (op.kind === 'delete') {
    const id = op.data as string;
    return !items.some((item) => item.id === id);
  }
  const input = op.data as ProviderInput;
  return items.some((item) =>
    input.id ? item.id === input.id : item.name === input.name,
  );
}

function uid(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}

function socketUrl(): string {
  const configured = import.meta.env.VITE_WS_URL;
  if (configured) return configured;
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  // 同源 /ws，由 Vite（或反向代理）转到服务端；内网穿透只需映射一个端口。
  return `${scheme}://${location.host}/ws`;
}

export function useChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  /** 伙伴咨询卡片，和消息一起按到达顺序渲染。 */
  const [partnerCards, setPartnerCards] = useState<PartnerCard[]>([]);
  /** 子智能体任务卡片，和消息一起按到达顺序渲染。 */
  const [subagentCards, setSubagentCards] = useState<SubagentCard[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [hasSessionList, setHasSessionList] = useState(false);
  const [sessionId, setSessionId] = useState('');
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelId, setModelId] = useState(() =>
    String(import.meta.env.VITE_WITCODE_MODEL ?? ''),
  );
  const [input, setInput] = useState('');

  const [view, setView] = useState<View>('chat');
  const [providers, setProviders] = useState<ProviderPublic[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selection, setSelection] = useState<ModelSelection | null>(null);
  const [brains, setBrains] = useState<BrainSummary[]>([]);
  /** 服务端下发的官方模式 id 顺序；缺失时为空数组，界面降级为单列表。 */
  const [officialBrainIds, setOfficialBrainIds] = useState<string[]>([]);
  const [activeBrainId, setActiveBrainId] = useState('');
  /** 两个伙伴槽位；服务端未下发时保持本地默认。 */
  const [partners, setPartners] = useState<PartnerConfig[]>(() => normalizePartners(undefined));
  /** 用户级权限模式；服务端未下发时保持 normal，界面不依赖后端也能用。 */
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('normal');
  /** 当前待用户确认的工具调用；同一时刻只展示一个。 */
  const [pendingApproval, setPendingApproval] = useState<ApprovalRequest | null>(null);
  const [usage, setUsage] = useState<UsageData>({ summary: null, records: [] });
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general');
  const [archivedIds, setArchivedIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const sessionIdRef = useRef('');
  /** 消息与协作卡片共用的单调递增到达序号。 */
  const feedSeqRef = useRef(0);
  const pendingRef = useRef<PendingOperation | null>(null);
  /** 与 pendingApproval 同步，供 WebSocket 回包闭包读取，避免重建连接。 */
  const approvalRef = useRef<ApprovalRequest | null>(null);
  const requestSeqRef = useRef(0);
  /** WS 回包闭包读取的是连接建立时的 state，用 ref 拿到最新的槽位与脑子列表。 */
  const partnersRef = useRef(partners);
  const brainsRef = useRef(brains);

  useEffect(() => { partnersRef.current = partners; }, [partners]);
  useEffect(() => { brainsRef.current = brains; }, [brains]);

  /**
   * 服务端 partner:start 只带 brainId，槽位与模型从本地配置反查。
   * 临时指派没有槽位配置时只显示脑子，不臆造标题。
   */
  const partnerCardMeta = useCallback(
    (brainId: string): Pick<PartnerCard, 'slot' | 'brainName' | 'modelLabel'> => {
      const partner = partnersRef.current.find((item) => item.brainId === brainId);
      return {
        slot: partner?.slot,
        brainName: brainsRef.current.find((brain) => brain.id === brainId)?.name,
        modelLabel: partner?.model?.model,
      };
    },
    [],
  );

  const sendMessage = useCallback((payload: ClientMessage) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  }, []);

  const updateApproval = useCallback((request: ApprovalRequest | null) => {
    approvalRef.current = request;
    setPendingApproval(request);
  }, []);

  const requestSettingsData = useCallback(() => {
    sendMessage({ type: 'providers:list' });
    sendMessage({ type: 'usage:list' });
    sendMessage({ type: 'partners:list' });
  }, [sendMessage]);

  const requestBrains = useCallback(() => {
    sendMessage({ type: 'brains:list' });
  }, [sendMessage]);

  const applySessionId = useCallback((id: string) => {
    sessionIdRef.current = id;
    setSessionId(id);
  }, []);

  const nextOrder = useCallback(() => ++feedSeqRef.current, []);

  const clearCards = useCallback(() => {
    setPartnerCards([]);
    setSubagentCards([]);
  }, []);

  const finishPending = useCallback((op: PendingOperation, ok: boolean, message?: string) => {
    if (pendingRef.current?.id !== op.id) return;
    if (op.timer) clearTimeout(op.timer);
    pendingRef.current = null;
    setSaving(false);
    setDeletingId(null);
    if (ok) {
      op.resolve();
    } else {
      const reason = message ?? '操作失败';
      setError(reason);
      op.reject(new Error(reason));
    }
  }, []);

  const startOperation = useCallback(
    (kind: PendingOperation['kind'], data: ProviderInput | string, payload: ClientMessage) =>
      new Promise<void>((resolve, reject) => {
        if (pendingRef.current) {
          const reason = '上一个操作尚未完成，请稍候';
          setError(reason);
          reject(new Error(reason));
          return;
        }
        const socket = socketRef.current;
        if (!socket || socket.readyState !== WebSocket.OPEN) {
          const reason = '未连接到服务端，操作未发送';
          setError(reason);
          reject(new Error(reason));
          return;
        }

        const op: PendingOperation = {
          id: ++requestSeqRef.current,
          kind,
          data,
          resolve,
          reject,
          timer: null,
        };
        op.timer = setTimeout(() => finishPending(op, false, '操作超时，请重试'), 10000);
        pendingRef.current = op;

        setError(null);
        if (kind === 'save') {
          setSaving(true);
          setDeletingId(null);
        } else {
          setDeletingId(data as string);
          setSaving(false);
        }
        sendMessage(payload);
      }),
    [finishPending, sendMessage],
  );

  useEffect(() => {
    const socket = new WebSocket(socketUrl());
    socketRef.current = socket;

    socket.onopen = () => {
      setConnected(true);
      requestSettingsData();
      requestBrains();
    };
    socket.onclose = () => {
      setConnected(false);
      setBusy(false);
      // 断线后用户无法再响应，清空避免留下永远悬挂的确认框。
      updateApproval(null);
      const op = pendingRef.current;
      if (op) finishPending(op, false, '连接已断开，操作未完成');
    };
    socket.onerror = () => setError('无法连接到 WitCode 服务端');

    socket.onmessage = (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data as string) as ServerMessage;
      } catch {
        return;
      }

      if (message.type === 'ready') {
        if (!sessionIdRef.current) applySessionId(message.sessionId);
        if (message.model) setModelId(message.model);
        if (message.brain) setActiveBrainId(message.brain);
        if (message.permission) setPermissionMode(message.permission);
        return;
      }

      if (message.type === 'history') {
        if (!sessionIdRef.current) applySessionId(message.sessionId);
        setBusy(false);
        clearCards();
        const loaded = historyToMessages(message.messages).map((item, index) => ({
          ...item,
          order: index + 1,
        }));
        feedSeqRef.current = loaded.length;
        setMessages(loaded);
        return;
      }

      if (message.type === 'sessions') {
        setSessions(message.items);
        setHasSessionList(true);
        return;
      }

      if (message.type === 'delta') {
        const id = uid();
        const order = nextOrder();
        setMessages((prev) => {
          const next = [...prev];
          for (let i = next.length - 1; i >= 0; i -= 1) {
            const item = next[i];
            if (item?.role === 'assistant' && item.streaming) {
              next[i] = { ...item, text: item.text + message.text };
              return next;
            }
          }
          next.push({
            id,
            role: 'assistant',
            text: message.text,
            streaming: true,
            toolCalls: [],
            order,
          });
          return next;
        });
        return;
      }

      if (message.type === 'tool-call') {
        const id = uid();
        const order = nextOrder();
        setMessages((prev) => {
          const next = [...prev];
          for (let i = next.length - 1; i >= 0; i -= 1) {
            const item = next[i];
            if (item?.role === 'assistant') {
              next[i] = {
                ...item,
                toolCalls: [
                  ...item.toolCalls,
                  { id: uid(), name: message.name, input: message.input },
                ],
              };
              return next;
            }
          }
          next.push({
            id,
            role: 'assistant',
            text: '',
            streaming: true,
            toolCalls: [{ id: uid(), name: message.name, input: message.input }],
            order,
          });
          return next;
        });
        return;
      }

      if (message.type === 'tool-result') {
        setMessages((prev) => {
          const next = [...prev];
          for (let i = next.length - 1; i >= 0; i -= 1) {
            const item = next[i];
            if (!item || item.role !== 'assistant') continue;
            for (let j = item.toolCalls.length - 1; j >= 0; j -= 1) {
              const call = item.toolCalls[j];
              if (!call || call.name !== message.name || call.result) continue;
              const toolCalls = [...item.toolCalls];
              toolCalls[j] = {
                ...call,
                result: { ok: message.ok, content: message.content },
              };
              next[i] = { ...item, toolCalls };
              return next;
            }
          }
          return prev;
        });
        return;
      }

      if (message.type === 'done') {
        setBusy(false);
        setMessages((prev) =>
          prev.map((item) =>
            item.streaming ? { ...item, streaming: false } : item,
          ),
        );
        setSessions((prev) =>
          prev.map((session) =>
            session.id === sessionIdRef.current
              ? { ...session, updatedAt: Date.now() }
              : session,
          ),
        );
        return;
      }

      if (message.type === 'partner:start') {
        const order = nextOrder();
        const id = uid();
        setPartnerCards((prev) => [
          ...prev,
          {
            id,
            brainId: message.brainId,
            question: message.question,
            status: 'running',
            order,
            ...partnerCardMeta(message.brainId),
          },
        ]);
        return;
      }

      if (message.type === 'partner:done') {
        const fallback = { id: uid(), order: nextOrder() };
        setPartnerCards((prev) => {
          for (let i = prev.length - 1; i >= 0; i -= 1) {
            const card = prev[i];
            if (!card) continue;
            if (card.brainId === message.brainId && card.status === 'running') {
              const next = [...prev];
              next[i] = { ...card, answer: message.answer, status: 'done' };
              return next;
            }
          }
          return [
            ...prev,
            {
              id: fallback.id,
              brainId: message.brainId,
              question: '',
              answer: message.answer,
              status: 'done',
              order: fallback.order,
              ...partnerCardMeta(message.brainId),
            },
          ];
        });
        return;
      }

      if (message.type === 'subagent:start') {
        const order = nextOrder();
        setSubagentCards((prev) => [
          ...prev,
          { id: message.id, task: message.task, status: 'running', order },
        ]);
        return;
      }

      if (message.type === 'subagent:done') {
        const fallback = { id: uid(), order: nextOrder() };
        setSubagentCards((prev) => {
          for (let i = prev.length - 1; i >= 0; i -= 1) {
            const card = prev[i];
            if (!card) continue;
            if (card.id === message.id && card.status === 'running') {
              const next = [...prev];
              next[i] = { ...card, status: message.status, output: message.output };
              return next;
            }
          }
          return [
            ...prev,
            {
              id: fallback.id,
              task: '',
              status: message.status,
              output: message.output,
              order: fallback.order,
            },
          ];
        });
        return;
      }

      if (message.type === 'error') {
        setBusy(false);
        setError(message.message);
        setMessages((prev) =>
          prev.map((item) =>
            item.streaming ? { ...item, streaming: false } : item,
          ),
        );
        const op = pendingRef.current;
        if (op) finishPending(op, false, message.message);
        return;
      }

      if (message.type === 'providers') {
        setProviders(message.items);
        const op = pendingRef.current;
        if (op && matchesPending(message.items, op)) finishPending(op, true);
        return;
      }

      if (message.type === 'models') {
        setModels(message.items);
        return;
      }

      if (message.type === 'partners') {
        setPartners(normalizePartners(message.items));
        return;
      }

      if (message.type === 'usage') {
        setUsage({ summary: message.summary, records: message.items });
        return;
      }

      if (message.type === 'selection') {
        setSelection(message.selection);
        if (message.selection) setModelId(message.selection.model);
        return;
      }

      if (message.type === 'brains') {
        setBrains(message.items);
        setOfficialBrainIds(message.official ?? []);
        if (message.active) setActiveBrainId(message.active);
        return;
      }

      if (message.type === 'brain') {
        setActiveBrainId(message.brain.id);
        setBrains((prev) =>
          prev.some((item) => item.id === message.brain.id)
            ? prev
            : [...prev, message.brain],
        );
        return;
      }

      if (message.type === 'permission') {
        setPermissionMode(message.mode);
        return;
      }

      if (message.type === 'approval:request') {
        // 后到请求：覆盖当前弹窗，并先拒绝旧请求，避免服务端悬挂等待 60 秒。
        const current = approvalRef.current;
        if (current) {
          sendMessage({ type: 'approval:response', id: current.id, decision: 'deny' });
        }
        updateApproval(message.request);
        return;
      }
    };

    return () => {
      socket.close();
      socketRef.current = null;
      updateApproval(null);
      const op = pendingRef.current;
      if (op) finishPending(op, false, '请求已取消');
    };
  }, [applySessionId, clearCards, finishPending, nextOrder, partnerCardMeta, requestBrains, requestSettingsData, sendMessage, updateApproval]);

  const send = useCallback(() => {
    const text = input.trim();
    const socket = socketRef.current;
    if (!text || busy || !socket || socket.readyState !== WebSocket.OPEN) return;

    const payload: ClientMessage = {
      type: 'prompt',
      text,
      sessionId: sessionIdRef.current || undefined,
    };
    socket.send(JSON.stringify(payload));

    setInput('');
    setError(null);
    setBusy(true);
    const userOrder = nextOrder();
    const assistantOrder = nextOrder();
    setMessages((prev) => [
      ...prev.map((item) =>
        item.streaming ? { ...item, streaming: false } : item,
      ),
      { id: uid(), role: 'user', text, toolCalls: [], order: userOrder },
      {
        id: uid(),
        role: 'assistant',
        text: '',
        streaming: true,
        toolCalls: [],
        order: assistantOrder,
      },
    ]);
  }, [input, busy, nextOrder]);

  const newSession = useCallback(() => {
    if (busy) return;
    const id = `local-${uid()}`;
    applySessionId(id);
    setMessages([]);
    clearCards();
    setError(null);
    setHasSessionList(true);
    setSessions((prev) =>
      [{ id, title: '新会话', updatedAt: Date.now() }, ...prev].slice(0, 50),
    );
  }, [busy, applySessionId, clearCards]);

  const openSession = useCallback(
    (id: string) => {
      if (busy || id === sessionIdRef.current) return;
      applySessionId(id);
      setMessages([]);
      clearCards();
      setError(null);
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) {
        const payload: ClientMessage = { type: 'open-session', sessionId: id };
        socket.send(JSON.stringify(payload));
      }
    },
    [busy, applySessionId, clearCards],
  );

  /** 停止生成：协议有 cancel，服务端会回 done；本地先解除 busy 避免按钮卡住。 */
  const stop = useCallback(() => {
    sendMessage({ type: 'cancel' });
    setBusy(false);
    setMessages((prev) => prev.map((item) => (item.streaming ? { ...item, streaming: false } : item)));
  }, [sendMessage]);

  /** 会话重命名/归档目前只影响本地列表：协议没有对应消息，不改服务端。 */
  const renameSession = useCallback((id: string, title: string) => {
    const next = title.trim();
    if (!next) return;
    setSessions((prev) => prev.map((item) => (item.id === id ? { ...item, title: next } : item)));
  }, []);

  const archiveSession = useCallback((id: string) => {
    setArchivedIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
    if (sessionIdRef.current === id) {
      applySessionId('');
      setMessages([]);
      clearCards();
    }
  }, [applySessionId, clearCards]);

  const allVisibleSessions: SessionSummary[] = hasSessionList
    ? sessions
    : sessionId
      ? [{ id: sessionId, title: '当前会话', updatedAt: Date.now() }]
      : [];
  const visibleSessions = allVisibleSessions.filter((item) => !archivedIds.includes(item.id));

  const openSettings = useCallback(() => {
    setView('settings');
    requestSettingsData();
  }, [requestSettingsData]);

  const openChat = useCallback(() => setView('chat'), []);

  const saveProvider = useCallback(
    (provider: ProviderInput) =>
      startOperation('save', provider, { type: 'providers:save', provider }),
    [startOperation],
  );

  const deleteProvider = useCallback(
    (id: string) => startOperation('delete', id, { type: 'providers:delete', id }),
    [startOperation],
  );

  const chooseModel = useCallback(
    (next: ModelSelection) => {
      setSelection(next);
      setModelId(next.model);
      sendMessage({ type: 'selection:set', selection: next });
    },
    [sendMessage],
  );

  /** 槽位配置立即生效：先更新本地，再通知服务端持久化。 */
  const setPartner = useCallback(
    (partner: PartnerConfig) => {
      setPartners((prev) =>
        normalizePartners(
          prev.map((item) => (item.slot === partner.slot ? partner : item)),
        ),
      );
      sendMessage({ type: 'partners:set', partner });
    },
    [sendMessage],
  );

  /** 先本地切换让界面立即响应，再由服务端 permission 消息确认。 */
  const selectBrain = useCallback(
    (id: string) => {
      setActiveBrainId(id);
      sendMessage({ type: 'brain:select', brainId: id });
    },
    [sendMessage],
  );

  const selectPermissionMode = useCallback(
    (mode: PermissionMode) => {
      setPermissionMode(mode);
      sendMessage({ type: 'permission:set', mode });
    },
    [sendMessage],
  );

  /** 响应用户决策；用 ref 读取当前请求，避免快速连点发出重复回包。 */
  const respondApproval = useCallback(
    (decision: 'allow' | 'deny') => {
      const current = approvalRef.current;
      if (!current) return;
      sendMessage({ type: 'approval:response', id: current.id, decision });
      updateApproval(null);
    },
    [sendMessage, updateApproval],
  );

  return {
    messages,
    partnerCards,
    subagentCards,
    visibleSessions,
    currentSessionId: sessionId,
    connected,
    busy,
    error,
    modelId,
    input,
    setInput,
    setError,
    send,
    stop,
    renameSession,
    archiveSession,
    newSession,
    openSession,
    view,
    providers,
    models,
    selection,
    brains,
    officialBrainIds,
    activeBrainId,
    selectBrain,
    partners,
    setPartner,
    permissionMode,
    selectPermissionMode,
    pendingApproval,
    respondApproval,
    usage,
    settingsTab,
    setSettingsTab,
    saving,
    deletingId,
    openSettings,
    openChat,
    saveProvider,
    deleteProvider,
    chooseModel,
  };
}
