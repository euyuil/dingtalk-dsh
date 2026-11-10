import { HostCleanupError, UserError } from './host.js';
import type { AgentHost, AgentSession, AgentUpdate } from './host.js';

export interface SessionMapping {
  sessionId(chatKey: string): string | undefined;
  bind(chatKey: string, sessionId: string): void;
}

/** 两个入口共用的会话路由和任务期限，不管理外部宿主生命周期。 */
export class ConversationRunner {
  private active?: { chatKey: string; controller: AbortController; session?: AgentSession };
  private stopped = false;

  constructor(private readonly host: AgentHost, private readonly mapping: SessionMapping, private readonly timeoutMs: number) {}

  get steering(): { chatKey: string; submit: (prompt: string, metadata?: string) => boolean } | undefined {
    const active = this.active;
    if (!active || active.controller.signal.aborted || !active.session?.steer) return;
    return { chatKey: active.chatKey, submit: active.session.steer.bind(active.session) };
  }

  async answer(chatKey: string, prompt: string, publish?: (update: AgentUpdate) => void, metadata?: string): Promise<string> {
    if (this.stopped) throw new UserError('桥接服务正在停止。');
    if (this.active) throw new Error('会话执行器只接受串行任务。');
    const controller = new AbortController();
    const active: NonNullable<ConversationRunner['active']> = { chatKey, controller };
    this.active = active;
    const timer = setTimeout(() => controller.abort(new UserError(
      '本次任务等待超时，结果可能尚未确认。系统不会自动重跑；请先确认任务状态。',
    )), this.timeoutMs);
    try {
      const savedId = this.mapping.sessionId(chatKey);
      const session = await this.host.openSession(savedId, controller.signal);
      controller.signal.throwIfAborted();
      if (!savedId) this.mapping.bind(chatKey, session.id);
      active.session = session;
      let publishedText = false;
      const result = await session.run(prompt, controller.signal, publish && ((update) => {
        publish(update);
        if (update.kind === 'text') publishedText = true;
      }), metadata);
      const notes = [...result.notices ?? []];
      if (result.finishReason && result.finishReason !== 'completed') notes.push('本次任务未正常完成，请结合以上回复确认处理结果。');
      if (!publishedText) notes.unshift(result.text.trim() || '本次处理没有返回文字，请换一种方式描述问题。');
      return notes.join('\n\n');
    } catch (error) {
      if (error instanceof HostCleanupError) throw error;
      return error instanceof UserError ? error.message
        : 'Agent 处理失败，本条任务不会自动重跑。请检查宿主配置和网络，再确认任务状态。';
    } finally {
      clearTimeout(timer);
      this.active = undefined;
    }
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.active?.controller.abort(new UserError('桥接服务已停止，本条任务未能确认完成；系统不会自动重跑。'));
    await this.host.close();
  }
}
