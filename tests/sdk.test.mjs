import test from 'node:test';
import assert from 'node:assert/strict';
import { SdkAgentHost } from '../dist/hosts/sdk.js';
import { UserError, HostCleanupError } from '../dist/core/index.js';
import { config, deferred } from './helpers.mjs';

function fixture() {
  let created = 0;
  let closed = 0;
  const resumed = [];
  const inputs = [];
  const hanging = deferred();
  const factory = () => ({
    client: { start() {}, onRequest() {} }, async start() {},
    session() { return session(`s-${++created}`); },
    async resumeSession(id) { resumed.push(id); return session(id); },
    async close() { closed++; hanging.reject(new Error('已关闭')); },
  });
  function session(id) {
    return { id, async setWorkingDirectory() {}, async run(text) {
      inputs.push(text);
      if (text === '等待') return hanging.promise;
      return { finalResponse: '回答', finishReason: 'completed' };
    } };
  }
  const host = new SdkAgentHost({ ...config(), apiKey: 'placeholder', model: 'example', dshHome: '.' }, factory);
  return { host, resumed, inputs, closed: () => closed, hanging };
}

test('SDK 创建与恢复保持原会话 ID', async () => {
  const fixtureValue = fixture();
  // 关闭时用于中断的 Promise 可能未被本条用例使用。
  fixtureValue.hanging.promise.catch(() => {});
  const { host, resumed, inputs } = fixtureValue;
  const signal = new AbortController().signal;
  const first = await host.openSession(undefined, signal);
  assert.equal((await first.run('文字', signal)).text, '回答');
  const slashText = '  /permission full-access';
  assert.equal((await first.run(slashText, signal)).text, '回答');
  const metadata = '{"data":{"senderNick":"小李"}}';
  assert.equal((await first.run(slashText, signal, undefined, metadata)).text, '回答');
  assert.deepEqual(inputs, [
    '/permission workspace-write', '文字', `请直接回复以下钉钉消息。\n${slashText}`,
    [
      { type: 'text', text: `你的正文会直接发回当前钉钉聊天，请直接回答对方。\n\n钉钉消息元数据\n${metadata}` },
      { type: 'text', text: slashText },
    ],
  ]);
  await host.openSession(first.id, signal);
  assert.deepEqual(resumed, []);
  await host.openSession('persisted', signal);
  assert.deepEqual(resumed, ['persisted']);
  await host.close();
  assert.equal(fixtureValue.closed(), 1);
});

test('SDK 取消会关闭拥有的进程，完成清理后才结束等待', async () => {
  const fixtureValue = fixture();
  const { host } = fixtureValue;
  const controller = new AbortController();
  const session = await host.openSession(undefined, controller.signal);
  const running = session.run('等待', controller.signal);
  controller.abort(new UserError('测试停止'));
  await assert.rejects(running);
  assert.equal(fixtureValue.closed(), 1);
  await host.close();
});

test('SDK 清理失败始终以宿主故障上报，且不会启动后继进程', async () => {
  let starts = 0;
  const host = new SdkAgentHost({ ...config(), apiKey: 'placeholder', model: 'example', dshHome: '.' }, () => {
    starts++;
    const session = { id: 's', async setWorkingDirectory() {}, async run(text) {
      if (text === '等待') return new Promise(() => {});
      return { finalResponse: '', finishReason: 'completed' };
    } };
    return { client: { start() {}, onRequest() {} }, async start() {}, session: () => session, async close() { throw new Error('关闭失败'); } };
  });
  const controller = new AbortController();
  const session = await host.openSession(undefined, controller.signal);
  const running = session.run('等待', controller.signal);
  controller.abort(new UserError('停止'));
  await assert.rejects(running, HostCleanupError);
  await assert.rejects(host.openSession(undefined, new AbortController().signal), HostCleanupError);
  assert.equal(starts, 1);
  await assert.rejects(host.close(), HostCleanupError);
});
