import type { ProviderPublic, UsageRecord, UsageSummary } from '@witcode/protocol';

interface Props {
  summary: UsageSummary | null;
  records: UsageRecord[];
  providers: ProviderPublic[];
}

const MAX_RECORDS = 50;

function formatNumber(value: number): string {
  return value.toLocaleString('zh-CN');
}

function formatTime(at: number): string {
  return new Date(at).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function UsagePanel({ summary, records, providers }: Props) {
  const byProvider = summary?.byProvider ?? [];
  const recent = records.slice(0, MAX_RECORDS);

  const providerName = (id: string) =>
    providers.find((provider) => provider.id === id)?.name ?? id;

  return (
    <section className="settings-panel">
      <div className="panel-head">
        <div>
          <h2>用量</h2>
          <p className="panel-desc">模型调用统计与最近 {MAX_RECORDS} 条请求记录。</p>
        </div>
      </div>

      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">总请求</div>
          <div className="stat-value">{formatNumber(summary?.totalRequests ?? 0)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">总输入 token</div>
          <div className="stat-value">{formatNumber(summary?.totalInputTokens ?? 0)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">总输出 token</div>
          <div className="stat-value">{formatNumber(summary?.totalOutputTokens ?? 0)}</div>
        </div>
      </div>

      <h3 className="section-title">按提供商</h3>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>提供商</th>
              <th>请求数</th>
              <th>输入 token</th>
              <th>输出 token</th>
            </tr>
          </thead>
          <tbody>
            {byProvider.length === 0 ? (
              <tr>
                <td colSpan={4} className="table-empty">
                  暂无用量数据
                </td>
              </tr>
            ) : (
              byProvider.map((item) => (
                <tr key={item.providerId}>
                  <td>{providerName(item.providerId)}</td>
                  <td>{formatNumber(item.requests)}</td>
                  <td>{formatNumber(item.inputTokens)}</td>
                  <td>{formatNumber(item.outputTokens)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <h3 className="section-title">最近记录</h3>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>提供商</th>
              <th>模型</th>
              <th>输入</th>
              <th>输出</th>
              <th>耗时</th>
              <th>结果</th>
            </tr>
          </thead>
          <tbody>
            {recent.length === 0 ? (
              <tr>
                <td colSpan={7} className="table-empty">
                  暂无调用记录
                </td>
              </tr>
            ) : (
              recent.map((record, index) => (
                <tr key={`${record.at}-${index}`}>
                  <td>{formatTime(record.at)}</td>
                  <td>{providerName(record.providerId)}</td>
                  <td>{record.model}</td>
                  <td>{formatNumber(record.inputTokens)}</td>
                  <td>{formatNumber(record.outputTokens)}</td>
                  <td>{formatNumber(record.durationMs)} ms</td>
                  <td>
                    <span
                      className={record.ok ? 'result-ok' : 'result-fail'}
                      title={record.error}
                    >
                      {record.ok ? '成功' : '失败'}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
