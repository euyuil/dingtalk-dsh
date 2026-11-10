import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { Store } from '../dist/store.js';
import { loadPluginConfig } from '../dist/config.js';
import { temporary, incoming } from './helpers.mjs';

test('CLI 旧映射可继续使用；插件必须使用新数据库', (t) => {
  const file = join(temporary(t), 'bridge.sqlite');
  const original = new Store(file);
  original.receive(incoming());
  original.bind('chat', 'original-session');
  original.close();
  const legacy = new DatabaseSync(file);
  legacy.exec('DROP TABLE bridge_owner');
  legacy.close();
  assert.throws(() => new Store(file, 'dsh-native'), /另一种运行模式/);
  const restored = new Store(file, 'dsh-sdk');
  assert.equal(restored.sessionId('chat'), 'original-session');
  restored.close();
  const desktop = new Store(join(temporary(t), 'bridge.sqlite'), 'dsh-native');
  assert.equal(desktop.sessionId('chat'), undefined);
  desktop.close();
});

test('中断恢复保留回复提示而不重新执行任务', (t) => {
  const file = join(temporary(t), 'bridge.sqlite');
  const first = new Store(file);
  first.receive(incoming());
  assert.ok(first.nextTask());
  first.close();
  const second = new Store(file);
  assert.equal(second.nextTask(), undefined);
  assert.match(second.nextDelivery().reply_parts, /没有自动重跑/);
  second.close();
});

test('桌面升级保留旧会话映射，重新打开后可以读取已入队的元数据', (t) => {
  const file = join(temporary(t), 'bridge.sqlite');
  const original = new Store(file, 'dsh-native');
  original.receive(incoming('old'));
  original.bind('chat', 'original-session');
  original.close();
  const legacy = new DatabaseSync(file);
  legacy.exec('ALTER TABLE messages DROP COLUMN metadata');
  legacy.close();

  const upgraded = new Store(file, 'dsh-native');
  assert.equal(upgraded.sessionId('chat'), 'original-session');
  const old = upgraded.nextTask();
  assert.equal(old.prompt, '文字：old');
  assert.equal(old.metadata, null);
  upgraded.complete(old.id, []);
  const metadata = '{"data":{"senderNick":"小李"}}';
  upgraded.receive({ ...incoming('new'), metadata });
  upgraded.close();

  const resumed = new Store(file, 'dsh-native');
  assert.equal(resumed.nextTask().metadata, metadata);
  resumed.close();
});

test('活动中回复地址过期仍可续写，恢复只补发未送达正文和一条中断提示', (t) => {
  const file = join(temporary(t), 'bridge.sqlite');
  const store = new Store(file, 'dsh-native');
  const first = incoming('first');
  store.receive(first);
  const { id } = store.nextTask();
  store.appendReply(id, ['已送达', '待补发']);
  store.deliveredPart(id, 1);
  store.expire(id, first.expiresAt);
  assert.equal(store.nextDelivery(), undefined);
  store.appendReply(id, ['继续生成的正文']);
  store.receive({ ...incoming('supplement'), expiresAt: first.expiresAt + 60_000 });
  assert.ok(store.nextTask('chat'));
  store.close();
  const resumed = new Store(file, 'dsh-native');
  assert.equal(resumed.nextTask(), undefined);
  const pending = resumed.nextDelivery();
  assert.equal(pending.id, id);
  const parts = JSON.parse(pending.reply_parts);
  assert.deepEqual(parts.slice(pending.next_part, -1), ['待补发', '继续生成的正文']);
  assert.match(parts.at(-1), /没有自动重跑/);
  resumed.deliveredPart(id, parts.length);
  assert.equal(resumed.nextDelivery(), undefined);
  resumed.close();
});

test('插件配置直接使用钉钉凭证，并默认在 DSH 数据目录中创建独立映射', (t) => {
  const root = temporary(t);
  const options = loadPluginConfig({ clientId: ' example ', runTimeoutSeconds: 10 }, ' placeholder ', root);
  assert.equal(options.clientId, 'example');
  assert.equal(options.clientSecret, 'placeholder');
  assert.equal(options.dataDir, join(root, 'dingtalk-dsh', 'desktop'));
  assert.equal(options.workspace, join(options.dataDir, 'workspace'));
  assert.equal(options.runTimeoutMs, 10_000);
  assert.equal('apiKey' in options, false);
  assert.throws(() => loadPluginConfig({ clientId: 'example' }, undefined, root), /Client Secret/);
});

test('旧版配置保留默认映射位置，保存 GUI 凭证后优先使用新凭证', (t) => {
  const root = temporary(t);
  const file = join(root, 'example.env');
  const marker = 'DINGTALK_BRIDGE_CONFIG_TEST_MARKER';
  const before = process.env[marker];
  writeFileSync(file, `DINGTALK_CLIENT_ID=example\nDINGTALK_CLIENT_SECRET=placeholder\n${marker}=example\n`);
  const previous = loadPluginConfig({ clientId: '', envFile: file }, undefined, root);
  const updated = loadPluginConfig({ clientId: 'updated-id', envFile: file }, 'updated-secret', root);
  assert.equal(previous.dataDir, join(root, '.data', 'desktop'));
  assert.equal(updated.dataDir, previous.dataDir);
  assert.equal(updated.workspace, previous.workspace);
  assert.equal(updated.clientId, 'updated-id');
  assert.equal(updated.clientSecret, 'updated-secret');
  assert.equal(process.env[marker], before);
});
