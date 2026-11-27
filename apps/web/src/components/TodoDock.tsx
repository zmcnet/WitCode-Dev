/**
 * DSH 风格的待办停靠条：输入框上方的一行紧凑状态 + 可展开的完整清单。
 * 图标沿用 components/icons.tsx 的线性风格（16px / 1.75 描边 / currentColor），
 * 颜色全部取自 styles.css 的 ZCode 主题变量，深浅主题自动适配。
 */
import { useState } from 'react';
import type { TodoItem } from '@witcode/protocol';
import { IconCheck, IconChevronDown } from './icons';
import './todo.css';

export interface TodoDockProps {
  items: TodoItem[];
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}

type IconProps = { size?: number; className?: string | undefined };

function iconBase({ size = 16, className }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true as const,
    className,
  };
}

/** pending：空心圆。 */
function IconCircleOutline(props: IconProps) {
  return (
    <svg {...iconBase(props)}>
      <circle cx="12" cy="12" r="8.5" />
    </svg>
  );
}

/** in_progress：右侧半环 + 脉冲点。 */
function IconHalfRing(props: IconProps) {
  return (
    <svg {...iconBase(props)}>
      <path d="M12 3.5a8.5 8.5 0 0 1 0 17" />
      <circle className="todo-dock__pulse" cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
    </svg>
  );
}

function StatusIcon({ status }: { status: TodoItem['status'] }) {
  if (status === 'completed') return <IconCheck size={16} />;
  if (status === 'in_progress') return <IconHalfRing size={16} />;
  return <IconCircleOutline size={16} />;
}

export function TodoDock({ items, collapsed, onToggleCollapsed }: TodoDockProps): JSX.Element | null {
  const [internalCollapsed, setInternalCollapsed] = useState(true);

  if (items.length === 0) return null;

  const isControlled = collapsed !== undefined;
  const isCollapsed = isControlled ? collapsed : internalCollapsed;
  const completed = items.filter((item) => item.status === 'completed').length;
  const current = items.find((item) => item.status === 'in_progress');

  const toggle = () => {
    if (!isControlled) setInternalCollapsed((value) => !value);
    onToggleCollapsed?.();
  };

  return (
    <div className="todo-dock">
      <div className="todo-dock__summary">
        <span className="todo-dock__count">
          <IconCheck size={14} />
          <span>
            {completed}/{items.length} 待办
          </span>
        </span>
        {current ? (
          <span className="todo-dock__current" title={current.content}>
            <IconHalfRing size={14} />
            <span className="todo-dock__current-text">{current.content}</span>
          </span>
        ) : null}
        <button
          type="button"
          className="todo-dock__toggle"
          onClick={toggle}
          aria-expanded={!isCollapsed}
          aria-label={isCollapsed ? '展开待办清单' : '收起待办清单'}
        >
          <IconChevronDown size={14} className={isCollapsed ? undefined : 'todo-dock__chevron--open'} />
        </button>
      </div>
      {isCollapsed ? null : (
        <ul className="todo-dock__list">
          {items.map((item) => (
            <li key={item.id} className={`todo-dock__item todo-dock__item--${item.status}`}>
              <span className="todo-dock__status">
                <StatusIcon status={item.status} />
              </span>
              <span className="todo-dock__text">{item.content}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
