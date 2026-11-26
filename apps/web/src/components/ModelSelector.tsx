import { useEffect, useRef, useState } from 'react';
import type { ModelInfo, ModelSelection, ProviderPublic } from '@witcode/protocol';

interface Props {
  models: ModelInfo[];
  providers: ProviderPublic[];
  selection: ModelSelection | null;
  modelId: string;
  onSelect: (selection: ModelSelection) => void;
}

export function ModelSelector({ models, providers, selection, modelId, onSelect }: Props) {
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

  let label = modelId || '未选择模型';
  if (selection) {
    const info = models.find(
      (model) => model.providerId === selection.providerId && model.id === selection.model,
    );
    if (info) {
      label = `${info.providerName} / ${info.id}`;
    } else {
      const provider = providers.find((item) => item.id === selection.providerId);
      label = `${provider?.name ?? selection.providerId} / ${selection.model}`;
    }
  }

  return (
    <div className="model-selector" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="model-selector-button"
        aria-label={`当前模型：${label}`}
        aria-expanded={open}
        title={label}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="model-glyph">◇</span>
        <span className="model-selector-label">{label}</span>
        <span className="model-chevron">{open ? '▴' : '▾'}</span>
      </button>

      {open ? (
        <div className="model-menu">
          <div className="model-menu-title">切换模型</div>
          {models.length === 0 ? (
            <div className="model-menu-empty">暂无可用模型</div>
          ) : (
            models.map((model) => {
              const active =
                selection?.providerId === model.providerId &&
                selection?.model === model.id;
              return (
                <button
                  type="button"
                  key={`${model.providerId}::${model.id}`}
                  className={active ? 'model-menu-item active' : 'model-menu-item'}
                  onClick={() => {
                    onSelect({ providerId: model.providerId, model: model.id });
                    setOpen(false);
                  }}
                >
                  <span className="model-menu-name" title={`${model.providerName} / ${model.id}`}>
                    {model.providerName} / {model.id}
                  </span>
                  {active ? <span className="model-menu-check">✓</span> : null}
                </button>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}
