import { loadConfig, UserError } from './config.js';
import { createBridge } from './compose.js';
import { SdkAgentHost } from './hosts/sdk.js';

const log = (message: string): void => { process.stdout.write(`[${new Date().toISOString()}] ${message}\n`); };

async function main(): Promise<void> {
  const config = loadConfig();
  const bridge = createBridge(config, new SdkAgentHost(config), log, () => { process.exitCode = 1; });
  const stop = (): void => {
    void bridge.stop().catch(() => { log('桥接资源未能正常释放，请检查运行状态。'); process.exitCode = 1; });
  };
  const fatal = (): void => { process.exitCode = 1; bridge.fail(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.on('uncaughtException', fatal);
  process.on('unhandledRejection', fatal);
  log('钉钉与 DSH 独立桥接服务正在启动。');
  await bridge.start();
}

main().catch((error: unknown) => {
  log(error instanceof UserError ? error.message : '桥接启动失败，请检查配置、依赖和数据目录。');
  process.exitCode = 1;
});
