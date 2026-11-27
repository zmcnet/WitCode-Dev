import { useEffect } from 'react';
import type { SessionSummary } from '@witcode/protocol';

interface Props {
  sessions: SessionSummary[];
  connected: boolean;
  onLoad(): void;
  onRestore(id: string): void;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function ArchivePanel({ sessions, connected, onLoad, onRestore }: Props) {
  useEffect(() => {
    onLoad();
  }, [onLoad]);

  return (
    <section className="settings-panel">
      <div className="panel-head">
        <div>
          <h2>归档管理</h2>
          <p className="panel-desc">归档只从主列表隐藏，不删除消息；可随时恢复。</p>
        </div>
        <button type="button" className="btn ghost" disabled={!connected} onClick={onLoad}>
          刷新
        </button>
      </div>

      {sessions.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-title">还没有归档会话</div>
          <div className="empty-state-hint">在左侧会话菜单里选择「归档」后，会出现在这里。</div>
        </div>
      ) : (
        <div className="archive-list">
          {sessions.map((session) => (
            <div className="archive-row" key={session.id}>
              <div className="archive-main">
                <span className="archive-title">{session.title || '未命名会话'}</span>
                <span className="archive-time">更新于 {formatTime(session.updatedAt)}</span>
              </div>
              <button
                type="button"
                className="btn ghost"
                disabled={!connected}
                onClick={() => onRestore(session.id)}
              >
                恢复
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
