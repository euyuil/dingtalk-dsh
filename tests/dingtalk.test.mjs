import assert from 'node:assert/strict';
import test from 'node:test';
import { DingTalk } from '../dist/dingtalk.js';
import { parseMessage } from '../dist/messages.js';
import { config, incoming } from './helpers.mjs';

test('仅包含文字的富文本保留片段顺序、空格和换行', () => {
  const { webhook, expiresAt } = incoming();
  const data = {
    conversationId: 'chat', conversationType: '1', msgId: 'incoming', senderNick: '小李', msgtype: 'richText',
    sessionWebhook: webhook, sessionWebhookExpiredTime: expiresAt,
    content: { richText: [{ text: '1. ' }, { type: 'text', text: '请确认第一项。' }, { text: '\n2. 请确认第二项。' }] },
  };
  const message = parseMessage(JSON.stringify(data), 'push-id', 'example');
  assert.equal(message.prompt, '1. 请确认第一项。\n2. 请确认第二项。');
  assert.equal(message.immediateReply, undefined);
  assert.deepEqual(JSON.parse(message.metadata).data, {
    conversationId: 'chat', conversationType: '1', msgId: 'incoming', senderNick: '小李', msgtype: 'richText',
    content: { richText: [{}, { type: 'text' }, {}] },
  });
});

test('包含图片的富文本直接提示，超长文字富文本也受长度限制', () => {
  const { webhook, expiresAt } = incoming();
  const data = {
    conversationId: 'chat', conversationType: '1', msgId: 'incoming', msgtype: 'richText',
    sessionWebhook: webhook, sessionWebhookExpiredTime: expiresAt,
  };
  const cases = [
    [[{ text: '请看图。' }, { type: 'picture', downloadCode: 'example' }], '当前 MVP 只支持文字消息，请用文字描述你的问题。'],
    [[{ text: '文'.repeat(10_667) }], '这条文字过长，请拆成几条消息发送。'],
  ];
  for (const [richText, expected] of cases) {
    const message = parseMessage(JSON.stringify({ ...data, content: { richText } }), 'push-id', 'example');
    assert.equal(message.immediateReply, expected);
    assert.equal(message.prompt, '');
    assert.equal(message.metadata, undefined);
  }
});

test('钉钉按正文选择消息格式和标题，并保留原文', async (t) => {
  const { webhook, expiresAt } = incoming();
  const payloads = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === 'https://api.dingtalk.com/v1.0/oauth2/accessToken') {
      return Response.json({ accessToken: 'test-token', expireIn: 3600 });
    }
    assert.equal(url, webhook);
    payloads.push(JSON.parse(options.body));
    return Response.json({ errcode: 0 });
  });

  const channel = new DingTalk(config(), () => undefined, () => undefined);
  const plain = ['你好', '第一段\n\n第二段', '链接 https://example.com', '星号 \\*\\*原样\\*\\*'];
  const formatted = [
    ['请看 **第二项**\n明天继续', '请看 第二项'],
    ['下面是今天的汇报。\n\n## 处理**进度**\n\n- 已完成', '下面是今天的汇报。'],
    ['## 处理进度\n\n- 已完成', '处理进度'],
    ['### 处理细节\n\n## 进度\n\n- 已完成', '已完成'],
    ['![](https://example.com/image.png)\n\n今天已完成复核。', '今天已完成复核。'],
    ['# 项目**进度**\n\n今天已完成复核。', '项目进度'],
    ['```text\n示例\n```', '代码示例'],
    ['[查看详情](https://example.com)', '查看详情'],
    ['| 项目 | 状态 |\n| --- | --- |\n| 测试 | 完成 |', '项目'],
    [`# ${'工'.repeat(45)}`, `${'工'.repeat(39)}…`],
  ];
  for (const text of plain) await channel.send(webhook, expiresAt, text);
  for (const [text] of formatted) await channel.send(webhook, expiresAt, text);

  assert.deepEqual(payloads, [
    ...plain.map((content) => ({ msgtype: 'text', text: { content } })),
    ...formatted.map(([text, title]) => ({ msgtype: 'markdown', markdown: { title, text } })),
  ]);
});
