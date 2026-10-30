import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { LIMITS, ProtocolErrorCode, type DmRelayItem } from '@monky/shared';
import { RelayPacer } from '../src/renderer/core/dmRelayPacer';

const FRIEND = 'a'.repeat(64);
/** A file chunk of 96 KiB costs about this much after the inner and outer base64. */
const CHUNK_CHARS = 175_000;

function item(kind: DmRelayItem['kind'], label: string, size = 400): DmRelayItem {
  return { to: FRIEND, kind, data: label.padEnd(size, '.') };
}

/** The two token buckets the server keeps per connection (DmRelayService), fed with what reaches it and when. */
class ServerBuckets {
  private items: number = LIMITS.DM_RELAY_RATE_ITEMS_BURST;
  private chars: number = LIMITS.DM_RELAY_RATE_BYTES_BURST;

  constructor(private at: number) {}

  consume(items: DmRelayItem[], now: number): boolean {
    const elapsed = (now - this.at) / 1000;
    this.at = now;
    this.items = Math.min(LIMITS.DM_RELAY_RATE_ITEMS_BURST, this.items + elapsed * LIMITS.DM_RELAY_RATE_ITEMS_PER_SECOND);
    this.chars = Math.min(LIMITS.DM_RELAY_RATE_BYTES_BURST, this.chars + elapsed * LIMITS.DM_RELAY_RATE_BYTES_PER_SECOND);
    const chars = items.reduce((sum, entry) => sum + entry.data.length, 0);
    if (this.items < items.length || this.chars < chars) return false;
    this.items -= items.length;
    this.chars -= chars;
    return true;
  }
}

interface Sent {
  relayId: string;
  items: DmRelayItem[];
  at: number;
}

function setup(context: TestContext) {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const sent: Sent[] = [];
  const dropped: string[] = [];
  const pacer = new RelayPacer({
    send: (relayId, items) => {
      sent.push({ relayId, items, at: Date.now() });
      return true;
    },
    onDropped: (code) => dropped.push(code),
  });
  const run = (ms: number, step = 20) => {
    for (let elapsed = 0; elapsed < ms; elapsed += step) context.mock.timers.tick(step);
  };
  const labels = () => sent.flatMap((batch) => batch.items.map((entry) => entry.data.replace(/\.+$/, '')));
  return { pacer, sent, dropped, run, labels };
}

test('a large file never trips the server rate limit, and still goes at the rate the server allows', (context) => {
  const { pacer, sent, run, labels } = setup(context);
  const started = Date.now();
  const server = new ServerBuckets(started);
  const chunks = Array.from({ length: 120 }, (_, index) => item('file', `chunk-${index}`, CHUNK_CHARS));
  pacer.enqueue(chunks);
  run(30_000);

  assert.equal(pacer.queued, 0);
  assert.deepEqual(labels(), chunks.map((_, index) => `chunk-${index}`), 'Every chunk went out once, in order');
  for (const batch of sent) {
    assert.ok(server.consume(batch.items, batch.at), `Batch sent at +${batch.at - started} ms was within the server buckets`);
    assert.ok(batch.items.length <= LIMITS.DM_RELAY_MAX_ITEMS);
    assert.ok(batch.items.reduce((sum, entry) => sum + entry.data.length, 0) <= LIMITS.DM_RELAY_TOTAL_DATA_MAX_LENGTH);
  }
  const total = chunks.length * CHUNK_CHARS;
  const fastest = (total - LIMITS.DM_RELAY_RATE_BYTES_BURST) / LIMITS.DM_RELAY_RATE_BYTES_PER_SECOND * 1000;
  const duration = sent.at(-1)!.at - started;
  assert.ok(duration >= fastest && duration <= fastest + 4_000, `Paced, not stalled: ${duration} ms for ${fastest} ms at the limit`);
});

test('conversation items go ahead of file chunks already waiting', (context) => {
  const { pacer, run, labels } = setup(context);
  pacer.enqueue(Array.from({ length: 60 }, (_, index) => item('file', `chunk-${index}`, CHUNK_CHARS)));
  const sentBefore = labels().length;
  assert.ok(sentBefore < 60, 'The burst cannot take every chunk at once');
  pacer.enqueue([item('signal', 'msg'), item('signal', 'ack')]);
  run(1_000);
  const order = labels();
  const message = order.indexOf('msg');
  assert.ok(message >= sentBefore && message <= sentBefore + 1, `The message left right away, at ${message} of ${order.length}`);
  assert.equal(order[message + 1], 'ack');
  run(10_000);
  assert.equal(labels().filter((label) => label.startsWith('chunk-')).length, 60);
});

test('a batch the server refuses for the rate goes back in line in its order; other refusals are dropped', (context) => {
  const { pacer, sent, dropped, run, labels } = setup(context);
  pacer.enqueue([item('signal', 'a'), item('signal', 'b')]);
  pacer.enqueue([item('signal', 'c')]);
  assert.equal(sent.length, 2);
  // The estimate here ran ahead of the server's: both batches come back refused, in the order they left.
  assert.equal(pacer.refused(sent[0].relayId, ProtocolErrorCode.RATE_LIMITED), true);
  assert.equal(pacer.refused(sent[1].relayId, ProtocolErrorCode.RATE_LIMITED), true);
  assert.equal(sent.length, 2, 'Nothing goes out again before the buckets refill');
  run(500);
  assert.deepEqual(labels(), ['a', 'b', 'c', 'a', 'b', 'c']);

  pacer.enqueue([item('signal', 'd')]);
  const last = sent.at(-1)!;
  pacer.accepted(sent.at(-2)!.relayId);
  assert.equal(pacer.refused(last.relayId, ProtocolErrorCode.DM_RELAY_DISABLED), true);
  run(2_000);
  assert.equal(labels().filter((label) => label === 'd').length, 1, 'A refusal for any other reason is not sent again');
  assert.deepEqual(dropped, [ProtocolErrorCode.DM_RELAY_DISABLED]);
  assert.equal(pacer.refused('someone-else', ProtocolErrorCode.RATE_LIMITED), false, 'Errors of other requests are left alone');
});

test('a connection that goes away drops what waited for it and starts the next one with full buckets', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  let connected = true;
  const sent: string[] = [];
  const pacer = new RelayPacer({
    send: (_relayId, items) => {
      if (!connected) return false;
      sent.push(...items.map((entry) => entry.data.replace(/\.+$/, '')));
      return true;
    },
  });
  pacer.enqueue(Array.from({ length: 40 }, (_, index) => item('file', `old-${index}`, CHUNK_CHARS)));
  assert.ok(pacer.queued > 0);
  connected = false;
  context.mock.timers.tick(2_000);
  assert.equal(pacer.queued, 0, 'Chunks for a closed connection are dropped; the receiver asks for them again');
  connected = true;
  pacer.reset();
  pacer.enqueue(Array.from({ length: 20 }, (_, index) => item('file', `new-${index}`, CHUNK_CHARS)));
  assert.equal(sent.filter((label) => label.startsWith('new-')).length, 20, 'A fresh connection has the whole burst');
});
