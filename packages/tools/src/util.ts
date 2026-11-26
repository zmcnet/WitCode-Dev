import path from 'node:path';

/** Loose record used for the JSON objects models send as tool input. */
export type Input = Record<string, unknown>;

/** Reject anything that is not a JSON object before a tool reads from it. */
export function asInput(input: unknown): Input {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('invalid input: expected an object');
  }
  return input as Input;
}

export function readString(input: Input, key: string, required: boolean): string | undefined {
  const value = input[key];
  if (value === undefined) {
    if (required) throw new Error(`invalid input: missing "${key}"`);
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`invalid input: "${key}" must be a string`);
  }
  return value;
}

export function readNumber(input: Input, key: string, fallback: number): number {
  const value = input[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`invalid input: "${key}" must be a finite number`);
  }
  return value;
}

/**
 * Resolve a user supplied path and keep it lexically inside the workspace.
 * Absolute paths and `..` traversal are rejected with a stable message.
 */
export function safePath(workspace: string, userPath?: string): string {
  const root = path.resolve(workspace);
  const target = path.resolve(root, userPath ?? '.');
  const rel = path.relative(root, target);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error('path escapes workspace');
  }
  return target;
}

/** Accumulate child-process output without letting it grow past a byte cap. */
export class CappedBuffer {
  private readonly chunks: Buffer[] = [];
  private readonly maxBytes: number;
  private bytes = 0;
  truncated = false;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  push(chunk: Buffer): void {
    if (this.truncated) return;
    const room = this.maxBytes - this.bytes;
    if (chunk.length <= room) {
      this.chunks.push(chunk);
      this.bytes += chunk.length;
      return;
    }
    this.chunks.push(chunk.subarray(0, Math.max(0, room)));
    this.bytes = this.maxBytes;
    this.truncated = true;
  }

  toString(): string {
    return Buffer.concat(this.chunks, this.bytes).toString('utf8');
  }
}
