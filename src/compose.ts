import { resolve } from 'node:path';
import type { BridgeConfig } from './config.js';
import { UserError } from './core/host.js';
import type { AgentHost } from './core/host.js';
import type { Logger } from './core/channel.js';
import { ConversationRunner } from './core/runner.js';
import { BridgeService } from './core/service.js';
import { DingTalk } from './dingtalk.js';
import { Store } from './store.js';

/** 每个入口注入一个宿主；同一实例没有模式切换或多宿主注册表。 */
export function createBridge(config: BridgeConfig, host: AgentHost, log: Logger, onFailure?: () => void): BridgeService {
  let store: Store;
  try { store = new Store(resolve(config.dataDir, 'bridge.sqlite'), host.kind); } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError('数据目录无法使用，请检查权限，并确认没有另一个桥接实例正在运行。');
  }
  let bridge: BridgeService;
  const channel = new DingTalk(config, log, () => bridge.fail());
  bridge = new BridgeService(config, store, new ConversationRunner(host, store, config.runTimeoutMs), channel, log, onFailure);
  return bridge;
}
