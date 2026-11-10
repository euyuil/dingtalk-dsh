import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { apply, Config } from '../dist/plugin.js';
import { deferred, temporary } from './helpers.mjs';

test('普通钉钉消息的来源标签可展开原始元数据', () => {
  const slots = new Map();
  const code = readFileSync(new URL('../dist/client.js', import.meta.url), 'utf8');
  runInNewContext(code, { window: { __ModuleLoader__: { load({ factory }) {
    const client = factory((name) => name === 'react'
      ? { createElement: (type, props, ...children) => ({ type, props, children }) }
      : {
        SettingsFormModel: class { bind() {} actions() {} },
        settingsNumberField: () => ({}),
        settingsTextField: () => ({}),
      });
    client.apply({
      configForms: { get() {} },
      effect(register) { register(); },
      slots: {
        inject(_name, register) { register(); },
        register(options, component) { slots.set(options.name, { ...options, component }); },
      },
    });
  } } } });
  const { select, component } = slots.get('conversation.chat.user.before');
  const dingtalkMetadata = '{"data":{"conversationType":"2","conversationTitle":"项目群","senderNick":"小李"}}';
  const source = { kind: 'user', dingtalkMetadata };
  assert.equal(select({ kind: 'user', source: { kind: 'user' } }), null);
  assert.equal(select({ kind: 'steering', source }), null);
  const details = component({ matched: select({ kind: 'user', source }) });
  assert.equal(details.type, 'details');
  assert.equal(details.children[0].type, 'summary');
  assert.equal(details.children[0].children[0], '钉钉群聊 · 项目群 · 小李');
  assert.equal(details.children[1].children[0], dingtalkMetadata);
});

test('停用的插件没有环境、信号和 console 副作用', async () => {
  const info = console.info;
  const sigint = process.listenerCount('SIGINT');
  const sigterm = process.listenerCount('SIGTERM');
  let dispose;
  apply({ on() {}, effect(register) { dispose = register(); } }, Config({}));
  await dispose();
  assert.equal(console.info, info);
  assert.equal(process.listenerCount('SIGINT'), sigint);
  assert.equal(process.listenerCount('SIGTERM'), sigterm);
});

test('配置更新可关闭尚未连上的桥接，并在释放资源后重新启用', async (t) => {
  const root = temporary(t);
  const pluginUrl = new URL('../dist/plugin.js?test-switch', import.meta.url);
  const bridgeModule = `data:text/javascript,${encodeURIComponent(
    'export const bridges = []; export function createBridge() { return bridges.shift(); }',
  )}`;
  const hook = registerHooks({
    resolve(specifier, context, next) {
      return context.parentURL === pluginUrl.href && specifier === './compose.js'
        ? next(bridgeModule, context) : next(specifier, context);
    },
  });
  let plugin;
  try {
    plugin = await import(pluginUrl);
  } finally {
    hook.deregister();
  }
  const { bridges } = await import(bridgeModule);
  const calls = [];
  const connecting = deferred();
  const stopping = deferred();
  const errors = [];
  bridges.push(
    { start() { calls.push('连接中'); return connecting.promise; }, stop() { calls.push('正在停止'); return stopping.promise; } },
    { async start() { calls.push('重新启用'); }, async stop() { calls.push('卸载'); } },
  );
  let enabled = false;
  let update;
  let dispose;
  plugin.apply({
    on(event, callback) {
      if (event === 'loader/volatile-update') update = callback;
    },
    effect(register) { dispose = register(); },
    logger: { error(message) { errors.push(message); } },
    credentials: { async resolve(ref) {
      assert.equal(ref, 'DINGTALK_DSH_CLIENT_SECRET');
      return { value: 'placeholder' };
    } },
  }, {
    ...Config({ clientId: 'example', dataDir: root }),
    enabled: { get: () => enabled },
  });

  const settle = () => new Promise((resolve) => setImmediate(resolve));
  await settle();
  assert.deepEqual(calls, []);
  enabled = true;
  update([['enabled']]);
  await settle();
  update([['reportProgress']]);
  await settle();
  assert.deepEqual(calls, ['连接中']);
  enabled = false;
  update([['enabled']]);
  await settle();
  enabled = true;
  update([['enabled']]);
  await settle();
  assert.deepEqual(calls, ['连接中', '正在停止']);
  stopping.resolve();
  connecting.reject(new Error('旧连接已取消。'));
  await settle();
  assert.deepEqual(calls, ['连接中', '正在停止', '重新启用']);
  await dispose();
  assert.deepEqual(calls, ['连接中', '正在停止', '重新启用', '卸载']);
  assert.deepEqual(errors, []);
});

test('插件入口可以在禁止加载 SDK 客户端的环境中导入', () => {
  const script = `import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      if (specifier === '@deepseek-ai/dsh-sdk-client') throw new Error('插件不应加载 SDK');
      return next(specifier, context);
    }});
    await import('./dist/plugin.js');`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', windowsHide: true,
  });
  assert.equal(result.status, 0, '插件导入失败或错误加载了 SDK');
});
