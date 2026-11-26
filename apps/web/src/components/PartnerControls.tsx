import { useEffect, useRef, useState } from 'react';
import type { BrainSummary, ModelInfo, ModelSelection } from '@witcode/protocol';
import { brainDescription, splitBrains } from '../brain-modes';

export interface SelectOption {
  key: string;
  label: string;
  /** 按钮上显示的短名；缺省时用 label。 */
  shortLabel?: string;
  description?: string;
  group?: string;
}

interface CompactSelectProps {
  ariaLabel: string;
  value: string;
  options: SelectOption[];
  onChange: (key: string) => void;
  glyph: string;
  className?: string;
  /** 输入区面板从按钮向上弹，设置卡片向下弹。 */
  align?: 'up' | 'down';
}

/** 伙伴槽位共用的紧凑下拉：脑子与模型都走同一套样式与交互。 */
export function CompactSelect({
  ariaLabel,
  value,
  options,
  onChange,
  glyph,
  className = '',
  align = 'up',
}: CompactSelectProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const current = options.find((option) => option.key === value);
  const label = current?.shortLabel ?? current?.label ?? '未选择';
  const groups: Array<{ title?: string; items: SelectOption[] }> = [];
  for (const option of options) {
    const last = groups[groups.length - 1];
    if (last && last.title === option.group) {
      last.items.push(option);
    } else {
      groups.push({ title: option.group, items: [option] });
    }
  }

  return (
    <div className={`partner-select ${className}`.trim()} ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="partner-select-button"
        aria-label={`${ariaLabel}：${label}`}
        aria-expanded={open}
        title={label}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="partner-select-glyph" aria-hidden="true">{glyph}</span>
        <span className="partner-select-label">{label}</span>
        <span className="partner-select-chevron" aria-hidden="true">
          {open ? '▴' : '▾'}
        </span>
      </button>

      {open ? (
        <div
          className={align === 'down' ? 'partner-select-menu down' : 'partner-select-menu'}
          role="menu"
          aria-label={ariaLabel}
        >
          {options.length === 0 ? (
            <div className="partner-select-empty">暂无可选项</div>
          ) : (
            groups.map((group, index) => (
              <div className="partner-select-group" key={`${group.title ?? 'options'}-${index}`}>
                {group.title ? (
                  <div className="partner-select-group-title">{group.title}</div>
                ) : null}
                {group.items.map((option) => {
                  const active = option.key === value;
                  return (
                    <button
                      key={option.key}
                      type="button"
                      role="menuitemradio"
                      aria-checked={active}
                      className={active ? 'partner-select-item active' : 'partner-select-item'}
                      onClick={() => {
                        onChange(option.key);
                        setOpen(false);
                        buttonRef.current?.focus();
                      }}
                    >
                      <span className="partner-select-main">
                        <span className="partner-select-name">{option.label}</span>
                        {option.description ? (
                          <span className="partner-select-desc" title={option.description}>
                            {option.description}
                          </span>
                        ) : null}
                      </span>
                      {active ? (
                        <span className="partner-select-check" aria-hidden="true">✓</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

/** 官方模式与自定义脑子合并成下拉选项，沿用现有分组规则。 */
export function brainOptions(brains: BrainSummary[], officialIds: readonly string[]): SelectOption[] {
  const groups = splitBrains(brains, officialIds);
  return [
    ...groups.official.map((brain) => ({
      key: brain.id,
      label: brain.name,
      description: brainDescription(brain, officialIds),
      group: '模式',
    })),
    ...groups.custom.map((brain) => ({
      key: brain.id,
      label: brain.name,
      description: brain.description,
      group: '自定义',
    })),
  ];
}

/** 空 key 表示不指定模型，沿用主会话模型。 */
export function partnerModelKey(selection?: ModelSelection): string {
  return selection ? `${selection.providerId}::${selection.model}` : '';
}

export function parsePartnerModelKey(key: string): ModelSelection | undefined {
  if (!key) return undefined;
  const index = key.indexOf('::');
  if (index < 0) return undefined;
  return { providerId: key.slice(0, index), model: key.slice(index + 2) };
}

export function modelOptions(models: ModelInfo[]): SelectOption[] {
  return [
    {
      key: '',
      label: '跟随主模型',
      shortLabel: '主模型',
      description: '使用主会话当前模型',
    },
    ...models.map((model) => ({
      key: partnerModelKey({ providerId: model.providerId, model: model.id }),
      label: `${model.providerName} / ${model.id}`,
      shortLabel: model.id,
    })),
  ];
}
