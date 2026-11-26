/**
 * @witcode/security：权限、路径、命令三层安全策略的组装入口。
 *
 * 这是应用层软安全，不提供 OS 级隔离；硬沙盒是 Harness 后续独立层。
 */

import { createCommandGuard } from './command.ts';
import { createPermissionEngine } from './permission.ts';
import { createPathGuard } from './path.ts';
import type { CommandGuard, PathGuard, PermissionEngine, SecurityOptions } from './types.ts';

export type {
  AuditEntry,
  CommandCheck,
  CommandGuard,
  PathCheck,
  PathGuard,
  PermissionDecision,
  PermissionEngine,
  PermissionRequest,
  RiskLevel,
  SecurityOptions,
} from './types.ts';

/**
 * 在既有契约 SecurityOptions 上追加可选调优项；不修改 protocol 契约。
 * 不传时：mode=normal，写入上限 2 MiB，环境白名单与已知命令用内置清单。
 */
export type SecurityConfig = SecurityOptions & {
  maxWriteBytes?: number;
  allowedEnvKeys?: string[];
  allowedCommands?: string[];
};

export interface Security {
  permission: PermissionEngine;
  pathGuard: PathGuard;
  commandGuard: CommandGuard;
}

export function createSecurity(options: SecurityConfig): Security {
  const commandGuard = createCommandGuard({
    allowedEnvKeys: options.allowedEnvKeys,
    allowedCommands: options.allowedCommands,
  });
  const permission = createPermissionEngine({
    mode: options.mode,
    rules: options.rules,
    auditPath: options.auditPath,
    // 自主模式的硬黑名单 / 未知命令否决来自命令层。
    assessCommand: (command) => commandGuard.check(command),
  });
  const pathGuard = createPathGuard({
    workspace: options.workspace,
    maxWriteBytes: options.maxWriteBytes,
  });
  return { permission, pathGuard, commandGuard };
}
