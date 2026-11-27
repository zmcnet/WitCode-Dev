import { useEffect, useRef, useState } from 'react';
import type { SVGProps } from 'react';
import type { ProviderPublic } from '@witcode/protocol';
import { IconMore } from '../../icons';

export interface ProviderRowProps {
  provider: ProviderPublic;
  index: number;
  total: number;
  /** 断线或正在保存/重排时禁用行内操作。 */
  disabled: boolean;
  reordering: boolean;
  onEdit(provider: ProviderPublic, trigger: HTMLElement): void;
  onToggle(provider: ProviderPublic): void;
  onMove(provider: ProviderPublic, direction: -1 | 1): void;
}

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function lineIcon({ size = 16, ...props }: IconProps): SVGProps<SVGSVGElement> {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    ...props,
  };
}

function IconUp(props: IconProps) {
  return (
    <svg {...lineIcon(props)}>
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  );
}

function IconDown(props: IconProps) {
  return (
    <svg {...lineIcon(props)}>
      <path d="M12 5v14M19 12l-7 7-7-7" />
    </svg>
  );
}

function IconEdit(props: IconProps) {
  return (
    <svg {...lineIcon(props)}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

function IconKey(props: IconProps) {
  return (
    <svg {...lineIcon(props)}>
      <circle cx="8" cy="15" r="4" />
      <path d="m10.8 12.2 8-8M17 6l2 2M15 8l2 2" />
    </svg>
  );
}

function hostOf(baseUrl: string): string {
  const raw = baseUrl.trim();
  if (!raw) return '未设置地址';
  try {
    const parsed = new URL(raw);
    return parsed.host || parsed.hostname || raw;
  } catch {
    const stripped = raw.replace(/^https?:\/\//i, '').split('/')[0] ?? raw;
    return stripped || raw;
  }
}

function formatContext(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '— 上下文';
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M 上下文`;
  }
  return `${tokens.toLocaleString('en-US')} 上下文`;
}

function toneOf(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return hash % 6;
}

function keyLabel(provider: ProviderPublic): string {
  if (provider.apiKeyHint) return provider.apiKeyHint;
  return provider.hasApiKey ? '已设置 Key' : '未设置 Key';
}

export function ProviderRow({
  provider,
  index,
  total,
  disabled,
  reordering,
  onEdit,
  onToggle,
  onMove,
}: ProviderRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);
  const name = provider.name || '未命名提供商';
  const initial = name.trim().charAt(0).toUpperCase() || '?';
  const canMoveUp = index > 0;
  const canMoveDown = index < total - 1;
  const actionsDisabled = disabled || reordering;

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (moreRef.current && target instanceof Node && !moreRef.current.contains(target)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [menuOpen]);

  const move = (direction: -1 | 1) => {
    setMenuOpen(false);
    onMove(provider, direction);
  };

  return (
    <div className="model-settings-row" role="listitem">
      <button
        type="button"
        className="model-settings-row-main"
        aria-label={`编辑提供商 ${name}`}
        onClick={(event) => onEdit(provider, event.currentTarget)}
      >
        <span className={`model-settings-avatar tone-${toneOf(name)}`} aria-hidden="true">
          {initial}
        </span>
        <span className="model-settings-row-text">
          <span className="model-settings-row-name" title={name}>
            {name}
          </span>
          <span className="model-settings-row-meta">
            {hostOf(provider.baseUrl)} · {provider.modelIds.length} 个模型 ·{' '}
            {formatContext(provider.contextWindow)}
          </span>
        </span>
        <span
          className={provider.hasApiKey ? 'model-settings-key' : 'model-settings-key absent'}
          title={keyLabel(provider)}
          aria-label={`API Key ${keyLabel(provider)}`}
        >
          <IconKey size={13} />
          <span>{keyLabel(provider)}</span>
        </span>
      </button>

      <div className="model-settings-row-actions">
        <button
          type="button"
          role="switch"
          aria-checked={provider.enabled}
          aria-label={`${provider.enabled ? '停用' : '启用'}提供商 ${name}`}
          className={provider.enabled ? 'model-settings-switch on' : 'model-settings-switch'}
          disabled={actionsDisabled}
          onClick={() => onToggle(provider)}
        >
          <span className="model-settings-switch-thumb" aria-hidden="true" />
        </button>

        <div className="model-settings-row-tools">
          <button
            type="button"
            className="model-settings-icon-btn"
            aria-label={`上移提供商 ${name}`}
            disabled={actionsDisabled || !canMoveUp}
            onClick={() => move(-1)}
          >
            <IconUp size={15} />
          </button>
          <button
            type="button"
            className="model-settings-icon-btn"
            aria-label={`下移提供商 ${name}`}
            disabled={actionsDisabled || !canMoveDown}
            onClick={() => move(1)}
          >
            <IconDown size={15} />
          </button>
          <button
            type="button"
            className="model-settings-icon-btn"
            aria-label={`编辑提供商 ${name}`}
            disabled={disabled}
            onClick={(event) => onEdit(provider, event.currentTarget)}
          >
            <IconEdit size={15} />
          </button>
        </div>

        <div className="model-settings-more-wrap" ref={moreRef}>
          <button
            type="button"
            className="model-settings-icon-btn model-settings-more"
            aria-label={`更多操作 ${name}`}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            disabled={disabled}
            onClick={() => setMenuOpen((value) => !value)}
          >
            <IconMore size={16} />
          </button>
          {menuOpen ? (
            <div className="model-settings-row-menu" role="menu" aria-label={`${name} 操作`}>
              <button
                type="button"
                role="menuitem"
                disabled={actionsDisabled || !canMoveUp}
                onClick={() => move(-1)}
              >
                上移
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={actionsDisabled || !canMoveDown}
                onClick={() => move(1)}
              >
                下移
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={disabled}
                onClick={(event) => {
                  setMenuOpen(false);
                  onEdit(provider, event.currentTarget);
                }}
              >
                编辑
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
