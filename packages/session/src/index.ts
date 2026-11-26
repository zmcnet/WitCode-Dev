/**
 * 基于 Node 内置 node:sqlite 的会话存储实现。
 *
 * node:sqlite 在 Node 24 仍标记为 experimental（运行时会打印 ExperimentalWarning），
 * 但 24.9.0 直接 import 即可使用，无需 --experimental-sqlite flag。
 * 若未来运行时改为必须显式开启，请在 packages/session/package.json 的 test 脚本中追加
 * `--experimental-sqlite`，并保持下面的 import 写法不变。
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type {
  ChatMessage,
  SessionRecord,
  SessionStore,
  SessionSummary,
  ToolCall,
} from '@witcode/protocol';

interface SessionRow {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
}

interface MessageRow {
  role: string;
  content: string;
  tool_call_id: string | null;
  tool_name: string | null;
  tool_calls: string | null;
  created_at: number;
}

function toChatMessage(row: MessageRow): ChatMessage {
  const message: ChatMessage = {
    role: row.role as ChatMessage['role'],
    content: row.content,
  };
  if (row.tool_call_id !== null) message.toolCallId = row.tool_call_id;
  if (row.tool_name !== null) message.toolName = row.tool_name;
  if (row.tool_calls !== null) {
    // 老数据或被外部改坏的 JSON 不应让整个会话读取失败。
    try {
      const parsed: unknown = JSON.parse(row.tool_calls);
      if (Array.isArray(parsed)) message.toolCalls = parsed as ToolCall[];
    } catch {
      // ignore
    }
  }
  return message;
}

export function createSqliteSessionStore(options: { dbPath?: string } = {}): SessionStore {
  const dataDir = process.env.WITCODE_DATA_DIR ?? join(homedir(), '.witcode');
  const dbPath = options.dbPath ?? join(dataDir, 'witcode.db');
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_call_id TEXT,
      tool_name TEXT,
      tool_calls TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC);
  `);

  // 平滑升级旧库：CREATE TABLE IF NOT EXISTS 不会给已存在的表补列。
  const columns = db.prepare('PRAGMA table_info(messages)').all() as unknown as Array<{
    name: string;
  }>;
  if (!columns.some((column) => column.name === 'tool_calls')) {
    db.exec('ALTER TABLE messages ADD COLUMN tool_calls TEXT');
  }

  const insertSession = db.prepare(
    'INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)',
  );
  const selectSession = db.prepare(
    'SELECT id, title, created_at, updated_at FROM sessions WHERE id = ?',
  );
  const selectMessages = db.prepare(
    'SELECT role, content, tool_call_id, tool_name, tool_calls, created_at FROM messages WHERE session_id = ? ORDER BY created_at ASC, id ASC',
  );
  const selectSummaries = db.prepare(
    'SELECT id, title, updated_at FROM sessions ORDER BY updated_at DESC, id DESC',
  );
  const insertMessage = db.prepare(
    'INSERT INTO messages (session_id, role, content, tool_call_id, tool_name, tool_calls, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const touchSession = db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?');
  const renameSession = db.prepare('UPDATE sessions SET title = ? WHERE id = ?');
  const deleteMessages = db.prepare('DELETE FROM messages WHERE session_id = ?');
  const deleteSession = db.prepare('DELETE FROM sessions WHERE id = ?');

  // 同一毫秒内的连续写入也保持严格递增，使 list() 的 updatedAt 排序稳定。
  let lastTimestamp = 0;
  function nextTimestamp(): number {
    const now = Date.now();
    lastTimestamp = now > lastTimestamp ? now : lastTimestamp + 1;
    return lastTimestamp;
  }

  function transact(fn: () => void): void {
    db.exec('BEGIN');
    try {
      fn();
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  const store: SessionStore = {
    async create(title = '新会话'): Promise<SessionRecord> {
      const id = randomUUID();
      const now = nextTimestamp();
      insertSession.run(id, title, now, now);
      return { id, title, createdAt: now, updatedAt: now, messages: [] };
    },

    async get(id): Promise<SessionRecord | null> {
      const row = selectSession.get(id) as unknown as SessionRow | undefined;
      if (!row) return null;
      const messages = selectMessages.all(id) as unknown as MessageRow[];
      return {
        id: row.id,
        title: row.title,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        messages: messages.map(toChatMessage),
      };
    },

    async list(): Promise<SessionSummary[]> {
      const rows = selectSummaries.all() as unknown as Array<
        Pick<SessionRow, 'id' | 'title' | 'updated_at'>
      >;
      return rows.map((row) => ({ id: row.id, title: row.title, updatedAt: row.updated_at }));
    },

    async append(id, message): Promise<void> {
      if (!selectSession.get(id)) throw new Error(`Session not found: ${id}`);
      const now = nextTimestamp();
      transact(() => {
        insertMessage.run(
          id,
          message.role,
          message.content,
          message.toolCallId ?? null,
          message.toolName ?? null,
          message.toolCalls === undefined ? null : JSON.stringify(message.toolCalls),
          now,
        );
        touchSession.run(now, id);
      });
    },

    async rename(id, title): Promise<void> {
      const result = renameSession.run(title, id);
      if (result.changes === 0) throw new Error(`Session not found: ${id}`);
    },

    async remove(id): Promise<void> {
      transact(() => {
        deleteMessages.run(id);
        deleteSession.run(id);
      });
    },
  };

  return store;
}
