/**
 * 路径层：归一化 → workspace 边界 → 逐级 lstat 符号链接 → realpath → 敏感文件/大小。
 *
 * 注意：这是应用层软边界，不是 OS 级隔离。
 */

import fs from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';
import type { PathCheck, PathGuard } from './types.ts';

export interface PathGuardOptions {
  workspace: string;
  /** 默认 2 MiB。 */
  maxWriteBytes?: number;
}

const DEFAULT_MAX_WRITE_BYTES = 2 * 1024 * 1024;

/** 绝对路径归一化：兼容 MSYS 风格的 /c/... 与大小写盘符。 */
function normalizeAbsolute(input: string, workspace: string): string {
  let value = input.trim();
  if (process.platform === 'win32' && /^\/[A-Za-z](\/|$)/.test(value)) {
    value = `${value.charAt(1).toUpperCase()}:${value.slice(2)}`;
  }
  if (!path.isAbsolute(value)) value = path.resolve(workspace, value);
  return path.normalize(value);
}

function compareKey(value: string): string {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isInside(workspace: string, target: string): boolean {
  const root = compareKey(workspace);
  const value = compareKey(target);
  if (root === value) return true;
  return value.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

function relativeSegments(workspace: string, target: string): string[] {
  const relative = path.relative(path.resolve(workspace), path.resolve(target));
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return [];
  return relative.split(path.sep).filter((segment) => segment !== '' && segment !== '.');
}

/** 从 workspace 往目标逐级 lstat；任一级是链接就拒绝（包括指向 workspace 内部的链接）。 */
function symlinkFailure(workspace: string, target: string): PathCheck | undefined {
  let current = path.resolve(workspace);
  for (const segment of relativeSegments(workspace, target)) {
    current = path.join(current, segment);
    let stat: Stats;
    try {
      stat = fs.lstatSync(current);
    } catch {
      // ENOENT/ENOTDIR：后续层级尚不存在，没有链接可查。
      break;
    }
    if (stat.isSymbolicLink()) {
      return { ok: false, reason: `路径包含符号链接，拒绝写入或读取：${current}` };
    }
  }
  return undefined;
}

/** 找最接近目标的已存在路径，realpath 后必须仍落在 workspace 内。 */
function realpathFailure(
  workspace: string,
  target: string,
): { failure?: PathCheck; resolved?: string } {
  let ancestor = path.resolve(target);
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  let real: string;
  try {
    real = fs.realpathSync(ancestor);
  } catch {
    return { failure: { ok: false, reason: `无法解析真实路径：${ancestor}` } };
  }
  if (!isInside(workspace, real)) {
    return { failure: { ok: false, reason: `真实路径超出工作区：${real}` } };
  }
  const remainder = path.relative(ancestor, path.resolve(target));
  return { resolved: remainder === '' ? real : path.join(real, remainder) };
}

/** 敏感文件判定基于 workspace 内相对路径，大小写/分隔符不敏感。 */
function isSensitive(relative: string): boolean {
  const segments = relative
    .split(/[\\/]+/)
    .filter((segment) => segment !== '' && segment !== '.')
    .map((segment) => segment.toLowerCase());
  if (segments.length === 0) return false;
  const base = segments[segments.length - 1] ?? '';
  if (segments.some((segment) => segment.startsWith('.env'))) return true;
  if (base.endsWith('.pem')) return true;
  if (base.startsWith('id_rsa')) return true;
  const ssh = segments.indexOf('.ssh');
  if (ssh >= 0 && ssh < segments.length - 1) return true;
  const git = segments.indexOf('.git');
  if (git >= 0 && segments[git + 1] === 'config') return true;
  return false;
}

export function createPathGuard(options: PathGuardOptions): PathGuard {
  const workspace = path.resolve(options.workspace);
  const maxWriteBytes = options.maxWriteBytes ?? DEFAULT_MAX_WRITE_BYTES;

  function bound(target: string): { normalized?: string; failure?: PathCheck } {
    const normalized = normalizeAbsolute(target, workspace);
    if (!isInside(workspace, normalized)) {
      return { failure: { ok: false, reason: `路径超出工作区：${normalized}` } };
    }
    return { normalized };
  }

  return {
    async checkForWrite(target: string, writeOptions?: { sizeBytes?: number }): Promise<PathCheck> {
      const { normalized, failure } = bound(target);
      if (failure || normalized === undefined) {
        return failure ?? { ok: false, reason: '路径无效' };
      }

      const relative = path.relative(workspace, normalized);
      if (isSensitive(relative)) {
        return { ok: false, reason: '敏感文件禁止写入' };
      }

      const link = symlinkFailure(workspace, normalized);
      if (link) return link;

      const real = realpathFailure(workspace, normalized);
      if (real.failure || real.resolved === undefined) {
        return real.failure ?? { ok: false, reason: '无法解析真实路径' };
      }

      const size = writeOptions?.sizeBytes;
      if (size !== undefined && (!Number.isFinite(size) || size < 0)) {
        return { ok: false, reason: '写入大小无效' };
      }
      if (size !== undefined && size > maxWriteBytes) {
        return { ok: false, reason: `写入大小 ${size} 字节超过上限 ${maxWriteBytes} 字节` };
      }
      try {
        const stat = fs.statSync(real.resolved);
        if (stat.isDirectory()) return { ok: false, reason: '目标路径是目录' };
        if (stat.size > maxWriteBytes) {
          return { ok: false, reason: `文件已有大小 ${stat.size} 字节超过上限 ${maxWriteBytes} 字节` };
        }
      } catch {
        // 目标不存在：只需检查父目录边界。
      }

      return { ok: true, resolved: real.resolved };
    },

    async checkForRead(target: string): Promise<PathCheck & { sensitive?: boolean }> {
      const { normalized, failure } = bound(target);
      if (failure || normalized === undefined) {
        return failure ?? { ok: false, reason: '路径无效' };
      }

      // 读取侧靠 realpath 判边界：工作区内部链接可读，链接逃逸会被 realpathFailure 拒绝。
      const real = realpathFailure(workspace, normalized);
      if (real.failure || real.resolved === undefined) {
        return real.failure ?? { ok: false, reason: '无法解析真实路径' };
      }

      const relative = path.relative(workspace, normalized);
      const sensitive =
        isSensitive(relative) || isSensitive(path.relative(workspace, real.resolved));
      return sensitive
        ? { ok: true, resolved: real.resolved, sensitive: true }
        : { ok: true, resolved: real.resolved };
    },
  };
}
