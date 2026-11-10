import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { UserError } from './core/host.js';
export { UserError } from './core/host.js';

export interface BridgeConfig {
  clientId: string;
  clientSecret: string;
  appDir: string;
  dataDir: string;
  workspace: string;
  runTimeoutMs: number;
  secrets: readonly string[];
}

export interface SdkConfig extends BridgeConfig { apiKey: string; model: string; dshHome: string }
interface PluginOptions {
  clientId: string;
  dataDir?: string;
  workspace?: string;
  runTimeoutSeconds?: number;
  envFile?: string;
}

function environment(envFile: string): NodeJS.ProcessEnv {
  // 读取环境文件时不修改宿主环境。
  const fromFile = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
  return { ...fromFile, ...process.env };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new UserError(`请在 .env 或环境变量中填写 ${name}。`);
  return value;
}

function prepare(config: BridgeConfig): BridgeConfig {
  const { runTimeoutMs } = config;
  if (!Number.isSafeInteger(runTimeoutMs) || runTimeoutMs < 10_000 || runTimeoutMs > 3_600_000) {
    throw new UserError('单次任务的超时须在 10 至 3600 秒之间。');
  }
  for (const directory of [config.dataDir, config.workspace]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  return config;
}

export function loadConfig(): SdkConfig {
  const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const env = environment(resolve(appDir, '.env'));
  const apiKey = required(env, 'DEEPSEEK_API_KEY');
  const clientSecret = required(env, 'DINGTALK_CLIENT_SECRET');
  const dataDir = resolve(appDir, env.BRIDGE_DATA_DIR || '.data');
  const base = prepare({
    clientId: required(env, 'DINGTALK_CLIENT_ID'), clientSecret, appDir, dataDir,
    workspace: env.DSH_WORKSPACE ? resolve(appDir, env.DSH_WORKSPACE) : resolve(dataDir, 'workspace'),
    runTimeoutMs: Number(env.DSH_RUN_TIMEOUT_MS || 300_000),
    secrets: [clientSecret, apiKey],
  });
  const dshHome = resolve(base.dataDir, 'dsh');
  mkdirSync(dshHome, { recursive: true, mode: 0o700 });
  return { ...base, apiKey, model: env.DSH_MODEL?.trim() || 'deepseek-flash', dshHome };
}

export function loadPluginConfig(options: PluginOptions, storedSecret: string | undefined, dshHome: string): BridgeConfig {
  // 兼容已安装的旧版配置和它的会话映射。
  const legacyFile = options.envFile && isAbsolute(options.envFile) ? options.envFile : '';
  const legacyEnv = legacyFile ? environment(legacyFile) : {};
  const appDir = legacyFile ? dirname(legacyFile) : dshHome;
  let clientId = options.clientId.trim();
  let clientSecret = storedSecret?.trim() ?? '';
  if (!clientId && !clientSecret && legacyFile) {
    clientId = legacyEnv.DINGTALK_CLIENT_ID?.trim() ?? '';
    clientSecret = legacyEnv.DINGTALK_CLIENT_SECRET?.trim() ?? '';
  }
  if (!clientId || !clientSecret) throw new UserError('请在插件详情页保存钉钉应用的 Client ID 和 Client Secret。');

  const defaultDataDir = legacyFile
    ? resolve(appDir, legacyEnv.BRIDGE_DATA_DIR || '.data', 'desktop')
    : resolve(appDir, 'dingtalk-dsh', 'desktop');
  const dataDir = options.dataDir?.trim() ? resolve(appDir, options.dataDir.trim()) : defaultDataDir;
  const workspace = options.workspace?.trim() || legacyEnv.DSH_WORKSPACE;
  return prepare({
    clientId, clientSecret, appDir, dataDir,
    workspace: workspace ? resolve(appDir, workspace) : resolve(dataDir, 'workspace'),
    runTimeoutMs: options.runTimeoutSeconds === undefined
      ? Number(legacyEnv.DSH_RUN_TIMEOUT_MS || 300_000) : options.runTimeoutSeconds * 1_000,
    secrets: [clientSecret, legacyEnv.DEEPSEEK_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? ''],
  });
}

export function childEnvironment(config: SdkConfig): NodeJS.ProcessEnv {
  const names = new Set([
    'PATH', 'PATHEXT', 'SYSTEMROOT', 'COMSPEC', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR',
    'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'LANG', 'LC_ALL', 'TZ',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  ]);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => names.has(name.toUpperCase())));
  return { ...env, DEEPSEEK_API_KEY: config.apiKey };
}
