/**
 * 权限层：四模式总开关 + 规则（deny > ask > allow）+ 审计。
 *
 * 这里只做软安全判定；真正的命令黑名单由命令层给出结论（assessCommand）。
 */

import fs from 'node:fs';
import type { PermissionMode, PermissionRule } from '@witcode/protocol';
import type {
  AuditEntry,
  PermissionDecision,
  PermissionEngine,
  PermissionRequest,
  RiskLevel,
} from './types.ts';

export interface CommandAssessment {
  ok: boolean;
  risk: RiskLevel;
  reason?: string;
}

export interface PermissionEngineOptions {
  mode?: PermissionMode;
  rules?: PermissionRule[];
  auditPath?: string;
  /** 命令层的判定结果；用于硬黑名单与风险分级。 */
  assessCommand?: (command: string) => CommandAssessment;
}

const RULE_PRIORITY: Record<PermissionRule['decision'], number> = {
  deny: 0,
  ask: 1,
  allow: 2,
};

const RISK_LABEL: Record<RiskLevel, string> = {
  low: '低风险',
  medium: '中风险',
  high: '高风险',
};

function normalizeCompare(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function matchTool(pattern: string, tool: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return tool.startsWith(pattern.slice(0, -1));
  return pattern === tool;
}

function matchPathPrefix(pattern: string, target: string): boolean {
  const prefix = normalizeCompare(pattern);
  const value = normalizeCompare(target);
  return value === prefix || value.startsWith(prefix + '/');
}

function matchCommandPrefix(pattern: string, command: string): boolean {
  const prefix = pattern.trim().replace(/\s+/g, ' ').toLowerCase().replace(/\*$/, '');
  const value = command.trim().replace(/\s+/g, ' ').toLowerCase();
  return value === prefix || value.startsWith(prefix + ' ');
}

function matchesRule(rule: PermissionRule, request: PermissionRequest): boolean {
  const match = rule.match;
  const specified =
    match.tool !== undefined ||
    match.pathPrefix !== undefined ||
    match.commandPrefix !== undefined;
  if (!specified) return false;
  if (match.tool !== undefined && !matchTool(match.tool, request.tool)) return false;
  if (match.pathPrefix !== undefined) {
    if (request.path === undefined || !matchPathPrefix(match.pathPrefix, request.path)) {
      return false;
    }
  }
  if (match.commandPrefix !== undefined) {
    if (request.command === undefined || !matchCommandPrefix(match.commandPrefix, request.command)) {
      return false;
    }
  }
  return true;
}

function bestRule(rules: PermissionRule[], request: PermissionRequest): PermissionRule | undefined {
  let best: PermissionRule | undefined;
  for (const rule of rules) {
    if (!matchesRule(rule, request)) continue;
    if (best === undefined || RULE_PRIORITY[rule.decision] < RULE_PRIORITY[best.decision]) {
      best = rule;
    }
  }
  return best;
}

/** 非命令工具的风险提示：destructive 必然高，其余可来自 input.riskLevel（缺省 low）。 */
function inputRisk(input: unknown): RiskLevel | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const value = (input as { riskLevel?: unknown }).riskLevel;
  return value === 'low' || value === 'medium' || value === 'high' ? value : undefined;
}

export function createPermissionEngine(options: PermissionEngineOptions = {}): PermissionEngine {
  let mode: PermissionMode = options.mode ?? 'normal';
  const rules = options.rules ?? [];
  const auditPath = options.auditPath;
  const logs: AuditEntry[] = [];

  function decision(
    value: PermissionDecision['decision'],
    reason: string,
    riskLevel: RiskLevel,
    ruleId?: string,
  ): PermissionDecision {
    return ruleId === undefined ? { decision: value, reason, riskLevel } : { decision: value, reason, riskLevel, ruleId };
  }

  function record(request: PermissionRequest, result: PermissionDecision): void {
    const entry: AuditEntry = {
      at: Date.now(),
      tool: request.tool,
      mode,
      decision: result.decision,
      reason: result.reason,
      riskLevel: result.riskLevel,
      source: result.ruleId === undefined ? 'ai' : 'rule',
    };
    logs.push(entry);
    if (auditPath !== undefined) {
      try {
        fs.appendFileSync(auditPath, `${JSON.stringify(entry)}\n`, 'utf8');
      } catch {
        // 审计写失败不能影响工具判定，也不向外抛错。
      }
    }
  }

  function check(raw: Omit<PermissionRequest, 'mode'>): PermissionDecision {
    const request: PermissionRequest = { ...raw, mode };
    const rule = bestRule(rules, request);
    const assessment = request.command ? options.assessCommand?.(request.command) : undefined;
    const hardBlocked = assessment?.ok === false;
    const riskLevel: RiskLevel = request.destructive
      ? 'high'
      : assessment?.risk ?? inputRisk(request.input) ?? 'low';

    let result: PermissionDecision;

    if (mode === 'full') {
      // 总开关放行一切（含硬黑名单），但必须留审计。
      result = decision('allow', '全部模式：放行（仍记录审计）', riskLevel);
    } else if (mode === 'read-only') {
      if (!request.readOnly || request.destructive || request.command !== undefined) {
        result = decision('deny', '只读模式：禁止写入、执行命令或非只读工具', riskLevel);
      } else if (rule?.decision === 'deny') {
        result = decision('deny', rule.reason ?? `规则 ${rule.id} 拒绝`, riskLevel, rule.id);
      } else if (rule?.decision === 'ask') {
        result = decision('ask', rule.reason ?? `规则 ${rule.id} 要求确认`, riskLevel, rule.id);
      } else {
        result = decision('allow', '只读模式：只读工具放行', riskLevel, rule?.id);
      }
    } else if (rule?.decision === 'deny') {
      result = decision('deny', rule.reason ?? `规则 ${rule.id} 拒绝`, riskLevel, rule.id);
    } else if (rule?.decision === 'ask') {
      result = decision('ask', rule.reason ?? `规则 ${rule.id} 要求确认`, riskLevel, rule.id);
    } else if (rule?.decision === 'allow' && !hardBlocked) {
      result = decision('allow', rule.reason ?? `规则 ${rule.id} 放行`, riskLevel, rule.id);
    } else if (hardBlocked) {
      if (mode === 'autonomous') {
        result = decision(
          'deny',
          assessment?.reason ?? '命令层判定危险或无法判定，自主模式拒绝执行',
          riskLevel,
        );
      } else {
        result = decision(
          'ask',
          `普通模式：${assessment?.reason ?? '命令层判定危险或无法判定'}，需确认`,
          riskLevel,
        );
      }
    } else if (mode === 'normal' && request.readOnly && !request.destructive) {
      result = decision('allow', '普通模式：只读工具放行', riskLevel);
    } else if (mode === 'normal') {
      result = decision(
        'ask',
        `普通模式：${RISK_LABEL[riskLevel]}${request.destructive ? '（破坏性操作）' : ''}操作需确认`,
        riskLevel,
      );
    } else if (riskLevel === 'high') {
      result = decision('ask', '自主模式：高风险操作需确认', riskLevel);
    } else {
      result = decision('allow', '自主模式：低/中风险操作自动放行', riskLevel);
    }

    record(request, result);
    return result;
  }

  return {
    getMode: () => mode,
    setMode(next: PermissionMode) {
      mode = next;
    },
    check,
    audit(entry: AuditEntry) {
      logs.push(entry);
      if (auditPath !== undefined) {
        try {
          fs.appendFileSync(auditPath, `${JSON.stringify(entry)}\n`, 'utf8');
        } catch {
          // 同上：审计失败不影响主流程。
        }
      }
    },
    listAudit(limit?: number) {
      if (limit === undefined) return [...logs];
      const count = Math.max(0, Math.floor(limit));
      return logs.slice(Math.max(0, logs.length - count));
    },
  };
}
