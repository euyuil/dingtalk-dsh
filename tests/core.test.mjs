import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationRunner, UserError, HostCleanupError, BridgeService, ReplyExpiredError } from '../dist/core/index.js';
import { Store } from '../dist/store.js';
import { config, incoming, deferred } from './helpers.mjs';

test('共享执行器按聊天复用映射，恢复失败保留原绑定', async () => {
  const store = new Store(':memory:', 'example-host');
  let created = 0;
  const opened = [];
  const host = {
    kind: 'example-host',
    async openSession(id) {
      opened.push(id);
      return { id: id ?? `session-${++created}`, async run() { return { text: '回答', finishReason: 'completed' }; } };
    },
    async close() {},
  };
  store.receive(incoming());
  store.receive(incoming('two', 'other'));
  const runner = new ConversationRunner(host, store, 1_000);
  assert.equal(await runner.answer('chat', '第一问'), '回答');
  assert.equal(await runner.answer('chat', '第二问'), '回答');
  await runner.answer('other', '另一聊天');
  assert.deepEqual(opened, [undefined, 'session-1', undefined]);
  assert.notEqual(store.sessionId('chat'), store.sessionId('other'));
  host.openSession = async () => { throw new UserError('历史不可读'); };
  assert.equal(await runner.answer('chat', '再问'), '历史不可读');
  assert.equal(store.sessionId('chat'), 'session-1');
  await runner.close();
  store.close();
});

test('宿主清理失败传给上层，不当作普通业务回复', async () => {
  const host = { kind: 'example', async openSession() { throw new HostCleanupError('清理失败'); }, async close() {} };
  const runner = new ConversationRunner(host, { sessionId() {}, bind() {} }, 1_000);
  await assert.rejects(runner.answer('chat', '文字'), HostCleanupError);
  await runner.close();
});

test('串行队列、消息去重和发送重试共享同一份已保存结果', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const store = new Store(':memory:', 'example-host');
  let runs = 0;
  let sends = 0;
  let receive;
  const host = {
    kind: 'example-host',
    async openSession(id) { return { id: id ?? 'session-one', async run() { runs++; return { text: '保存的回答' }; } }; },
    async close() {},
  };
  const channel = {
    async connect(handler) { receive = handler; },
    async send(_url, _expiry, text) { sends++; assert.equal(text, '保存的回答'); if (sends === 1) throw new Error('发送失败'); },
    async disconnect() {},
  };
  const service = new BridgeService(config(), store, new ConversationRunner(host, store, 1_000), channel, () => {});
  await service.start();
  t.after(() => service.stop());
  receive(incoming());
  receive(incoming());
  await Promise.all([service.processOne(), service.processOne()]);
  await service.processOne();
  assert.equal(runs, 1);
  await service.deliverOne();
  now += 10_000;
  await service.deliverOne();
  assert.equal(sends, 2);
  assert.equal(runs, 1);
});

test('过期回复在新消息刷新地址后补发，不重新执行 Agent', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const store = new Store(':memory:', 'example-host');
  let receive;
  let sends = 0;
  let runs = 0;
  const host = {
    kind: 'example-host',
    async openSession() { return { id: 's', async run() { runs++; return { text: '原回答' }; } }; }, async close() {},
  };
  const channel = {
    async connect(handler) { receive = handler; },
    async send() { if (++sends === 1) throw new ReplyExpiredError(); }, async disconnect() {},
  };
  const service = new BridgeService(config(), store, new ConversationRunner(host, store, 1_000), channel, () => {});
  await service.start();
  t.after(() => service.stop());
  receive(incoming());
  await service.processOne();
  await service.deliverOne();
  assert.equal(store.nextDelivery(), undefined);
  now += 4_000;
  receive(incoming('new'));
  await service.deliverOne();
  assert.equal(sends, 2);
  assert.equal(runs, 1);
});

test('进行中即可送达正文，同聊天补充合入当前活动，结束只追加异常提示', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const store = new Store(':memory:', 'dsh-native');
  const began = deferred();
  const finish = deferred();
  const firstSend = deferred();
  let receive;
  let publish;
  let runs = 0;
  let accepting = true;
  const steers = [];
  const sent = [];
  const firstMetadata = '{"data":{"senderNick":"小李"}}';
  const supplementMetadata = '{"data":{"senderNick":"小王"}}';
  const host = {
    kind: 'dsh-native',
    async openSession(id) {
      return {
        id: id ?? 's',
        async run(_prompt, _signal, sendUpdate, metadata) {
          assert.equal(metadata, firstMetadata);
          runs++;
          publish = sendUpdate;
          publish({ kind: 'text', text: '第一段' });
          began.resolve();
          await finish.promise;
          return { text: '第二段', finishReason: 'error' };
        },
        steer(prompt, metadata) {
          if (!accepting) return false;
          steers.push([prompt, metadata]);
          publish({ kind: 'text', text: '第二段' });
          return true;
        },
      };
    },
    async close() {},
  };
  const service = new BridgeService(config(), store, new ConversationRunner(host, store, 30_000), {
    async connect(handler) { receive = handler; },
    async send(_url, _expiry, text) {
      sent.push(text);
      if (sent.length === 1) await firstSend.promise;
    },
    async disconnect() {},
  }, () => {});
  await service.start();
  t.after(() => { firstSend.resolve(); finish.resolve(); return service.stop(); });
  receive({ ...incoming('first'), metadata: firstMetadata });
  const work = service.processOne();
  await began.promise;
  assert.deepEqual(sent, ['第一段']);
  receive(incoming('unrelated', 'other'));
  receive({ ...incoming('supplement'), metadata: supplementMetadata });
  receive(incoming('supplement'));
  assert.deepEqual(steers, [['文字：supplement', supplementMetadata]]);
  assert.equal(runs, 1);
  accepting = false;
  receive(incoming('late'));
  finish.resolve();
  await work;
  firstSend.resolve();
  await service.deliverOne();
  for (let i = 0; i < 3; i++) {
    now += 4_000;
    await service.deliverOne();
  }
  assert.deepEqual(sent, ['第一段', '第二段', '本次任务未正常完成，请结合以上回复确认处理结果。']);
  assert.equal(store.nextTask('chat')?.prompt, '文字：late');
  assert.equal(store.nextTask('chat'), undefined);
  assert.equal(store.nextTask()?.chat_key, 'other');
});

test('停止桥接会取消当前任务并等待资源释放', async (t) => {
  const started = deferred();
  const host = {
    kind: 'example', closed: false,
    async openSession() { return { id: 's', run(_prompt, signal) { started.resolve(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } }; },
    async close() { this.closed = true; },
  };
  const store = new Store(':memory:', host.kind);
  store.receive(incoming());
  const service = new BridgeService(config(), store, new ConversationRunner(host, store, 1_000), {
    async connect() {}, async send() {}, async disconnect() {},
  }, () => {});
  t.after(() => service.stop());
  const running = service.processOne();
  await started.promise;
  await service.stop();
  await running;
  assert.equal(host.closed, true);
});
