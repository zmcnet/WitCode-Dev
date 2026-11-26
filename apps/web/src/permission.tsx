import type { PermissionMode } from '@witcode/protocol';

export interface PermissionOption {
  mode: PermissionMode;
  label: string;
  description: string;
}

/** 前端默认值：拿不到后端下发时也按普通模式渲染。 */
const NORMAL_OPTION: PermissionOption = {
  mode: 'normal',
  label: '普通',
  description: '使用原生工具，危险动作先询问确认。',
};

/** 四种用户级权限模式的展示文案；顺序即界面展示顺序。 */
export const PERMISSION_MODES: PermissionOption[] = [
  {
    mode: 'read-only',
    label: '只读',
    description: '只能读取、搜索和查看，不执行任何写操作。',
  },
  NORMAL_OPTION,
  {
    mode: 'autonomous',
    label: '自主',
    description: '由 AI 自行判断执行，Harness 只做审计。',
  },
  {
    mode: 'full',
    label: '全部',
    description: '不拦截任何操作，只记录执行过程。',
  },
];

export function permissionOption(mode: PermissionMode): PermissionOption {
  return PERMISSION_MODES.find((item) => item.mode === mode) ?? NORMAL_OPTION;
}

export function permissionLabel(mode: PermissionMode): string {
  return permissionOption(mode).label;
}

export function ShieldIcon() {
  return (
    <svg
      className="permission-glyph"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M8 1.5 13.5 3.5v4.2c0 3.2-2.2 5.6-5.5 6.8-3.3-1.2-5.5-3.6-5.5-6.8V3.5L8 1.5Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M8 5v3.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="8" cy="10.3" r="0.8" fill="currentColor" />
    </svg>
  );
}
