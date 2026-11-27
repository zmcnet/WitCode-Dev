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
  SessionSearchHit,
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

const SNIPPET_RADIUS = 60;

/** 找到命中位置（LIKE 默认 ASCII 大小写不敏感），再做片段与空白折叠。 */
function hitIndex(content: string, query: string): number {
  const lowered = content.toLowerCase();
  const needle = query.toLowerCase();
  let index = lowered.indexOf(needle);
  // 极少数 Unicode 字符大小写折叠会改变长度，此时下标不再对应原文，退回区分大小写匹配。
  if (index === -1 || lowered.length !== content.length) {
    index = content.indexOf(query);
  }
  return index === -1 ? 0 : index;
}

function buildSnippet(content: string, query: string): string {
  const index = hitIndex(content, query);
  const start = Math.max(0, index - SNIPPET_RADIUS);
  const end = Math.min(content.length, index + query.length + SNIPPET_RADIUS);
  const text = content.slice(start, end).replace(/\s+/g, ' ').trim();
  return `…${text}…`;
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
      updated_at INTEGER NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0
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
  const sessionColumns = db.prepare('PRAGMA table_info(sessions)').all() as unknown as Array<{
    name: string;
  }>;
  if (!sessionColumns.some((column) => column.name === 'archived')) {
    db.exec('ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
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
    'SELECT id, title, updated_at FROM sessions WHERE archived = 0 ORDER BY updated_at DESC, id DESC',
  );
  const selectArchivedSummaries = db.prepare(
    'SELECT id, title, updated_at FROM sessions WHERE archived = 1 ORDER BY updated_at DESC, id DESC',
  );
  // 每个会话只取最新一条命中消息，再按会话更新时间倒序；LIKE 的 %/_ 由调用方转义。
  const selectSearchHits = db.prepare(`
    SELECT s.id AS sessionId, s.title, s.updated_at AS updatedAt, m.content
    FROM sessions AS s
    JOIN (
      SELECT session_id, content,
             ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY created_at DESC, id DESC) AS rn
      FROM messages
      WHERE content LIKE ? ESCAPE '\\'
    ) AS m ON m.session_id = s.id AND m.rn = 1
    ORDER BY s.updated_at DESC, s.id DESC
    LIMIT ?
  `);
  const setArchived = db.prepare('UPDATE sessions SET archived = ? WHERE id = ?');
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

    async listArchived(): Promise<SessionSummary[]> {
      const rows = selectArchivedSummaries.all() as unknown as Array<
        Pick<SessionRow, 'id' | 'title' | 'updated_at'>
      >;
      return rows.map((row) => ({
        id: row.id,
        title: row.title,
        updatedAt: row.updated_at,
        archived: true,
      }));
    },

    async search(query, limit): Promise<SessionSearchHit[]> {
      const text = typeof query === 'string' ? query.trim() : '';
      if (text === '') return [];
      const size = typeof limit === 'number' && Number.isFinite(limit)
        ? Math.min(20, Math.max(1, Math.trunc(limit)))
        : 10;
      // 先转义反斜杠，再转义 LIKE 通配符，避免查询里的 %/_ 被当成模式。
      const escaped = text.replace(/[\\%_]/g, '\\$&');
      const rows = selectSearchHits.all(`%${escaped}%`, size) as unknown as Array<{
        sessionId: string;
        title: string;
        updatedAt: number;
        content: string;
      }>;
      return rows.map((row) => ({
        sessionId: row.sessionId,
        title: row.title,
        snippet: buildSnippet(row.content, text),
        updatedAt: row.updatedAt,
      }));
    },

    async archive(id, archived): Promise<void> {
      const result = setArchived.run(archived ? 1 : 0, id);
      if (result.changes === 0) throw new Error(`Session not found: ${id}`);
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
