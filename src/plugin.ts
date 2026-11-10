import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/cordis-plugin-loader';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import Schema from '@deepseek-ai/schemastery';
import { loadPluginConfig, UserError } from './config.js';
import { createBridge } from './compose.js';
import type { BridgeService } from './core/service.js';
import { NativeAgentHost } from './hosts/native.js';

export const name = 'dingtalk-bridge';
export const inject = ['sessionController', 'workspaceRegistry', 'credentials'];
const secretRef = credentialRef('DINGTALK_DSH_CLIENT_SECRET');
export const Config = Schema.object({
  enabled: Schema.boolean().default(false).volatile(),
  clientId: Schema.string().default('').volatile(),
  dataDir: Schema.string().default('').volatile(),
  workspace: Schema.string().default('').volatile(),
  reportProgress: Schema.boolean().default(false).volatile(),
  runTimeoutSeconds: Schema.natural().min(10).max(3600).volatile(),
  // 旧版配置用于保留已建立的会话映射。
  envFile: Schema.string().default(''),
});

/** 插件入口只组合原生宿主，不导入 SDK 适配器，不注册进程退出处理。 */
export function apply(ctx: Context, options: ReturnType<typeof Config>): void {
  const log = (message: string): void => ctx.logger.info(message);
  let bridge: BridgeService | undefined;
  let revision = 0;
  let pending = Promise.resolve();

  async function stopBridge(): Promise<void> {
    await bridge?.stop();
    bridge = undefined;
  }

  function report(error: unknown, fallback: string): void {
    ctx.logger.error(error instanceof UserError ? error.message : fallback);
  }

  function reconcile(): void {
    const requested = ++revision;
    // 旧实例完全释放后再打开数据库。关闭时无需等 Stream 连接完成。
    pending = pending.then(async () => {
      if (requested !== revision) return;
      await stopBridge();
      if (requested !== revision || !options.enabled.get()) return;
      const secret = await ctx.credentials.resolve(secretRef);
      if (requested !== revision) return;
      const config = loadPluginConfig({
        clientId: options.clientId.get(),
        envFile: options.envFile,
        dataDir: options.dataDir.get(),
        workspace: options.workspace.get(),
        runTimeoutSeconds: options.runTimeoutSeconds.get(),
      }, secret?.value, resolveDshHome());
      const host = new NativeAgentHost(ctx, config.workspace, () => options.reportProgress.get());
      const current = bridge = createBridge(config, host, log);
      void current.start().catch((error: unknown) => {
        if (requested === revision) report(error, '钉钉桥接启动失败，请检查连接配置。');
      });
    }).catch((error: unknown) => report(error, '钉钉桥接切换失败，请检查配置与数据目录。'));
  }

  ctx.on('loader/volatile-update', (paths) => {
    if (paths.some(([field]) => field !== 'reportProgress')) reconcile();
  });
  ctx.on('credentials/reference-updated', (ref) => {
    if (ref === secretRef) reconcile();
  });
  ctx.effect(() => async () => {
    ++revision;
    await pending;
    await stopBridge();
  });
  reconcile();
}
