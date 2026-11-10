import type { IncomingMessage } from '../messages.js';

export class ReplyExpiredError extends Error {}

export interface MessageChannel {
  connect(receive: (message: IncomingMessage) => void): Promise<void>;
  send(webhook: string, expiresAt: number, text: string): Promise<void>;
  disconnect(): Promise<void>;
}

export type Logger = (message: string) => void;
