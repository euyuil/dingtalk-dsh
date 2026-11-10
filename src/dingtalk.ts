import { Worker } from 'node:worker_threads';
import { marked, type Token } from 'marked';
import type { BridgeConfig } from './config.js';
import { UserError } from './core/host.js';
import { ReplyExpiredError } from './core/channel.js';
import type { Logger, MessageChannel } from './core/channel.js';
import { parseMessage, validWebhook } from './messages.js';
import type { IncomingMessage } from './messages.js';

const markdownFormatting = new Set([
  'heading', 'strong', 'em', 'del', 'list', 'code', 'codespan', 'blockquote', 'table', 'hr', 'image',
]);

function markdownTitle(text: string): string | undefined {
  const tokens = marked.lexer(text);
  let formatted = false;
  const previews: Token[][] = [];
  marked.walkTokens(tokens, (token) => {
    // 裸链接也会产生链接标记，只把带标签的链接当作排版。
    if (markdownFormatting.has(token.type) || (token.type === 'link' && token.raw.startsWith('['))) {
      formatted = true;
    }
    if ((token.type === 'paragraph' || token.type === 'text') && token.tokens) previews.push(token.tokens);
    if (token.type === 'table') {
      for (const cell of token.header) previews.push(cell.tokens);
    }
  });
  if (!formatted) return undefined;

  const firstBlock = tokens.find((token) => token.type !== 'space');
  if (firstBlock?.type === 'heading' && firstBlock.depth <= 2 && firstBlock.tokens) {
    previews.unshift(firstBlock.tokens);
  }
  const parser = new marked.Parser();
  parser.textRenderer.html = () => '';
  for (const preview of previews) {
    const [firstLine] = parser.parseInline(preview, parser.textRenderer).trim().split(/\r?\n/, 1);
    const characters = Array.from(firstLine?.replace(/\s+/g, ' ').trim() ?? '');
    if (characters.length > 40) return `${characters.slice(0, 39).join('')}…`;
    if (characters.length > 0) return characters.join('');
  }
  return tokens.some((token) => token.type === 'code') ? '代码示例' : '回复内容';
}

/** 网络传输可复用；SDK 日志隔离在线程中，不改写 GUI 的全局 console。 */
export class DingTalk implements MessageChannel {
  private worker?: Worker;
  private stopped = false;
  private exited = false;
  private closing?: Promise<void>;
  private token?: { value: string; expiresAt: number };

  constructor(private readonly config: BridgeConfig, private readonly log: Logger, private readonly onFailure: () => void) {}

  async connect(receive: (message: IncomingMessage) => void): Promise<void> {
    if (this.worker || this.stopped) throw new UserError('机器人传输不可重复启动。');
    const worker = new Worker(new URL('./channels/dingtalk-worker.js', import.meta.url), {
      workerData: { clientId: this.config.clientId, clientSecret: this.config.clientSecret },
      stdout: true, stderr: true, execArgv: [],
    });
    this.worker = worker;
    // 第三方日志可能带请求对象，不能直接转发给 CLI 或桌面宿主。
    worker.stdout?.resume();
    worker.stderr?.resume();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(new UserError('机器人传输启动超时，请检查运行环境。')), 20_000);
        worker.on('message', (event: { type: string; id?: string; data?: string; connected?: boolean; stream?: Record<string, unknown> }) => {
          if (this.stopped) return;
          if (event.type === 'ready' || event.type === 'status') {
            this.log(event.connected ? '钉钉连接已建立。' : '钉钉暂未连接，正在自动重试；请检查网络和 Stream 配置。');
            if (event.type === 'ready') resolve();
          } else if (event.type === 'failed') {
            reject(new UserError('机器人传输启动失败，请检查应用配置。'));
            this.onFailure();
          } else if (event.type === 'message' && event.id && typeof event.data === 'string') {
            let parsed: IncomingMessage | undefined;
            try { parsed = parseMessage(event.data, event.id, this.config.clientId, event.stream); } catch {
              this.log('已忽略格式无效的钉钉消息。');
            }
            let ack = true;
            try { if (parsed) receive(parsed); } catch {
              ack = false;
              this.log('消息写入失败，尚未确认收到；请检查磁盘和数据库。');
            }
            worker.postMessage({ type: 'ack', id: event.id, ack });
          }
        });
        const failed = () => {
          reject(new UserError('机器人传输已中断，请重新启动桥接。'));
          if (!this.stopped) this.onFailure();
        };
        worker.on('error', failed);
        worker.on('exit', () => { this.exited = true; failed(); });
      });
    } finally { if (timer) clearTimeout(timer); }
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;
    const response = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appKey: this.config.clientId, appSecret: this.config.clientSecret }),
      signal: AbortSignal.timeout(15_000), redirect: 'error',
    });
    const body = await response.json() as { accessToken?: unknown; expireIn?: unknown };
    if (!response.ok || typeof body.accessToken !== 'string' || !body.accessToken) throw new Error('钉钉访问凭证获取失败。');
    const lifetime = Number(body.expireIn);
    if (!Number.isFinite(lifetime) || lifetime <= 0) throw new Error('钉钉访问凭证有效期无效。');
    this.token = { value: body.accessToken, expiresAt: Date.now() + Math.max(0, lifetime - 60) * 1_000 };
    return this.token.value;
  }

  async send(webhook: string, expiresAt: number, text: string): Promise<void> {
    if (!validWebhook(webhook)) throw new Error('回复地址无效。');
    if (expiresAt <= Date.now()) throw new ReplyExpiredError();
    const title = markdownTitle(text);
    const payload = title
      ? { msgtype: 'markdown', markdown: { title, text } }
      : { msgtype: 'text', text: { content: text } };
    const token = await this.accessToken();
    if (expiresAt <= Date.now()) throw new ReplyExpiredError();
    const response = await fetch(webhook, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000), redirect: 'error',
    });
    const body = await response.json() as { errcode?: unknown };
    if (response.status === 401 || [40014, 42001].includes(Number(body.errcode))) this.token = undefined;
    if (!response.ok || body.errcode !== 0) throw new Error('钉钉回复发送失败。');
  }

  disconnect(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    const worker = this.worker;
    this.closing = worker && !this.exited ? new Promise<void>((resolve) => {
      const timer = setTimeout(() => { void worker.terminate().then(() => resolve(), () => resolve()); }, 12_000);
      worker.once('exit', () => { clearTimeout(timer); resolve(); });
      worker.postMessage({ type: 'stop' });
    }) : Promise.resolve();
    return this.closing;
  }
}
