import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeAgentHost } from '../dist/hosts/native.js';
import { UserError } from '../dist/core/index.js';
import { parseMessage } from '../dist/messages.js';
import { deferred } from './helpers.mjs';

function fixture(mode = 'normal', reportProgress = () => false) {
  const agents = new Map();
  const attached = [];
  const calls = { create: 0, resume: 0, cancel: 0, dispose: 0, prompts: [], steers: [], submitted: [], removed: [] };
  const waits = new Map();
  const listeners = new Set();
  const preSteps = new Set();
  let lastAgent;
  function make(id) {
    const events = [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '旧回复' }] } } }];
    const inbox = {
      nextTurn: [],
      nextStep: [],
      remove(messageId) {
        calls.removed.push(messageId);
        const index = this.nextStep.findIndex((message) => message.id === messageId);
        if (index >= 0) this.nextStep.splice(index, 1);
        return index >= 0;
      },
    };
    function emit(type, data) {
      const event = { type, data };
      events.push(event);
      for (const listener of listeners) listener(agent.session, event);
    }
    function answer(text) {
      emit('assistant/message', { message: { content: [{ type: 'text', text }] } });
    }
    function finish(text = '本次回复', reason = 'completed') {
      answer(text);
      emit('turn/end', { reason: { kind: reason } });
      agent.status = 'idle';
      waits.get(id)?.resolve();
    }
    const agent = {
      status: 'idle', session: { id, snapshotEvents: () => events.slice() }, inbox, emit, answer, finish,
      ctx: { on(name, listener) {
        assert.equal(name, 'agent/pre-step');
        preSteps.add(listener);
        return () => preSteps.delete(listener);
      } },
      followup(message) {
        agent.status = 'running';
        waits.set(id, deferred());
        const guiInput = { id: 'gui-input', source: { kind: 'user' } };
        calls.prompts.push(message.content[0].text);
        calls.submitted.push(message);
        emit('user/message', message);
        if (mode.startsWith('runtime-context')) {
          for (const kind of ['runtime-context', 'agent-instructions', 'skill-catalog', 'time-context']) {
            emit('user/message', { id: kind, source: { kind } });
          }
        }
        if (mode === 'mixed' || mode === 'mixed-wait') {
          emit('user/message', guiInput);
        }
        if (!mode.endsWith('-wait')) queueMicrotask(() => finish());
      },
      steer(message) {
        calls.steers.push(message.content[0].text);
        calls.submitted.push(message);
        if (!waits.has(id)) waits.set(id, deferred());
        if (mode === 'pending-wait') inbox.nextStep.push(message);
        else emit('user/message', message);
        if (!mode.endsWith('-wait')) queueMicrotask(() => finish());
      },
      whenIdle() { return agent.status === 'idle' ? Promise.resolve() : waits.get(id).promise; },
      cancel(_cause, options) {
        calls.cancel++;
        assert.equal(options.keepInbox, true);
        agent.status = 'idle';
        waits.get(id)?.resolve();
      },
    };
    agents.set(id, agent);
    lastAgent = agent;
    return { agent, async dispose() { calls.dispose++; agents.delete(id); } };
  }
  const ctx = {
    sessionController: {
      async create({ workspaceId }) {
        assert.equal(workspaceId, 'desktop-workspace');
        const sessionId = `desktop-session-${++calls.create}`;
        make(sessionId);
        attached.push(sessionId);
        return { sessionId };
      },
      async resolveAgent(id) {
        if (agents.has(id)) return { agent: agents.get(id) };
        calls.resume++;
        if (mode === 'missing') return { error: new Error('会话不存在。') };
        return make(id);
      },
    },
    workspaceRegistry: {
      async create() {
        return { id: 'desktop-workspace', async attachSession(id) { attached.push(id); } };
      },
    },
    on(name, listener) {
      assert.equal(name, 'session/event');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { host: new NativeAgentHost(ctx, '.', reportProgress), agents, attached, calls, listeners, preSteps, last: () => lastAgent };
}

test('通过桌面会话服务创建并登记会话；关闭适配器保留桌面 Agent', async () => {
  const { host, agents, attached, calls } = fixture();
  const signal = new AbortController().signal;
  const session = await host.openSession(undefined, signal);
  assert.deepEqual(await session.run('文字', signal), { text: '本次回复', finishReason: 'completed', notices: undefined });
  await host.openSession(session.id, signal);
  assert.equal(calls.create, 1);
  assert.equal(calls.resume, 0);
  assert.ok(attached.includes(session.id));
  await host.close();
  assert.equal(agents.size, 1);
  assert.equal(calls.dispose, 0);
});

test('插件恢复已有映射，不另外创建空白会话', async () => {
  const { host, calls } = fixture();
  const signal = new AbortController().signal;
  const session = await host.openSession('stored-native-session', signal);
  assert.equal(session.id, 'stored-native-session');
  assert.equal(calls.resume, 1);
  assert.equal(calls.create, 0);
  await host.close();
});

test('桌面会话服务恢复失败时保留原绑定', async () => {
  const { host, calls, attached } = fixture('missing');
  await assert.rejects(host.openSession('stored-native-session', new AbortController().signal), /原绑定已保留/);
  assert.equal(calls.create, 0);
  assert.deepEqual(attached, []);
  await host.close();
});

test('原样提交钉钉文字，宿主自动附加运行上下文时仍能返回模型答复', async () => {
  const { host, calls } = fixture('runtime-context');
  const signal = new AbortController().signal;
  const session = await host.openSession(undefined, signal);
  const text = '你好\n有空吗？ ';
  const message = parseMessage(JSON.stringify({
    conversationId: 'chat', msgId: 'incoming', conversationType: '1',
    senderNick: '发言者', senderId: 'example-sender', msgtype: 'text', text: { content: text },
    sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession?session=example',
    sessionWebhookExpiredTime: Date.now() + 60_000,
  }), 'transport', 'example');
  assert.ok(message);
  assert.deepEqual(await session.run(message.prompt, signal), { text: '本次回复', finishReason: 'completed', notices: undefined });
  assert.deepEqual(calls.prompts, [text]);
  await host.close();
});

test('钉钉元数据与对应正文进入同一步骤，普通桌面输入保持原样', async () => {
  const { host, last, calls, preSteps } = fixture('runtime-context-wait');
  const signal = new AbortController().signal;
  const session = await host.openSession(undefined, signal);
  const rawText = ' 今天进度怎么样？\n';
  const stream = { specVersion: '1.0', headers: { messageId: 'push-id', time: '123' } };
  const data = {
    conversationId: 'group', conversationType: '2', conversationTitle: '项目群',
    msgId: 'incoming', senderNick: '小李', msgtype: 'text', isInAtList: true, createAt: 123,
    extension: { flag: true, sessionWebhook: 'nested-reply-address', conversationTokenExpireTime: 456 },
    text: {
      content: rawText,
      repliedMsg: { content: { text: '上条消息' }, conversationToken: 'reply-token', conversationTokenExpiredTime: 456 },
    },
    sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession?session=example',
    sessionWebhookExpiredTime: Date.now() + 60_000,
  };
  const message = parseMessage(JSON.stringify(data), 'push-id', 'example', stream);
  assert.equal(message.prompt, rawText);
  assert.equal(message.webhook, data.sessionWebhook);
  assert.equal(message.expiresAt, data.sessionWebhookExpiredTime);
  assert.deepEqual(JSON.parse(message.metadata), {
    data: {
      conversationId: 'group', conversationType: '2', conversationTitle: '项目群',
      msgId: 'incoming', senderNick: '小李', msgtype: 'text', isInAtList: true, createAt: 123,
      extension: { flag: true },
      text: { repliedMsg: { content: { text: '上条消息' } } },
    },
    stream,
  });

  const running = session.run(message.prompt, signal, undefined, message.metadata);
  const supplement = JSON.stringify({ data: { senderNick: '小王' } });
  assert.equal(session.steer('补充内容', supplement), true);
  const [first, second] = calls.submitted;
  const gui = { id: 'desktop-only', source: { kind: 'user' } };
  const [hook] = preSteps;
  const decision = await hook({ agent: last() }, async () => ({
    kind: 'enter', startsRequestSeries: true, messages: [gui, first, second],
  }));
  assert.equal(decision.startsRequestSeries, true);
  assert.equal(decision.messages[0], gui);
  assert.equal(decision.messages[2], first);
  assert.equal(decision.messages[4], second);
  assert.equal(first.content[0].text, rawText);
  assert.equal(second.content[0].text, '补充内容');
  assert.equal(first.source.dingtalkMetadata, message.metadata);
  assert.equal(decision.messages[1].source.kind, 'dingtalk-metadata');
  const contextPrefix = '你的正文会直接发回当前钉钉聊天，请直接回答对方。\n\n钉钉消息元数据\n';
  assert.equal(decision.messages[1].content[0].text, `${contextPrefix}${message.metadata}`);
  assert.equal(decision.messages[3].content[0].text, `${contextPrefix}${supplement}`);
  last().finish();
  await running;
  assert.equal(preSteps.size, 0);
  await host.close();
});

test('同一活动里桌面补充输入后仍返回 Agent 的回答', async () => {
  const { host } = fixture('mixed');
  const signal = new AbortController().signal;
  const session = await host.openSession(undefined, signal);
  assert.equal((await session.run('文字', signal)).text, '本次回复');
  await host.close();
});

test('正文成稿即发布，进度可以在活动中开关，活动结束解除监听', async () => {
  let report = false;
  const { host, last, listeners } = fixture('runtime-context-wait', () => report);
  const signal = new AbortController().signal;
  const session = await host.openSession(undefined, signal);
  const updates = [];
  const result = session.run('第一问', signal, (update) => updates.push(update));
  last().answer('第一段');
  assert.deepEqual(updates, [{ kind: 'text', text: '第一段' }]);
  assert.equal(last().status, 'running');
  assert.equal(session.steer('补充条件'), true);
  report = true;
  const todos = [{ status: 'completed' }, { status: 'in_progress' }];
  last().emit('todo/write', { todos });
  last().emit('todo/write', { todos });
  last().finish('第二段', 'error');
  assert.equal((await result).finishReason, 'error');
  assert.deepEqual(updates.slice(1), [{ kind: 'progress', text: '进度 · 已完成 1/2 项。' }, { kind: 'text', text: '第二段' }]);
  assert.equal(session.steer('太晚的补充'), false);
  assert.equal(listeners.size, 0);
  await host.close();
});

test('GUI 已在处理时第一条钉钉消息也走 steer', async () => {
  const { host, last, calls } = fixture();
  const signal = new AbortController().signal;
  const session = await host.openSession(undefined, signal);
  last().status = 'running';
  assert.equal((await session.run('文字', signal)).text, '本次回复');
  assert.deepEqual(calls.steers, ['文字']);
  assert.deepEqual(calls.prompts, []);
  assert.equal(calls.cancel, 0);
  await host.close();
});

test('插件取消时忽略自动上下文，只停止本次任务并保留 GUI Agent', async () => {
  const { host, agents, calls } = fixture('runtime-context-wait');
  const controller = new AbortController();
  const session = await host.openSession(undefined, controller.signal);
  const running = session.run('文字', controller.signal);
  controller.abort(new UserError('停止等待'));
  await assert.rejects(running, /停止等待/);
  await host.close();
  assert.equal(calls.cancel, 1);
  assert.equal(calls.dispose, 0);
  assert.equal(agents.size, 1);
});

test('GUI 已参与输入时取消等待不取消桌面任务', async () => {
  const { host, calls } = fixture('mixed-wait');
  const controller = new AbortController();
  const session = await host.openSession(undefined, controller.signal);
  const running = session.run('文字', controller.signal);
  controller.abort(new UserError('停止等待'));
  await assert.rejects(running, /停止等待/);
  assert.equal(calls.cancel, 0);
  await host.close();
});

test('超时取消桥接任务时只移除本活动尚未入场的补充消息', async () => {
  const { host, last, calls } = fixture('pending-wait');
  const controller = new AbortController();
  const session = await host.openSession(undefined, controller.signal);
  const running = session.run('第一问', controller.signal);
  assert.equal(session.steer('补充'), true);
  assert.equal(last().inbox.nextStep.length, 1);
  controller.abort(new UserError('等待超时'));
  await assert.rejects(running, /等待超时/);
  assert.equal(last().inbox.nextStep.length, 0);
  assert.equal(calls.removed.length, 1);
  assert.equal(calls.cancel, 1);
  await host.close();
});
