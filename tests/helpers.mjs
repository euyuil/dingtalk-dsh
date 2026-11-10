import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export function temporary(t) {
  const root = realpathSync(tmpdir());
  const directory = mkdtempSync(join(root, 'dingtalk-bridge-'));
  t.after(() => {
    if (dirname(directory) !== root || !basename(directory).startsWith('dingtalk-bridge-')) throw new Error('临时目录范围无效。');
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

export function incoming(key = 'one', chatKey = 'chat') {
  return { key, chatKey, prompt: `文字：${key}`, webhook: 'https://oapi.dingtalk.com/robot/sendBySession?session=example', expiresAt: Date.now() + 60_000 };
}

export function config(root = '.') {
  return { appDir: root, dataDir: root, workspace: root, clientId: 'example', clientSecret: 'placeholder', secrets: ['placeholder'], runTimeoutMs: 1_000 };
}

export function deferred() {
  return Promise.withResolvers();
}
