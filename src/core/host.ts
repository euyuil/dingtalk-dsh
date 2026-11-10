/** 宿主接口不包含 DSH、钉钉或数据库类型，入口只组合一个实现。 */
export interface AgentReply {
  text: string;
  finishReason?: string | null;
  notices?: readonly string[];
}

export interface AgentUpdate {
  kind: 'text' | 'progress';
  text: string;
}

export interface AgentSession {
  readonly id: string;
  run(prompt: string, signal: AbortSignal, publish?: (update: AgentUpdate) => void, metadata?: string): Promise<AgentReply>;
  /** 活动仍可接收补充输入时提交；返回 false 表示原消息可留在桥接队列。 */
  steer?(prompt: string, metadata?: string): boolean;
}

export interface AgentHost {
  readonly kind: string;
  /** 未提供 ID 时新建；提供 ID 时恢复或复用，恢复失败不得静默新建。 */
  openSession(id: string | undefined, signal: AbortSignal): Promise<AgentSession>;
  /** 只关闭适配器拥有的资源，不能关闭外部 GUI 宿主。 */
  close(): Promise<void>;
}

export class UserError extends Error {}
/** 清理结果不明时停止桥接实例，避免继续执行下一条任务。 */
export class HostCleanupError extends Error {}

export async function interruptible<T>(
  operation: () => Promise<T>, signal: AbortSignal, interrupt: () => Promise<void>,
): Promise<T> {
  signal.throwIfAborted();
  let cleanup: Promise<void> | undefined;
  let abort!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => {
      cleanup = Promise.resolve().then(interrupt);
      void cleanup.then(() => reject(signal.reason), () => reject(new HostCleanupError('宿主任务清理失败。')));
    };
  });
  signal.addEventListener('abort', abort, { once: true });
  try {
    const result = await Promise.race([operation(), interrupted]);
    if (signal.aborted) throw signal.reason;
    return result;
  } finally {
    signal.removeEventListener('abort', abort);
    if (cleanup) {
      try { await cleanup; } catch { throw new HostCleanupError('宿主任务清理失败。'); }
    }
  }
}
