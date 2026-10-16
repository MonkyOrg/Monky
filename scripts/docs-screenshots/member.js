import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { repoRoot } from '../qa.js';

const require = createRequire(import.meta.url);
const shared = require(path.join(repoRoot, 'packages', 'shared', 'dist', 'index.js'));
const { MessageType, PROTOCOL_VERSION } = shared;

/**
 * A demo member connected through the real protocol, like a second client
 * would be. Everything it does reaches the captured client as a normal
 * broadcast, so the screenshots never depend on rows written behind the
 * server's back.
 */
export class Member {
  constructor(url, nickname, password) {
    this.url = url;
    this.nickname = nickname;
    this.password = password;
    this.pending = new Map();
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    this.publicKey = publicKey.export({ format: 'der', type: 'spki' }).toString('hex');
    this.privateKey = privateKey;
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    const requestId = randomUUID();
    const auth = new Promise((resolve, reject) => {
      this.ws.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.type === MessageType.AUTH_CHALLENGE && message.requestId === requestId) {
          const signature = sign(null, Buffer.from(message.payload.nonce, 'hex'), this.privateKey).toString('hex');
          this.ws.send(JSON.stringify({ type: MessageType.AUTH_CHALLENGE_RESPONSE, requestId, payload: { signature } }));
        } else if (message.type === MessageType.AUTH_SUCCESS && message.requestId === requestId) {
          resolve(message.payload);
        } else if (message.type === MessageType.SERVER_ERROR && message.requestId === requestId) {
          reject(new Error(`${this.nickname}: ${message.payload?.message ?? message.payload?.code}`));
        }
        const waiting = message.requestId && this.pending.get(message.requestId);
        if (waiting && message.requestId !== requestId) {
          this.pending.delete(message.requestId);
          if (message.type === MessageType.SERVER_ERROR) waiting.reject(new Error(`${this.nickname}: ${message.payload?.code} ${message.payload?.message ?? ''}`));
          else waiting.resolve(message.payload);
        }
      });
      this.ws.addEventListener('error', () => reject(new Error(`${this.nickname}: connection failed`)));
    });
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.send(JSON.stringify({
      type: MessageType.AUTH_CONNECT, requestId,
      payload: {
        protocolVersion: PROTOCOL_VERSION, protocolOffer: shared.createProtocolOffer('client'),
        publicKey: this.publicKey, nickname: this.nickname, password: this.password,
      },
    }));
    const payload = await auth;
    this.userId = payload.currentUser.id;
    return payload;
  }

  send(type, payload) {
    this.ws.send(JSON.stringify({ type, requestId: randomUUID(), payload }));
  }

  request(type, payload, timeoutMs = 15_000) {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`${this.nickname}: ${type} timed out`));
      }, timeoutMs);
      this.pending.set(requestId, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      this.ws.send(JSON.stringify({ type, requestId, payload }));
    });
  }

  async say(channelId, content) {
    return this.request(MessageType.CHAT_SEND, { channelId, content, clientMessageId: randomUUID() });
  }

  close() {
    this.ws?.close();
  }
}
