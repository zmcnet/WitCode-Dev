import { useEffect, useRef, useState } from 'react';
import type { PermissionMode } from '@witcode/protocol';
import { PERMISSION_MODES, permissionLabel, ShieldIcon } from '../permission';

interface Props {
  mode: PermissionMode;
  onSelect: (mode: PermissionMode) => void;
}

export function PermissionSelector({ mode, onSelect }: Props) {
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

  const label = permissionLabel(mode);
  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  return (
    <div className="permission-selector" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="permission-selector-button"
        aria-label={`权限模式：${label}`}
        aria-expanded={open}
        title={`权限模式：${label}`}
        onClick={() => setOpen((value) => !value)}
      >
        <ShieldIcon />
        <span className="permission-selector-label">{label}</span>
        <span className="permission-chevron" aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>

      {open ? (
        <div className="permission-menu" role="menu" aria-label="切换权限模式">
          <div className="permission-menu-title">权限模式</div>
          {PERMISSION_MODES.map((item) => {
            const current = item.mode === mode;
            return (
              <button
                key={item.mode}
                type="button"
                role="menuitemradio"
                aria-checked={current}
                className={current ? 'permission-menu-item active' : 'permission-menu-item'}
                onClick={() => {
                  onSelect(item.mode);
                  close();
                }}
              >
                <span className="permission-menu-main">
                  <span className="permission-menu-name">{item.label}</span>
                  <span className="permission-menu-desc">{item.description}</span>
                </span>
                {current ? <span className="permission-menu-check" aria-hidden="true">✓</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
