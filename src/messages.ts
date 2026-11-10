import type { BridgeConfig } from './config.js';

export interface IncomingMessage {
  key: string;
  chatKey: string;
  webhook: string;
  expiresAt: number;
  prompt: string;
  metadata?: string;
  immediateReply?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonempty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readTextOnlyRichText(content: unknown): { text: string; metadata: Record<string, unknown> } | undefined {
  if (!record(content) || !Array.isArray(content.richText)) return;
  const { richText, ...metadata } = content;
  const fragments: string[] = [];
  const fragmentMetadata: Record<string, unknown>[] = [];
  for (const fragment of richText) {
    if (!record(fragment) || typeof fragment.text !== 'string'
      || (fragment.type !== undefined && fragment.type !== 'text')) return;
    const { text, ...details } = fragment;
    fragments.push(text);
    fragmentMetadata.push(details);
  }
  const text = nonempty(fragments.join(''));
  if (!text) return;
  if (fragmentMetadata.some((details) => Object.keys(details).length > 0)) metadata.richText = fragmentMetadata;
  return { text, metadata };
}

export function validWebhook(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'oapi.dingtalk.com'
      && url.port === '' && url.pathname === '/robot/sendBySession'
      && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

const replyRoutingFields = new Set([
  'sessionwebhook',
  'sessionwebhookexpiredtime',
  'conversationtoken',
  'conversationtokenexpiredtime',
  'conversationtokenexpiretime',
]);

export function parseMessage(
  data: string, transportId: string, clientId: string, stream?: Record<string, unknown>,
): IncomingMessage | undefined {
  const body: unknown = JSON.parse(data);
  if (!record(body)) return;
  const conversationId = nonempty(body.conversationId);
  const messageId = nonempty(body.msgId) ?? nonempty(transportId);
  const webhook = nonempty(body.sessionWebhook);
  const expiresAt = Number(body.sessionWebhookExpiredTime);
  if (!conversationId || !messageId || !webhook || !validWebhook(webhook)
    || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return;
  if (body.conversationType !== '1' && body.conversationType !== '2') return;
  if (body.conversationType === '2' && body.isInAtList !== true) return;
  if (body.senderId && body.senderId === body.chatbotUserId) return;

  const namespace = [clientId, nonempty(body.chatbotCorpId) ?? ''];
  const { text: callbackText, ...callback } = body;
  const richText = body.msgtype === 'richText' ? readTextOnlyRichText(body.content) : undefined;
  const text = richText?.text ?? (record(callbackText) ? nonempty(callbackText.content) : undefined);
  let immediateReply: string | undefined;
  if (body.msgtype !== 'text' && !richText) immediateReply = '当前 MVP 只支持文字消息，请用文字描述你的问题。';
  else if (!text) return;
  else if (Buffer.byteLength(text, 'utf8') > 32_000) immediateReply = '这条文字过长，请拆成几条消息发送。';

  let metadata: string | undefined;
  if (!immediateReply) {
    if (record(callbackText)) {
      const { content, ...textMetadata } = callbackText;
      if (Object.keys(textMetadata).length > 0) callback.text = textMetadata;
    }
    if (richText) callback.content = Object.keys(richText.metadata).length > 0 ? richText.metadata : undefined;
    metadata = JSON.stringify({
      data: callback,
      stream: stream ?? { headers: { messageId: transportId } },
    }, (key, value) => replyRoutingFields.has(key.toLowerCase()) ? undefined : value, 2);
  }

  return {
    key: JSON.stringify([...namespace, conversationId, messageId]),
    chatKey: JSON.stringify([...namespace, conversationId]),
    webhook,
    expiresAt,
    prompt: immediateReply ? '' : text ?? '',
    metadata,
    immediateReply,
  };
}

export function formatDingTalkContext(metadata: string): string {
  return `你的正文会直接发回当前钉钉聊天，请直接回答对方。\n\n钉钉消息元数据\n${metadata}`;
}

export function redactReply(text: string, config: BridgeConfig): string {
  const replacements: [string, string][] = [
    ...config.secrets.map((secret): [string, string] => [secret, '【密钥已隐藏】']),
    [config.workspace, '【工作区】'],
    [config.dataDir, '【数据目录】'],
    [config.appDir, '【程序目录】'],
    [process.env.USERPROFILE ?? process.env.HOME ?? '', '【用户目录】'],
  ];
  for (const [value, replacement] of replacements.sort((a, b) => b[0].length - a[0].length)) {
    if (!value) continue;
    for (const variant of new Set([value, value.replaceAll('\\', '/'), value.replaceAll('\\', '\\\\')])) {
      text = text.split(variant).join(replacement);
    }
  }
  return text;
}

export function splitReply(text: string): string[] {
  // 按 UTF-8 字节数分段，避免把中文和表情拆成无效字符，并给标题预留空间。
  const parts: string[] = [];
  let part = '';
  let bytes = 0;
  for (const character of text) {
    const length = Buffer.byteLength(character, 'utf8');
    if (bytes + length > 3_000) {
      parts.push(part);
      part = '';
      bytes = 0;
    }
    part += character;
    bytes += length;
  }
  if (part) parts.push(part);
  if (parts.length === 0) return ['本次处理没有返回文字，请换一种方式描述问题。'];
  return parts.length === 1 ? parts : parts.map((value, index) => `（${index + 1}/${parts.length}）\n\n${value}`);
}
