import { useEffect, useRef, useState } from 'react';
import type { BrainSummary } from '@witcode/protocol';
import { brainDescription, splitBrains } from '../brain-modes';

interface Props {
  brains: BrainSummary[];
  officialIds: string[];
  activeId: string;
  onSelect: (id: string) => void;
}

export function BrainSelector({ brains, officialIds, activeId, onSelect }: Props) {
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

  const active = brains.find((item) => item.id === activeId);
  const label = active?.name ?? '默认脑子';
  const groups = splitBrains(brains, officialIds);
  const grouped = groups.official.length > 0;

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  const renderItem = (brain: BrainSummary) => {
    const current = brain.id === activeId;
    const description = brainDescription(brain, officialIds);
    return (
      <button
        key={brain.id}
        type="button"
        role="menuitemradio"
        aria-checked={current}
        className={current ? 'brain-menu-item active' : 'brain-menu-item'}
        onClick={() => {
          onSelect(brain.id);
          close();
        }}
      >
        <span className="brain-menu-main">
          <span className="brain-menu-name">{brain.name}</span>
          <span className="brain-menu-desc" title={description}>
            {description}
          </span>
        </span>
        {current ? <span className="brain-menu-check" aria-hidden="true">✓</span> : null}
      </button>
    );
  };

  return (
    <div className="brain-selector" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="brain-selector-button"
        aria-label={`当前脑子：${label}`}
        aria-expanded={open}
        title={label}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="brain-glyph" aria-hidden="true">◈</span>
        <span className="brain-selector-label">{label}</span>
        <span className="brain-chevron" aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>

      {open ? (
        <div className="brain-menu" role="menu" aria-label="切换脑子">
          {brains.length === 0 ? (
            <div className="brain-menu-empty">暂无可用脑子</div>
          ) : grouped ? (
            <>
              <div className="brain-menu-title">模式</div>
              {groups.official.map(renderItem)}
              <div className="brain-menu-sep" role="separator" />
              <div className="brain-menu-title">自定义</div>
              {groups.custom.length > 0 ? (
                groups.custom.map(renderItem)
              ) : (
                <div className="brain-menu-empty">暂无参照大脑</div>
              )}
            </>
          ) : (
            <>
              <div className="brain-menu-title">切换脑子</div>
              {brains.map(renderItem)}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
