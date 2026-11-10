import { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage } from './messages.js';
import { UserError } from './core/host.js';

export interface Task {
  id: number;
  chat_key: string;
  prompt: string;
  metadata: string | null;
}

export interface Delivery {
  id: number;
  reply_parts: string;
  next_part: number;
  attempts: number;
  webhook: string;
  expires_at: number;
}

const interruptedReply = '上次任务因服务中断而未能确认结果。为避免重复执行，系统没有自动重跑；请先确认任务状态，再决定是否重新提出。';
// 活动仍可能继续产出正文。用发送期限的哨兵记录等待新地址，不改变执行状态。
const waitingForWebhook = -1;

export class Store {
  private readonly db: DatabaseSync;

  constructor(filename: string, owner = 'dsh-sdk') {
    this.db = new DatabaseSync(filename);
    try {
    // 独占连接防止两个服务同时恢复、执行同一批任务。
    this.db.exec(`
      PRAGMA busy_timeout = 1000;
      PRAGMA locking_mode = EXCLUSIVE;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      BEGIN EXCLUSIVE;
      CREATE TABLE IF NOT EXISTS conversations (
        chat_key TEXT PRIMARY KEY,
        session_id TEXT,
        webhook TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_key TEXT NOT NULL UNIQUE,
        chat_key TEXT NOT NULL REFERENCES conversations(chat_key),
        prompt TEXT NOT NULL,
        metadata TEXT,
        state TEXT NOT NULL CHECK(state IN ('queued', 'running', 'ready', 'expired', 'sent')),
        reply_parts TEXT,
        next_part INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS messages_state ON messages(state, id);
      CREATE TABLE IF NOT EXISTS bridge_owner (id INTEGER PRIMARY KEY CHECK(id = 1), kind TEXT NOT NULL);
    `);
    const savedOwner = this.db.prepare('SELECT kind FROM bridge_owner WHERE id = 1').get();
    const hasOldMapping = Number(this.db.prepare('SELECT COUNT(*) AS total FROM conversations').get()?.total) > 0;
    const expectedOwner = savedOwner?.kind ?? (hasOldMapping ? 'dsh-sdk' : owner);
    if (expectedOwner !== owner) throw new UserError('此数据目录已用于另一种运行模式，请为当前模式配置新的 mapping 数据目录。');
    if (!this.db.prepare('PRAGMA table_info(messages)').all().some((column) => column.name === 'metadata')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN metadata TEXT');
    }
    this.db.prepare('INSERT OR IGNORE INTO bridge_owner(id, kind) VALUES (1, ?)').run(owner);
    const interrupted = this.db.prepare("SELECT MIN(id) AS id FROM messages WHERE state = 'running' GROUP BY chat_key").all();
    for (const row of interrupted) this.complete(Number(row.id), [interruptedReply]);
    this.db.exec('COMMIT');
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  receive(message: IncomingMessage): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT INTO conversations(chat_key, webhook, expires_at) VALUES (?, ?, ?)
        ON CONFLICT(chat_key) DO UPDATE SET webhook = excluded.webhook, expires_at = excluded.expires_at
        WHERE excluded.expires_at >= conversations.expires_at`)
        .run(message.chatKey, message.webhook, message.expiresAt);
      this.db.prepare(`UPDATE messages SET state = CASE WHEN state = 'expired' THEN 'ready' ELSE state END,
        attempts = 0, next_attempt_at = 0 WHERE chat_key = ? AND (state = 'expired' OR next_attempt_at = ?)`)
        .run(message.chatKey, waitingForWebhook);
      const inserted = this.db.prepare(`INSERT OR IGNORE INTO messages
        (message_key, chat_key, prompt, metadata, state, reply_parts) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(message.key, message.chatKey, message.prompt, message.metadata ?? null, message.immediateReply ? 'ready' : 'queued',
          message.immediateReply ? JSON.stringify([message.immediateReply]) : null);
      this.db.exec('COMMIT');
      return Number(inserted.changes) === 1;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  sessionId(chatKey: string): string | undefined {
    const row = this.db.prepare('SELECT session_id FROM conversations WHERE chat_key = ?').get(chatKey);
    return typeof row?.session_id === 'string' ? row.session_id : undefined;
  }

  bind(chatKey: string, sessionId: string): void {
    this.db.prepare('UPDATE conversations SET session_id = ? WHERE chat_key = ?').run(sessionId, chatKey);
  }

  nextTask(chatKey?: string): Task | undefined {
    const task = this.db.prepare(`SELECT id, chat_key, prompt, metadata FROM messages
      WHERE state = 'queued' AND (? IS NULL OR chat_key = ?) ORDER BY id LIMIT 1`)
      .get(chatKey ?? null, chatKey ?? null) as unknown as Task | undefined;
    if (task) this.db.prepare("UPDATE messages SET state = 'running' WHERE id = ?").run(task.id);
    return task;
  }

  requeue(id: number): void {
    this.db.prepare("UPDATE messages SET state = 'queued' WHERE id = ? AND state = 'running'").run(id);
  }

  private withReplyParts(id: number, parts: string[]): string[] {
    const row = this.db.prepare("SELECT reply_parts FROM messages WHERE id = ? AND state = 'running'").get(id);
    if (!row) throw new Error('回复对应的任务未在执行。');
    const saved: string[] = typeof row.reply_parts === 'string' ? JSON.parse(row.reply_parts) : [];
    return [...saved, ...parts];
  }

  appendReply(id: number, parts: string[]): void {
    this.db.prepare("UPDATE messages SET reply_parts = ? WHERE id = ? AND state = 'running'")
      .run(JSON.stringify(this.withReplyParts(id, parts)), id);
  }

  complete(id: number, parts: string[]): void {
    const all = this.withReplyParts(id, parts);
    // 同一时间只执行一个活动。该聊天其余执行中记录是已交给同一 Agent 的补充消息。
    this.db.prepare(`UPDATE messages SET
      state = CASE WHEN id <> $id OR next_part >= $count THEN 'sent'
        WHEN next_attempt_at = $waiting THEN 'expired' ELSE 'ready' END,
      prompt = CASE WHEN id = $id AND next_part < $count THEN prompt ELSE '' END,
      metadata = NULL,
      reply_parts = CASE WHEN id = $id AND next_part < $count THEN $parts ELSE NULL END
      WHERE state = 'running' AND chat_key = (SELECT chat_key FROM messages WHERE id = $id)`)
      .run({ id, count: all.length, waiting: waitingForWebhook, parts: JSON.stringify(all) });
  }

  nextDelivery(): Delivery | undefined {
    return this.db.prepare(`SELECT m.id, m.reply_parts, m.next_part, m.attempts, c.webhook, c.expires_at
      FROM messages m JOIN conversations c ON c.chat_key = m.chat_key
      WHERE m.state IN ('running', 'ready') AND m.next_attempt_at >= 0 AND m.next_attempt_at <= ?
        AND m.next_part < json_array_length(m.reply_parts)
        AND NOT EXISTS (SELECT 1 FROM messages older WHERE older.chat_key = m.chat_key
          AND older.id < m.id AND older.state != 'sent')
      ORDER BY m.id LIMIT 1`).get(Date.now()) as unknown as Delivery | undefined;
  }

  deliveredPart(id: number, nextPart: number): void {
    // 网络发送期间可能又来了新正文，以写入时的完整队列为准。
    this.db.prepare(`UPDATE messages SET next_part = ?, attempts = 0, next_attempt_at = 0,
      state = CASE WHEN state = 'ready' AND ? >= json_array_length(reply_parts) THEN 'sent' ELSE state END
      WHERE id = ?`).run(nextPart, nextPart, id);
    this.db.prepare("UPDATE messages SET prompt = '', reply_parts = NULL WHERE id = ? AND state = 'sent'").run(id);
  }

  retry(id: number, attempts: number): void {
    const delay = Math.min(60_000, 2_000 * 2 ** Math.min(attempts, 5));
    this.db.prepare('UPDATE messages SET attempts = ?, next_attempt_at = ? WHERE id = ?')
      .run(attempts, Date.now() + delay, id);
  }

  expire(id: number, expiresAt: number): void {
    this.db.prepare(`UPDATE messages SET next_attempt_at = ?,
      state = CASE WHEN state = 'running' THEN 'running' ELSE 'expired' END
      WHERE id = ? AND (SELECT expires_at FROM conversations WHERE chat_key = messages.chat_key) <= ?`)
      .run(waitingForWebhook, id, expiresAt);
  }

  close(): void {
    this.db.close();
  }
}
