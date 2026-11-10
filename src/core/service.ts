import type { BridgeConfig } from '../config.js';
import { redactReply, splitReply } from '../messages.js';
import type { Store } from '../store.js';
import type { ConversationRunner } from './runner.js';
import { ReplyExpiredError } from './channel.js';
import type { Logger, MessageChannel } from './channel.js';

/** 共享队列和发送重试，不注册进程信号、不修改全局环境、不选择宿主模式。 */
export class BridgeService {
  private stopping = false;
  private started = false;
  private task?: Promise<void>;
  private delivery?: Promise<void>;
  private workerTimer?: ReturnType<typeof setInterval>;
  private deliveryTimer?: ReturnType<typeof setInterval>;
  private nextSendAt = 0;
  private shutdown?: Promise<void>;

  constructor(
    private readonly config: BridgeConfig, private readonly store: Store,
    private readonly runner: ConversationRunner, private readonly channel: MessageChannel,
    private readonly log: Logger, private readonly onFailure: () => void = () => undefined,
  ) {}

  async start(): Promise<void> {
    if (this.started || this.stopping) throw new Error('桥接实例不可重复启动。');
    this.started = true;
    this.workerTimer = setInterval(() => { void this.processOne().catch(() => this.fail()); }, 500);
    this.deliveryTimer = setInterval(() => { void this.deliverOne().catch(() => this.fail()); }, 1_000);
    try {
      await this.channel.connect((message) => {
        if (this.stopping) throw new Error('桥接实例已停止。');
        if (this.store.receive(message)) {
          this.log('已接收一条消息并持久化。');
          try { this.steerQueued(message.chatKey); } catch { this.fail(); }
        }
      });
    } catch (error) { await this.stop(); throw error; }
  }

  private steerQueued(chatKey?: string): void {
    const steering = this.runner.steering;
    if (!steering || (chatKey !== undefined && steering.chatKey !== chatKey)) return;
    const message = this.store.nextTask(steering.chatKey);
    if (message && !steering.submit(message.prompt, message.metadata ?? undefined)) this.store.requeue(message.id);
  }

  async processOne(): Promise<void> {
    if (this.stopping) return this.task;
    if (this.task) {
      this.steerQueued();
      return this.task;
    }
    this.task = (async () => {
      const message = this.store.nextTask();
      if (!message) return;
      this.log('正在处理一条 Agent 任务。');
      const reply = await this.runner.answer(message.chat_key, message.prompt, ({ text }) => {
        if (this.stopping) return;
        try {
          this.store.appendReply(message.id, splitReply(redactReply(text, this.config)));
          void this.deliverOne().catch(() => this.fail());
        } catch {
          this.fail();
        }
      }, message.metadata ?? undefined);
      this.store.complete(message.id, reply ? splitReply(redactReply(reply, this.config)) : []);
      this.log('任务处理已结束，回复已保存。');
    })().finally(() => { this.task = undefined; });
    return this.task;
  }

  deliverOne(): Promise<void> {
    if (this.stopping || this.delivery || Date.now() < this.nextSendAt) return this.delivery ?? Promise.resolve();
    this.delivery = (async () => {
      const item = this.store.nextDelivery();
      if (!item) return;
      const parts = JSON.parse(item.reply_parts) as string[];
      const part = parts[item.next_part];
      if (typeof part !== 'string') throw new Error('待发送回复数据无效。');
      this.nextSendAt = Date.now() + 3_200;
      try { await this.channel.send(item.webhook, item.expires_at, part); } catch (error) {
        if (error instanceof ReplyExpiredError || item.expires_at <= Date.now()) {
          this.store.expire(item.id, item.expires_at);
          this.log('回复窗口已过期，结果已保留；同一聊天下次发消息时继续发送。');
        } else {
          this.store.retry(item.id, item.attempts + 1);
          if (item.attempts === 0) this.log('回复发送失败，将重试发送已保存的结果。');
        }
        return;
      }
      this.store.deliveredPart(item.id, item.next_part + 1);
      this.log('已发送一段回复。');
    })().finally(() => { this.delivery = undefined; });
    return this.delivery;
  }

  fail(): void {
    if (this.stopping) return;
    this.log('桥接内部处理失败；正在停止本桥接实例。');
    this.onFailure();
    void this.stop().catch(() => this.log('桥接资源未能正常释放，请检查宿主状态。'));
  }

  stop(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.stopping = true;
    clearInterval(this.workerTimer);
    clearInterval(this.deliveryTimer);
    this.shutdown = (async () => {
      this.log('正在停止桥接并保存任务状态。');
      const results = await Promise.allSettled([this.channel.disconnect(), this.runner.close()]);
      await Promise.allSettled([this.task, this.delivery]);
      this.store.close();
      if (results.some((result) => result.status === 'rejected')) throw new Error('桥接资源清理失败。');
      this.log('桥接已停止。');
    })();
    return this.shutdown;
  }
}
