import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import type { SessionId, UserMessage } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-tool-todo';
import type {} from '@deepseek-ai/dsh-workspace';
import { HostCleanupError, UserError, interruptible } from '../core/host.js';
import type { AgentHost, AgentReply, AgentSession, AgentUpdate } from '../core/host.js';
import { formatDingTalkContext } from '../messages.js';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dingtalk-metadata': { kind: 'dingtalk-metadata'; form: 'notice'; summary: string };
  }
}

interface Activity {
  agent: Agent;
  signal: AbortSignal;
  inputs: Set<UserMessage['id']>;
}

function desktopInput(message: UserMessage, inputs: ReadonlySet<UserMessage['id']>): boolean {
  return !inputs.has(message.id)
    && (message.source.kind === 'user' || message.source.kind === 'user-question-reply');
}

function submit(activity: Activity, prompt: string, steer: boolean, metadata?: string): void {
  const message: UserMessage = {
    id: `message-${randomUUID()}` as UserMessage['id'], role: 'user',
    source: { kind: 'user', ...(metadata ? { dingtalkMetadata: metadata } : {}) },
    content: [{ type: 'text', text: prompt }],
  };
  activity.inputs.add(message.id);
  if (steer) activity.agent.steer(message);
  else activity.agent.followup(message);
}

/** 借用 GUI 的宿主服务，不创建 SDK 进程，不拥有整个宿主。 */
export class NativeAgentHost implements AgentHost {
  readonly kind = 'dsh-native';
  private stopped = false;
  private activity?: Activity;

  constructor(
    private readonly ctx: Context,
    private readonly workspace: string,
    private readonly reportProgress: () => boolean = () => false,
  ) {}

  async openSession(id: string | undefined, signal: AbortSignal): Promise<AgentSession> {
    return interruptible(() => this.openNativeSession(id, signal), signal, async () => undefined);
  }

  private async openNativeSession(id: string | undefined, signal: AbortSignal): Promise<AgentSession> {
    signal.throwIfAborted();
    if (this.stopped) throw new UserError('桌面桥接插件正在停止。');
    const { sessionController, workspaceRegistry } = this.ctx;
    let key = id as SessionId | undefined;
    // 由桌面会话服务负责加载默认预设和恢复已有预设。
    if (!key) {
      const workspace = await workspaceRegistry.create(this.workspace, '钉钉对话');
      signal.throwIfAborted();
      key = (await sessionController.create({ workspaceId: workspace.id })).sessionId;
    }
    signal.throwIfAborted();
    const resolved = await sessionController.resolveAgent(key);
    signal.throwIfAborted();
    if ('error' in resolved) {
      throw new UserError(id
        ? '桌面历史会话恢复失败，原绑定已保留。请检查桌面版本和历史数据。'
        : '桌面会话启动失败，请检查 DSH 的智能体预设。');
    }
    if (id) {
      const workspace = await workspaceRegistry.create(this.workspace, '钉钉对话');
      signal.throwIfAborted();
      await workspace.attachSession(key);
    }
    const target = resolved.agent;
    return {
      id: key,
      run: (prompt, runSignal, publish, metadata) => this.run(target, prompt, runSignal, publish, metadata),
      steer: (prompt, metadata) => this.steer(target, prompt, metadata),
    };
  }

  private steer(agent: Agent, prompt: string, metadata?: string): boolean {
    const activity = this.activity;
    if (this.stopped || !activity || activity.agent !== agent || activity.signal.aborted || agent.status !== 'running') return false;
    submit(activity, prompt, true, metadata);
    return true;
  }

  private async run(
    agent: Agent, prompt: string, signal: AbortSignal, publish?: (update: AgentUpdate) => void, metadata?: string,
  ): Promise<AgentReply> {
    signal.throwIfAborted();
    if (this.stopped) throw new UserError('桌面桥接插件正在停止。');
    if (this.activity) throw new Error('桌面桥接已有活动。');
    const activity: Activity = { agent, signal, inputs: new Set() };
    const entered = new Set<UserMessage['id']>();
    let shared = agent.status === 'running';
    let text = '';
    let finishReason: string | undefined;
    let lastProgress = '';
    const progress = (message: string): void => {
      if (!this.reportProgress() || message === lastProgress) return;
      lastProgress = message;
      publish?.({ kind: 'progress', text: message });
    };
    const off = this.ctx.on('session/event', (session, event) => {
      if (session !== agent.session || signal.aborted) return;
      if (event.type === 'user/message') {
        if (activity.inputs.has(event.data.id)) entered.add(event.data.id);
        else if (desktopInput(event.data, activity.inputs)) shared = true;
      }
      if (entered.size === 0) return;
      if (event.type === 'assistant/message' && !event.data.interrupted) {
        const body = event.data.message.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
        if (body.trim()) {
          text = body;
          publish?.({ kind: 'text', text: body });
        }
      }
      if (event.type === 'turn/end') finishReason = event.data.reason.kind;
      if (event.type === 'todo/write' && event.data.todos.length > 0) {
        const completed = event.data.todos.filter((todo) => todo.status === 'completed').length;
        progress(`进度 · 已完成 ${completed}/${event.data.todos.length} 项。`);
      }
    }, { global: true });
    this.activity = activity;
    function removePending(): void {
      try {
        for (const id of activity.inputs) if (!entered.has(id)) agent.inbox.remove(id);
      } catch {
        throw new HostCleanupError('桌面宿主未能撤回待处理的钉钉输入。');
      }
    }
    let offMetadata: (() => void) | undefined;
    try {
      // 正文进入 DSH 的步骤时才插入对应上下文，避免等待中的补充消息与其他输入错配。
      offMetadata = agent.ctx.on('agent/pre-step', async ({ agent: target }, next) => {
        const decision = await next();
        if (target !== agent || decision.kind !== 'enter') return decision;
        const messages = decision.messages.flatMap((message) => {
          const { source } = message;
          if (!activity.inputs.has(message.id) || !('dingtalkMetadata' in source)
            || typeof source.dingtalkMetadata !== 'string') return [message];
          const context: UserMessage = {
            id: `${message.id}-dingtalk-metadata` as UserMessage['id'],
            role: 'user',
            source: { kind: 'dingtalk-metadata', form: 'notice', summary: '钉钉消息元数据' },
            content: [{ type: 'text', text: formatDingTalkContext(source.dingtalkMetadata) }],
          };
          return [context, message];
        });
        return { ...decision, messages };
      });
      return await interruptible(async () => {
        const joining = agent.status === 'running';
        progress(joining ? '已加入当前处理。' : '正在处理你的消息。');
        signal.throwIfAborted();
        submit(activity, prompt, joining, metadata);
        await agent.whenIdle();
        if (entered.size === 0) throw new UserError('桌面宿主未确认处理本条消息，请查看桌面会话。');
        const notices = entered.size < activity.inputs.size ? ['有补充消息未进入本次处理，请查看桌面会话。'] : undefined;
        return { text, finishReason, notices };
      }, signal, async () => {
        removePending();
        const pending = [...agent.inbox.nextTurn, ...agent.inbox.nextStep];
        // 超时仍取消桥接启动的活动。桌面用户参与的工作由桌面继续管理。
        if (shared || agent.status !== 'running' || pending.some((message) => desktopInput(message, activity.inputs))) return;
        agent.cancel({ kind: 'hook', reason: '钉钉桥接任务停止等待' }, { keepInbox: true });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            agent.whenIdle(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new HostCleanupError('桌面会话未能确认停止，桥接已停止。')), 15_000);
            }),
          ]);
        } finally { if (timer) clearTimeout(timer); }
      });
    } finally {
      this.activity = undefined;
      offMetadata?.();
      off();
      if (!signal.aborted) removePending();
    }
  }

  async close(): Promise<void> {
    this.stopped = true;
    // 会话和 Agent 留给 GUI 管理，不 dispose Agent，也不关闭桌面 Host。
  }
}
