import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';
import type { DeepSeekHarnessOptions, HarnessSession } from '@deepseek-ai/dsh-sdk-client';
import { childEnvironment } from '../config.js';
import type { SdkConfig } from '../config.js';
import { HostCleanupError, UserError, interruptible } from '../core/host.js';
import type { AgentHost, AgentReply, AgentSession } from '../core/host.js';
import { formatDingTalkContext } from '../messages.js';

type HarnessFactory = (options: DeepSeekHarnessOptions) => DeepSeekHarness;

/** 独立模式拥有 SDK 子进程，可以在超时或关闭时终止它。 */
export class SdkAgentHost implements AgentHost {
  readonly kind = 'dsh-sdk';
  private harness?: DeepSeekHarness;
  private readonly sessions = new Map<string, HarnessSession>();
  private disposal?: Promise<void>;
  private stopped = false;
  private approvalDenied = false;
  private questionCancelled = false;

  constructor(private readonly config: SdkConfig, private readonly factory: HarnessFactory = (options) => new DeepSeekHarness(options)) {}

  private async runtime(): Promise<DeepSeekHarness> {
    await this.disposal;
    if (this.stopped) throw new UserError('独立宿主正在停止。');
    if (this.harness) return this.harness;
    const harness = this.factory({
      profile: 'sdk', dshHome: this.config.dshHome,
      cwd: this.config.workspace, processCwd: this.config.workspace,
      env: childEnvironment(this.config), provider: 'deepseek-official', model: this.config.model,
      approvalRequests: true, initializeTimeoutMs: 60_000,
      onUserQuestion: async () => { this.questionCancelled = true; return { cancelled: true }; },
    });
    this.harness = harness;
    harness.client.start();
    harness.client.onRequest(async (method) => {
      if (method !== 'approval/request') throw new Error('不支持的交互请求。');
      this.approvalDenied = true;
      return { outcome: 'rejected' };
    });
    try { await harness.start(); } catch {
      throw new UserError('DSH 初始化失败，请检查 API 配置、模型名称和运行依赖。本条消息未提交给模型。');
    }
    return harness;
  }

  private async guarded<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    try { return await interruptible(operation, signal, () => this.reset()); } catch (error) {
      await this.reset();
      throw error;
    }
  }

  async openSession(id: string | undefined, signal: AbortSignal): Promise<AgentSession> {
    return this.guarded(async () => {
      const harness = await this.runtime();
      let session = id ? this.sessions.get(id) : undefined;
      if (!session) {
        if (id) {
          try { session = await harness.resumeSession(id); } catch {
            throw new UserError('历史会话无法恢复，请检查原数据目录和会话占用情况。本条消息未提交，原绑定已保留。');
          }
        } else {
          session = harness.session();
          await session.setWorkingDirectory(this.config.workspace);
        }
        const permission = await session.run('/permission workspace-write');
        if (permission.finishReason === 'error') throw new UserError('固定工作区权限配置失败，本条消息未提交。');
        this.sessions.set(session.id, session);
      }
      const target = session;
      return { id: target.id, run: (prompt, runSignal, _publish, metadata) => this.run(target, prompt, runSignal, metadata) };
    }, signal);
  }

  private async run(session: HarnessSession, prompt: string, signal: AbortSignal, metadata?: string): Promise<AgentReply> {
    this.approvalDenied = false;
    this.questionCancelled = false;
    return this.guarded(async () => {
      // SDK 会把以斜杠开头的文本路由给本机命令，钉钉消息只作为对话输入。
      const text = prompt.trimStart().startsWith('/') ? `请直接回复以下钉钉消息。\n${prompt}` : prompt;
      const input = metadata ? [
        { type: 'text' as const, text: formatDingTalkContext(metadata) },
        { type: 'text' as const, text: prompt },
      ] : text;
      const result = await session.run(input);
      const notices: string[] = [];
      if (this.approvalDenied) notices.push('本次有操作需要额外工具授权；独立模式已拒绝该授权。');
      if (this.questionCancelled) notices.push('独立模式暂不支持交互提问，请在下一条消息中直接补充要求。');
      return { text: result.finalResponse, finishReason: result.finishReason, notices };
    }, signal);
  }

  private async reset(): Promise<void> {
    if (this.harness) {
      const harness = this.harness;
      this.harness = undefined;
      this.sessions.clear();
      this.disposal = Promise.resolve().then(() => harness.close());
    }
    const disposal = this.disposal;
    if (!disposal) return;
    try { await disposal; } catch { throw new HostCleanupError('DSH 子进程未能确认退出。'); }
    if (this.disposal === disposal) this.disposal = undefined;
  }

  async close(): Promise<void> { this.stopped = true; await this.reset(); }
}
