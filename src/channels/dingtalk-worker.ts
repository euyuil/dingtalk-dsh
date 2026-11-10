import { parentPort, workerData } from 'node:worker_threads';
import { DWClient, TOPIC_ROBOT } from 'dingtalk-stream';

if (!parentPort) throw new Error('机器人传输必须在独立工作线程中启动。');
const port = parentPort;
const credentials = workerData as { clientId: string; clientSecret: string };
const client = new DWClient({ ...credentials, debug: false, keepAlive: true, autoReconnect: true, subscriptions: [] });
const pending = new Map<string, (ack: boolean) => void>();
let closing = false;
let connected = false;

// 主线程持久化成功后才确认收到；await 保留 SDK 的原连接上下文。
client.registerCallbackListener(TOPIC_ROBOT, async (frame) => {
  const { data, ...stream } = frame;
  const ack = await new Promise<boolean>((resolve) => {
    pending.set(frame.headers.messageId, resolve);
    port.postMessage({ type: 'message', id: frame.headers.messageId, data, stream });
  });
  pending.delete(frame.headers.messageId);
  if (ack && !closing) client.socketCallBackResponse(frame.headers.messageId, { response: null });
});

const statusTimer = setInterval(() => {
  if (client.connected !== connected) {
    connected = client.connected;
    port.postMessage({ type: 'status', connected });
  }
}, 1_000);

port.on('message', (message: { type: string; id?: string; ack?: boolean }) => {
  if (message.type === 'ack' && message.id) pending.get(message.id)?.(message.ack === true);
  if (message.type === 'stop' && !closing) {
    closing = true;
    clearInterval(statusTimer);
    client.disconnect();
    for (const resolve of pending.values()) resolve(false);
    port.close();
  }
});

void client.connect().then(() => {
  if (!closing) port.postMessage({ type: 'ready', connected: client.connected });
}).catch(() => { if (!closing) port.postMessage({ type: 'failed' }); });
