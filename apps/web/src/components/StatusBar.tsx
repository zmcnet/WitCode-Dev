interface Props {
  connected: boolean;
  modelId: string;
  sessionId: string;
}

export function StatusBar({ connected, modelId, sessionId }: Props) {
  return (
    <div className="statusbar">
      <span className={connected ? 'status-dot ok' : 'status-dot off'} />
      <span className={connected ? 'status-text ok' : 'status-text'}>
        {connected ? '已连接' : '未连接'}
      </span>
      <span className="status-sep" />
      <span className="status-label">模型</span>
      <span className={modelId ? 'model-id' : 'model-id missing'}>
        {modelId || '未配置模型'}
      </span>
      {sessionId ? (
        <span className="status-session">
          <span className="status-sep" />
          <span className="status-label">会话</span>
          <span className="session-id">{sessionId.slice(-8)}</span>
        </span>
      ) : null}
    </div>
  );
}
