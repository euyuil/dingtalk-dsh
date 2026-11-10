import { copyFileSync, rmSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'dist');
// 仅清理本程序的固定构建目录，避免旧入口残留在插件包中。
if (!output.startsWith(root + sep) || output === root) throw new Error('构建目录无效。');
rmSync(output, { recursive: true, force: true });
const result = spawnSync(process.execPath, [resolve(root, 'node_modules/typescript/lib/tsc.js'), '-p', 'tsconfig.json'], {
  cwd: root, stdio: 'inherit', windowsHide: true,
});
process.exitCode = result.status ?? 1;
if (process.exitCode === 0) copyFileSync(resolve(root, 'src/client.js'), resolve(output, 'client.js'));
