/**
 * 安全层的内部契约。
 *
 * 分层：权限（模式/规则）→ 路径（workspace 边界/敏感文件）→ 命令（黑名单/env/超时）。
 * 这是应用层软安全，不替代 OS 级隔离（硬沙盒 P4）。
 */

import type { PermissionMode, PermissionRule, RiskLevel } from '@witcode/protocol';

export type { RiskLevel };

export interface PermissionRequest {
  tool: string;
  input: unknown;
  mode: PermissionMode;
  readOnly: boolean;
  destructive: boolean;
  /** 归一化后的目标路径（如果工具有） */
  path?: string;
  /** 实际命令（如果工具有） */
  command?: string;
}

export interface PermissionDecision {
  decision: 'allow' | 'ask' | 'deny';
  reason: string;
  riskLevel: RiskLevel;
  ruleId?: string;
}

export interface AuditEntry {
  at: number;
  tool: string;
  mode: PermissionMode;
  decision: 'allow' | 'ask' | 'deny';
  reason: string;
  riskLevel: RiskLevel;
  source: 'rule' | 'user' | 'ai';
}

export interface PermissionEngine {
  getMode(): PermissionMode;
  setMode(mode: PermissionMode): void;
  check(request: Omit<PermissionRequest, 'mode'>): PermissionDecision;
  audit(entry: AuditEntry): void;
  listAudit(limit?: number): AuditEntry[];
}

export interface PathCheck {
  ok: boolean;
  reason?: string;
  /** 规范化后的绝对路径 */
  resolved?: string;
}

export interface PathGuard {
  /** 写入前的完整检查：边界 + realpath + 敏感文件 + 大小。 */
  checkForWrite(target: string, options?: { sizeBytes?: number }): Promise<PathCheck>;
  /** 读取检查：边界 + realpath；敏感文件允许读但标记。 */
  checkForRead(target: string): Promise<PathCheck & { sensitive?: boolean }>;
}

export interface CommandCheck {
  ok: boolean;
  risk: RiskLevel;
  reason?: string;
}

export interface CommandGuard {
  check(command: string): CommandCheck;
  /** 给子进程用的环境变量：默认空 + 白名单。 */
  env(overrides?: Record<string, string>): Record<string, string>;
}

export interface SecurityOptions {
  workspace: string;
  mode?: PermissionMode;
  rules?: PermissionRule[];
  /** 审计日志路径；不传则只在内存。 */
  auditPath?: string;
}
