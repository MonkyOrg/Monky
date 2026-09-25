import assert from 'node:assert/strict';
import { test } from 'node:test';
import WebSocket from 'ws';
import type { types as SfuTypes } from 'mediasoup';
import { MessageType, ProtocolErrorCode, nativeScreenSignalSchema,
  type RtcTransportPurpose, type ScreenWatchSignalPayload } from '@monky/shared';
import { SignalingService } from './application/services/SignalingService';
import type { ChannelRecord } from './domain/entities';
import { SfuManager, SfuProducerClosedError } from './infrastructure/sfu/SfuManager';
import { WebSocketServer } from './infrastructure/websocket/WebSocketServer';

function gate() {
  let release = () => {};
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

function sfuFixture() {
  const manager = new SfuManager();
  const created: Array<{ id: string; producerId: string; sessionId: string; initiallyPaused: boolean;
    paused: boolean; closed: boolean; resumes: number }> = [];
  const produced: Array<{ id: string; closed: boolean; paused: boolean; resumes: number }> = [];
  let beforeCreate: () => Promise<void> = async () => {};
  let beforeResume: () => Promise<void> = async () => {};
  let sequence = 0;
  const router: Partial<SfuTypes.Router> = { canConsume: () => true };
  manager['getOrCreateRouter'] = async () => router as SfuTypes.Router;
  for (const [producerId, mediaType, kind, shareId] of [
    ['video-one', 'screen_video', 'video', 'one'],
    ['video-two', 'screen_video', 'video', 'two'],
    ['system-audio', 'screen_audio', 'audio', 'default'],
    ['mic', 'mic', 'audio', undefined],
    ['camera', 'camera', 'video', undefined],
  ] as const) {
    const producer: Partial<SfuTypes.Producer> = { id: producerId, closed: false, close() {} };
    manager['producers'].set(producerId, {
      producer: producer as SfuTypes.Producer, transportId: 'send-publisher', sessionId: 'publisher', channelId: 'room', kind,
      appData: { mediaType, ...(shareId ? { shareId } : {}) },
    });
  }
  const addReceiver = (sessionId: string, purpose: RtcTransportPurpose = 'call') => {
    const id = `recv-${sessionId}${purpose === 'screen' ? '-screen' : ''}`;
    let transportClosed = false;
    const transport: Partial<SfuTypes.WebRtcTransport> = {
      id, get closed() { return transportClosed; },
      close() { transportClosed = true; },
      async consume<AppData extends SfuTypes.AppData>(options: SfuTypes.ConsumerOptions<AppData>) {
        const state = {
          id: `consumer-${++sequence}`, producerId: options.producerId, sessionId,
          initiallyPaused: options.paused ?? false, paused: options.paused ?? false, closed: false, resumes: 0,
        };
        created.push(state);
        await beforeCreate();
        const consumer: Partial<SfuTypes.Consumer<AppData>> = {
          id: state.id, kind: manager['producers'].get(options.producerId)?.kind ?? 'video',
          rtpParameters: { codecs: [] }, get closed() { return state.closed; }, get paused() { return state.paused; },
          close() { state.closed = true; },
          async pause() { state.paused = true; },
          async resume() {
            await beforeResume();
            if (!state.closed) { state.paused = false; state.resumes++; }
          },
        };
        Object.defineProperty(consumer, 'on', { value() {} });
        return consumer as SfuTypes.Consumer<AppData>;
      },
    };
    manager['transports'].set(id, { transport: transport as SfuTypes.WebRtcTransport, sessionId, channelId: 'room', direction: 'recv', purpose });
    return id;
  };
  const addSender = (sessionId: string, purpose: RtcTransportPurpose = 'call', screenSessionId?: string) => {
    const id = `send-${sessionId}${purpose === 'screen' ? '-screen' : ''}${screenSessionId ? `-${screenSessionId}` : ''}`;
    let closed = false;
    const owned: Array<{ close(): void }> = [];
    const transport: Partial<SfuTypes.WebRtcTransport> = {
      id, get closed() { return closed; },
      close() { closed = true; for (const producer of owned) producer.close(); },
      async produce<AppData extends SfuTypes.AppData>(options: SfuTypes.ProducerOptions<AppData>) {
        const state = { id: `producer-${++sequence}`, closed: false, paused: false, resumes: 0 };
        produced.push(state);
        const producer: Partial<SfuTypes.Producer<AppData>> = {
          id: state.id, kind: options.kind, get closed() { return state.closed; },
          close() { state.closed = true; },
          async pause() { state.paused = true; },
          async resume() {
            await beforeResume();
            if (!state.closed) { state.paused = false; state.resumes++; }
          },
        };
        Object.defineProperty(producer, 'on', { value() {} });
        owned.push({ close: () => { state.closed = true; } });
        await beforeCreate();
        return producer as SfuTypes.Producer<AppData>;
      },
    };
    manager['transports'].set(id, { transport: transport as SfuTypes.WebRtcTransport, sessionId, channelId: 'room',
      direction: 'send', purpose, screenSessionId });
    return id;
  };
  for (const sessionId of ['viewer-a', 'viewer-b']) addReceiver(sessionId);
  return {
    manager, created, produced, addReceiver, addSender,
    consume: (producerId: string, sessionId = 'viewer-a') => manager.consume(sessionId, 'room', `recv-${sessionId}`, producerId, {}),
    delayCreate: (callback: () => Promise<void>) => { beforeCreate = callback; },
    delayResume: (callback: () => Promise<void>) => { beforeResume = callback; },
  };
}

function transportCreationFixture(manager = new SfuManager()) {
  const created: Array<{ id: string; closed: boolean }> = [];
  let beforeRouter: () => Promise<void> = async () => {};
  let beforeTransport: () => Promise<void> = async () => {};
  const router: Partial<SfuTypes.Router> = {
    async createWebRtcTransport<AppData extends SfuTypes.AppData>() {
      const state = { id: `transport-${created.length + 1}`, closed: false };
      created.push(state);
      const transport: Partial<SfuTypes.WebRtcTransport<AppData>> = {
        id: state.id, get closed() { return state.closed; }, close() { state.closed = true; },
        iceState: 'new', dtlsState: 'new',
        iceParameters: { usernameFragment: 'fixture', password: 'fixture' },
        iceCandidates: [], dtlsParameters: { role: 'auto', fingerprints: [] },
      };
      Object.defineProperty(transport, 'on', { value() {} });
      await beforeTransport();
      return transport as SfuTypes.WebRtcTransport<AppData>;
    },
  };
  manager['getOrCreateRouter'] = async () => {
    await beforeRouter();
    return router as SfuTypes.Router;
  };
  manager['getListenInfos'] = () => [{ protocol: 'udp', ip: '127.0.0.1' }];
  return {
    manager, created,
    delayRouter: (callback: () => Promise<void>) => { beforeRouter = callback; },
    delayTransport: (callback: () => Promise<void>) => { beforeTransport = callback; },
  };
}

test('screen SFU server creates screen consumers paused and leaves ordinary mic/camera delivery unchanged', async () => {
  const f = sfuFixture();
  for (const producerId of ['video-one', 'video-two', 'system-audio', 'mic', 'camera']) await f.consume(producerId);
  assert.deepEqual(f.created.map(consumer => [consumer.producerId, consumer.initiallyPaused]), [
    ['video-one', true], ['video-two', true], ['system-audio', true], ['mic', false], ['camera', false],
  ]);
  assert.equal(f.created.every(consumer => consumer.resumes === 0), true, 'setup itself never resumes screen RTP');
  f.manager.close();
});

test('native screen renditions keep independent SFU transports and replacement does not close voice or other profiles', async () => {
  const f = transportCreationFixture();
  const one = '1a016276-cf3d-4912-ad38-80da2a3a677b';
  const two = 'ecae84bc-572a-4c77-9376-af757a51696c';
  const call = await f.manager.createWebRtcTransport('publisher', 'room', 'send');
  const original = await f.manager.createWebRtcTransport('publisher', 'room', 'send', undefined, 'screen', one);
  const reduced = await f.manager.createWebRtcTransport('publisher', 'room', 'send', undefined, 'screen', two);
  f.manager.closeTransportsFor('publisher', 'room', 'send', 'screen', one);
  assert.equal(f.manager['transports'].has(original.id), false);
  assert.equal(f.manager['transports'].has(reduced.id), true);
  assert.equal(f.manager['transports'].has(call.id), true);
  assert.deepEqual(f.created.map(value => value.closed), [false, true, false]);
  f.manager.close();
});

test('cancelling a pending SFU rendition does not cancel another engine allocation', async () => {
  const f = transportCreationFixture();
  const pending = gate();
  f.delayRouter(() => pending.promise);
  const one = '6259de03-3456-4195-ae6a-3b2b9e9bc21c';
  const two = '8430405f-3ebc-4788-ad12-1b4e8926d591';
  const original = f.manager.createWebRtcTransport('publisher', 'room', 'send', undefined, 'screen', one);
  const reduced = f.manager.createWebRtcTransport('publisher', 'room', 'send', undefined, 'screen', two);
  f.manager.closeTransportsFor('publisher', 'room', 'send', 'screen', one);
  pending.release();
  await assert.rejects(original, /cancelled/);
  const current = await reduced;
  assert.equal(f.manager['transports'].get(current.id)?.screenSessionId, two);
  assert.equal(f.created.length, 1);
  assert.equal(f.created[0].closed, false);
  f.manager.close();
});

test('screen SFU server only lets the receiving session resume/close its own consumer, never the publisher or another viewer', async () => {
  const f = sfuFixture();
  const one = await f.consume('video-one');
  const two = await f.consume('video-one', 'viewer-b');
  const audio = await f.consume('system-audio');
  await f.manager.setConsumerPaused('viewer-b', 'room', one.id, false);
  await f.manager.setConsumerPaused('viewer-a', 'elsewhere', one.id, false);
  assert.equal(f.created[0].paused, true);
  assert.equal(f.manager.closeConsumer('viewer-b', 'room', one.id), false);
  await f.manager.setConsumerPaused('viewer-a', 'room', one.id, false);
  assert.equal(f.created[0].resumes, 1);
  assert.equal(f.manager.closeConsumer('viewer-a', 'room', one.id), true);
  assert.equal(f.created[0].closed, true);
  assert.equal(f.manager['consumers'].has(two.id), true);
  assert.equal(f.manager['consumers'].has(audio.id), true);
  assert.equal(f.manager['producers'].has('video-one'), true);
  await f.manager.setConsumerPaused('viewer-a', 'room', one.id, false);
  assert.equal(f.created[0].resumes, 1, 'late resume cannot revive a closed consumer');
  f.manager.close();
});

test('screen SFU server rejects cross-session/cross-channel transports, self-consumption and excessive consumers before worker I/O', async () => {
  const f = sfuFixture();
  await assert.rejects(f.manager.consume('viewer-b', 'room', 'recv-viewer-a', 'video-one', {}));
  await assert.rejects(f.manager.consume('viewer-a', 'elsewhere', 'recv-viewer-a', 'video-one', {}));
  f.manager['producers'].get('video-one')!.channelId = 'private-room';
  await assert.rejects(f.consume('video-one'));
  f.manager['producers'].get('video-one')!.channelId = 'room';
  f.manager['producers'].get('video-one')!.sessionId = 'viewer-a';
  await assert.rejects(f.consume('video-one'));
  f.manager['producers'].get('video-one')!.sessionId = 'publisher';
  assert.equal(f.created.length, 0);
  for (let i = 0; i < 16; i++) await f.consume('video-one');
  await assert.rejects(f.consume('video-one'), /Too many consumers/);
  assert.equal(f.created.length, 16);
  f.manager.close();
});

test('screen SFU worker completions after transport/source removal are closed and never registered or resumed', async () => {
  for (const removed of ['transport', 'producer'] as const) {
    const f = sfuFixture();
    const created = gate(), pending = gate();
    f.delayCreate(async () => { created.release(); await pending.promise; });
    const consuming = f.consume('video-one');
    await created.promise;
    if (removed === 'transport') f.manager.closeTransportsFor('viewer-a', 'room', 'recv');
    else f.manager.closeProducer('video-one');
    pending.release();
    await assert.rejects(consuming, removed === 'producer' ? SfuProducerClosedError : /closed during setup/);
    assert.equal(f.created[0].closed, true);
    assert.equal(f.created[0].resumes, 0);
    assert.equal(f.manager['consumers'].size, 0);
    f.manager.close();
  }
});

test('screen SFU a delayed resume cannot reopen a consumer closed by Stop while the worker responds', async () => {
  const f = sfuFixture();
  const consumer = await f.consume('video-one');
  const pending = gate();
  f.delayResume(() => pending.promise);
  const resuming = f.manager.setConsumerPaused('viewer-a', 'room', consumer.id, false);
  f.manager.closeConsumer('viewer-a', 'room', consumer.id);
  pending.release();
  await resuming;
  assert.equal(f.created[0].closed, true);
  assert.equal(f.created[0].resumes, 0);
  f.manager.close();
});

for (const purpose of ['call', 'screen'] as const) {
  test(`native SFU replacing the ${purpose} sender preserves the other purpose and all receivers`, async () => {
    const f = sfuFixture();
    const call = f.addSender('publisher');
    const screen = f.addSender('publisher', 'screen');
    const other = f.addSender('other-publisher', purpose);
    for (const [id, record] of f.manager['producers']) {
      record.transportId = id === 'mic' || id === 'camera' ? call : screen;
    }
    const consumer = await f.consume(purpose === 'screen' ? 'mic' : 'video-one');
    const closed = f.manager.closeTransportsFor('publisher', 'room', 'send', purpose);
    assert.deepEqual(closed.closedProducerIds.sort(),
      purpose === 'screen' ? ['system-audio', 'video-one', 'video-two'] : ['camera', 'mic']);
    assert.equal(f.manager['transports'].has(purpose === 'screen' ? call : screen), true);
    assert.equal(f.manager['transports'].has(purpose === 'screen' ? screen : call), false);
    assert.equal(f.manager['transports'].has(other), true);
    assert.equal(f.manager['transports'].has('recv-viewer-a'), true);
    assert.equal(f.manager['consumers'].has(consumer.id), true, 'an unrelated receiving transport is not discarded');
    f.manager.close();
  });
}

test('native SFU replacing the screen receiver preserves browser consumers and other viewers', async () => {
  const f = sfuFixture();
  const screen = f.addReceiver('viewer-a', 'screen');
  const mic = await f.consume('mic');
  const camera = await f.consume('camera');
  const video = await f.manager.consume('viewer-a', 'room', screen, 'video-one', {});
  const audio = await f.manager.consume('viewer-a', 'room', screen, 'system-audio', {});
  const other = await f.consume('video-one', 'viewer-b');
  assert.equal(f.manager['consumers'].get(video.id)?.transportId, screen);
  assert.equal(f.manager['consumers'].get(mic.id)?.transportId, 'recv-viewer-a');
  assert.deepEqual(f.manager.closeTransportsFor('viewer-a', 'room', 'recv', 'screen').closedProducerIds, []);
  for (const id of [mic.id, camera.id, other.id]) assert.equal(f.manager['consumers'].has(id), true);
  for (const id of [video.id, audio.id]) assert.equal(f.manager['consumers'].has(id), false);
  assert.equal(f.manager['transports'].has('recv-viewer-a'), true);
  assert.equal(f.manager['producers'].size, 5);
  f.manager.close();
});

test('native SFU dedicated screen transports reject mic/camera before worker I/O and retain Watch gating', async () => {
  const f = sfuFixture();
  const sender = f.addSender('publisher', 'screen');
  const receiver = f.addReceiver('viewer-a', 'screen');
  for (const [mediaType, kind] of [['mic', 'audio'], ['camera', 'video']] as const) {
    await assert.rejects(f.manager.produce('publisher', 'room', sender, kind, { codecs: [] }, { mediaType }),
      /only accepts screen/u);
    await assert.rejects(f.manager.consume('viewer-a', 'room', receiver, mediaType, {}), /only receives screen/u);
  }
  assert.equal(f.produced.length, 0);
  assert.equal(f.created.length, 0);
  const producer = await f.manager.produce('publisher', 'room', sender, 'video', { codecs: [] },
    { mediaType: 'screen_video', shareId: 'one' });
  assert.equal(f.manager['producers'].get(producer.id)?.transportId, sender);
  await f.manager.consume('viewer-a', 'room', receiver, 'video-one', {});
  await f.manager.consume('viewer-a', 'room', receiver, 'system-audio', {});
  assert.equal(f.created.every(consumer => consumer.initiallyPaused && consumer.resumes === 0), true);
  f.manager.close();
});

for (const replaced of ['call', 'screen'] as const) {
  test(`native SFU pending screen production survives only replacement of the other purpose (${replaced})`, async () => {
    const f = sfuFixture();
    f.addSender('publisher');
    const screen = f.addSender('publisher', 'screen');
    const started = gate(), pending = gate();
    f.delayCreate(async () => { started.release(); await pending.promise; });
    const producing = f.manager.produce('publisher', 'room', screen, 'video', { codecs: [] },
      { mediaType: 'screen_video', shareId: 'one' });
    await started.promise;
    f.manager.closeTransportsFor('publisher', 'room', 'send', replaced);
    pending.release();
    if (replaced === 'screen') {
      await assert.rejects(producing, /closed during setup/u);
      assert.equal(f.produced[0].closed, true);
    } else {
      const producer = await producing;
      assert.equal(f.manager['producers'].get(producer.id)?.transportId, screen);
      assert.equal(f.produced[0].closed, false);
    }
    f.manager.close();
  });
}

test('native SFU screen health stays separately observable without changing the voice health report', () => {
  const f = sfuFixture();
  const screen = f.addReceiver('viewer-a', 'screen');
  const callRecord = f.manager['transports'].get('recv-viewer-a')!;
  callRecord.healthState = 'connected';
  const screenRecord = f.manager['transports'].get(screen)!;
  Object.defineProperty(screenRecord.transport, 'dtlsState', { value: 'failed' });
  let voiceReports = 0;
  f.manager.setHealthListener(() => { voiceReports++; });
  f.manager['updateTransportHealth'](screen);
  assert.equal(f.manager.getConnectionHealth('viewer-a', 'room'), 'connected');
  assert.equal(f.manager.getConnectionHealth('viewer-a', 'room', 'screen'), 'failed');
  assert.equal(voiceReports, 0);
  f.manager.close();
});

const transportCancellations: Array<{ name: string; cancel: (manager: SfuManager) => void }> = [
  { name: 'purpose replacement', cancel: manager => manager.closeTransportsFor('publisher', 'room', 'send', 'screen') },
  { name: 'session departure', cancel: manager => manager.closeSession('publisher') },
  { name: 'channel switch', cancel: manager => manager.closeSessionExcept('publisher', 'other-room') },
  { name: 'channel removal', cancel: manager => manager.closeChannel('room') },
  { name: 'server shutdown', cancel: manager => manager.close() },
];
for (const { name, cancel } of transportCancellations) {
  test(`native SFU cancels pending transport creation on ${name}`, async () => {
    const f = transportCreationFixture();
    const started = gate(), pending = gate();
    f.delayTransport(async () => { started.release(); await pending.promise; });
    const creating = f.manager.createWebRtcTransport('publisher', 'room', 'send', undefined, 'screen');
    await started.promise;
    cancel(f.manager);
    pending.release();
    await assert.rejects(creating, /cancelled|closed/u);
    assert.equal(f.created[0].closed, true);
    assert.equal(f.manager['transports'].size, 0);
    assert.equal(f.manager['pendingTransports'].size, 0);
    f.manager.close();
  });
}

test('native SFU cancellation before router readiness never starts a worker transport request', async () => {
  const f = transportCreationFixture();
  const started = gate(), pending = gate();
  f.delayRouter(async () => { started.release(); await pending.promise; });
  const creating = f.manager.createWebRtcTransport('publisher', 'room', 'send', undefined, 'screen');
  await started.promise;
  f.manager.closeSession('publisher');
  pending.release();
  await assert.rejects(creating, /cancelled|closed/u);
  assert.equal(f.created.length, 0);
  assert.equal(f.manager['transports'].size, 0);
  assert.equal(f.manager['pendingTransports'].size, 0);
  f.manager.close();
});

test('native SFU cancellation leaves pending work in other purposes, directions and sessions alone', async () => {
  const f = transportCreationFixture();
  const started = gate(), pending = gate();
  f.delayTransport(async () => { started.release(); await pending.promise; });
  const creating = f.manager.createWebRtcTransport('publisher', 'room', 'send', undefined, 'screen');
  await started.promise;
  f.manager.closeTransportsFor('publisher', 'room', 'send', 'call');
  f.manager.closeTransportsFor('publisher', 'room', 'recv', 'screen');
  f.manager.closeTransportsFor('other-publisher', 'room', 'send', 'screen');
  f.manager.closeSessionExcept('publisher', 'room');
  pending.release();
  const created = await creating;
  assert.equal(f.manager['transports'].get(created.id)?.purpose, 'screen');
  assert.equal(f.created[0].closed, false);
  assert.equal(f.manager['pendingTransports'].size, 0);
  f.manager.close();
});

test('native SFU an old creation cannot register over or close its already-ready replacement', async () => {
  const f = transportCreationFixture();
  const started = gate(), pending = gate();
  f.delayTransport(async () => { started.release(); await pending.promise; });
  const old = f.manager.createWebRtcTransport('publisher', 'room', 'send', undefined, 'screen');
  await started.promise;
  f.manager.closeTransportsFor('publisher', 'room', 'send', 'screen');
  f.delayTransport(async () => {});
  const current = await f.manager.createWebRtcTransport('publisher', 'room', 'send', undefined, 'screen');
  pending.release();
  await assert.rejects(old, /cancelled|closed/u);
  assert.deepEqual([...f.manager['transports'].keys()], [current.id]);
  assert.equal(f.created[0].closed, true);
  assert.equal(f.created[1].closed, false);
  assert.equal(f.manager['pendingTransports'].size, 0);
  f.manager.close();
});

test('native SFU synchronous departure from a health callback cannot publish a closed transport', async () => {
  const f = transportCreationFixture();
  f.manager.setHealthListener(() => { f.manager.closeSession('publisher'); });
  await assert.rejects(f.manager.createWebRtcTransport('publisher', 'room', 'send'), /cancelled|closed/u);
  assert.equal(f.created[0].closed, true);
  assert.equal(f.manager['transports'].size, 0);
  assert.equal(f.manager['pendingTransports'].size, 0);
  f.manager.close();
});

for (const stage of ['router', 'worker'] as const) {
  test(`native SFU failed ${stage} creation releases pending ownership and propagates the error`, async () => {
    const f = transportCreationFixture();
    const error = new Error('Injected creation failure');
    if (stage === 'router') f.delayRouter(async () => { throw error; });
    else f.delayTransport(async () => { throw error; });
    await assert.rejects(f.manager.createWebRtcTransport('publisher', 'room', 'send', undefined, 'screen'),
      actual => actual === error);
    assert.equal(f.manager['transports'].size, 0);
    assert.equal(f.manager['pendingTransports'].size, 0);
    f.manager.close();
  });
}

test('native SFU closing an exact screen transport preserves a replacement and the call pair', async () => {
  const f = transportCreationFixture();
  const old = await f.manager.createWebRtcTransport('publisher', 'room', 'send', undefined, 'screen');
  const current = await f.manager.createWebRtcTransport('publisher', 'room', 'send', undefined, 'screen');
  const call = await f.manager.createWebRtcTransport('publisher', 'room', 'send');
  assert.equal(f.manager.closeTransport('other', 'room', old.id, 'screen'), null);
  assert.equal(f.manager.closeTransport('publisher', 'elsewhere', old.id, 'screen'), null);
  assert.equal(f.manager.closeTransport('publisher', 'room', call.id, 'screen'), null);
  assert.deepEqual(f.manager.closeTransport('publisher', 'room', old.id, 'screen'), { closedProducerIds: [] });
  assert.deepEqual([...f.manager['transports'].keys()], [current.id, call.id]);
  f.manager['transports'].get(current.id)!.transport.close();
  assert.deepEqual(f.manager.closeTransport('publisher', 'room', current.id, 'screen'), { closedProducerIds: [] },
    'a known failed/closed native transport can still be explicitly retired');
  assert.equal(f.manager['transports'].has(call.id), true);
  f.manager.close();
});

test('native SFU a failed transport close preserves ownership for a retry', async () => {
  const f = sfuFixture();
  const id = f.addSender('publisher', 'screen');
  const produced = await f.manager.produce('publisher', 'room', id, 'video', { codecs: [] },
    { mediaType: 'screen_video', shareId: 'one' });
  const transport = f.manager['transports'].get(id)!.transport;
  const close = transport.close.bind(transport);
  transport.close = () => { throw new Error('Close failed'); };
  assert.throws(() => f.manager.closeTransport('publisher', 'room', id, 'screen'), /Close failed/u);
  assert.equal(f.manager['transports'].has(id), true);
  assert.equal(f.manager['producers'].has(produced.id), true);
  transport.close = close;
  assert.deepEqual(f.manager.closeTransport('publisher', 'room', id, 'screen'),
    { closedProducerIds: [produced.id] });
  f.manager.close();
});

test('native SFU producer pause controls are limited to owned screen media', async () => {
  const f = sfuFixture();
  const screen = f.addSender('publisher', 'screen'), call = f.addSender('publisher');
  const video = await f.manager.produce('publisher', 'room', screen, 'video', { codecs: [] },
    { mediaType: 'screen_video', shareId: 'one' });
  const camera = await f.manager.produce('publisher', 'room', call, 'video', { codecs: [] }, { mediaType: 'camera' });
  await assert.rejects(f.manager.setProducerPaused('other', 'room', video.id, true), /owned screen/u);
  await assert.rejects(f.manager.setProducerPaused('publisher', 'other-room', video.id, true), /owned screen/u);
  await assert.rejects(f.manager.setProducerPaused('publisher', 'room', camera.id, true), /owned screen/u);
  await f.manager.setProducerPaused('publisher', 'room', video.id, true);
  assert.equal(f.produced[0].paused, true);
  await f.manager.setProducerPaused('publisher', 'room', video.id, false);
  assert.equal(f.produced[0].paused, false);
  assert.equal(f.produced[0].resumes, 1);
  assert.equal(f.produced[1].paused, false);
  f.manager.close();
});

test('native SFU a late producer resume cannot revive a closed screen transport', async () => {
  const f = sfuFixture();
  const screen = f.addSender('publisher', 'screen');
  const video = await f.manager.produce('publisher', 'room', screen, 'video', { codecs: [] },
    { mediaType: 'screen_video', shareId: 'one' });
  const pending = gate(), started = gate();
  f.delayResume(async () => { started.release(); await pending.promise; });
  const resuming = f.manager.setProducerPaused('publisher', 'room', video.id, false);
  await started.promise;
  f.manager.closeTransport('publisher', 'room', screen, 'screen');
  pending.release();
  await assert.rejects(resuming, SfuProducerClosedError);
  assert.equal(f.produced[0].closed, true);
  assert.equal(f.produced[0].resumes, 0);
  assert.equal(f.manager['producers'].has(video.id), false);
  f.manager.close();
});

async function signalingFixture() {
  const channel: ChannelRecord = {
    id: 'room', serverId: 'server', name: 'Voice', type: 'VOICE', position: 0, createdAt: 1,
    maxParticipants: 10, isPrivate: false, allowedRoleIds: [], botCommandsEnabled: false,
  };
  const service = new SignalingService({
    findById: async id => ({ ...channel, id }), listByServerId: async () => [channel],
    create: async () => {}, update: async () => {}, delete: async () => {}, updatePosition: async () => {},
  }, { getForUser: () => ({ serverMuted: false, serverDeafened: false }), save() {} });
  const server = Object.create(WebSocketServer.prototype) as WebSocketServer;
  server['signalingService'] = service;
  server['closing'] = false;
  server['requireSfuMode'] = async () => true;
  const f = sfuFixture();
  server['sfuManager'] = f.manager;
  const sent: Array<{ socket: WebSocket; type: MessageType; payload: unknown; requestId?: string }> = [];
  server['send'] = (socket, message) => {
    sent.push({ socket, type: message.type, payload: message.payload, requestId: message.requestId });
  };
  const clients = ['viewer-a', 'viewer-b', 'publisher'].map(id => {
    const ws = Object.create(WebSocket.prototype) as WebSocket;
    Object.defineProperty(ws, 'readyState', { value: WebSocket.OPEN });
    const session: Parameters<WebSocketServer['handleMessage']>[0] = {
      ws, sessionId: id, isAlive: true, ip: '127.0.0.1', messageQueue: Promise.resolve(),
      user: { id, sessionId: id, clientId: id, nickname: id, status: 'ONLINE', joinedAt: 1 },
    };
    return session;
  });
  server['sessionSockets'] = new Map(clients.map(client => [client.sessionId!, client.ws]));
  server['sessions'] = new Map(clients.map(client => [client.ws, client]));
  for (const client of clients) await service.joinVoiceChannel(client.sessionId!, client.user!.id, 'room');
  service.updateVoiceState('publisher', { screenShareIds: ['one', 'two'] });
  return { ...f, server, service, sent, clients };
}

test('native SFU transport creation validates and routes purpose while omitted purpose preserves the browser call', async () => {
  const f = await signalingFixture();
  const transports = transportCreationFixture(f.manager);
  const viewer = f.clients[0];
  const replacements: RtcTransportPurpose[] = [];
  f.manager.isReady = () => true;
  const closeTransportsFor = f.manager.closeTransportsFor.bind(f.manager);
  f.manager.closeTransportsFor = (session, channel, direction, purpose = 'call') => {
    replacements.push(purpose);
    return closeTransportsFor(session, channel, direction, purpose);
  };
  for (const purpose of [undefined, 'screen'] as const) {
    await f.server['handleMessage'](viewer, { type: MessageType.SFU_CREATE_WEBRTC_TRANSPORT,
      payload: { channelId: 'room', direction: 'send', ...(purpose ? { purpose } : {}) } });
  }
  assert.deepEqual(replacements, ['call', 'screen']);
  assert.deepEqual(transports.created.map(transport => f.manager['transports'].get(transport.id)?.purpose),
    ['call', 'screen']);
  assert.deepEqual(f.sent.map(message => message.payload), [
    { channelId: 'room', direction: 'send', purpose: 'call',
      transportOptions: { id: 'transport-1', iceParameters: { usernameFragment: 'fixture', password: 'fixture' },
        iceCandidates: [], dtlsParameters: { role: 'auto', fingerprints: [] }, sctpParameters: undefined } },
    { channelId: 'room', direction: 'send', purpose: 'screen',
      transportOptions: { id: 'transport-2', iceParameters: { usernameFragment: 'fixture', password: 'fixture' },
        iceCandidates: [], dtlsParameters: { role: 'auto', fingerprints: [] }, sctpParameters: undefined } },
  ]);
  for (const purpose of [null, '', 'native', 1, true]) {
    await f.server['handleMessage'](viewer, { type: MessageType.SFU_CREATE_WEBRTC_TRANSPORT,
      payload: { channelId: 'room', direction: 'send', purpose } });
    assert.equal(f.sent.at(-1)?.type, MessageType.SERVER_ERROR);
  }
  assert.equal(transports.created.length, 2, 'invalid purposes never reach the worker');
  f.manager.close();
});

test('native SFU departure during worker initialization cannot start an already-abandoned transport', async () => {
  const f = await signalingFixture();
  const transports = transportCreationFixture(f.manager);
  const viewer = f.clients[0];
  const started = gate(), pending = gate();
  f.manager.isReady = () => false;
  f.manager.init = async () => { started.release(); await pending.promise; return true; };
  const creating = f.server['handleMessage'](viewer, { type: MessageType.SFU_CREATE_WEBRTC_TRANSPORT,
    payload: { channelId: 'room', direction: 'send', purpose: 'screen' } });
  await started.promise;
  f.service.leaveVoiceChannel('viewer-a');
  f.manager.closeSession('viewer-a');
  pending.release();
  await creating;
  assert.equal(transports.created.length, 0);
  assert.equal(f.sent.some(message => message.type === MessageType.SFU_WEBRTC_TRANSPORT_CREATED), false);
  assert.equal(f.sent.at(-1)?.type, MessageType.SERVER_ERROR);
  f.manager.close();
});

test('native SFU exact transport close acknowledges its request and only notifies affected producers', async () => {
  const f = await signalingFixture();
  const publisher = f.clients[2];
  const screen = f.addSender('publisher', 'screen'), call = f.addSender('publisher');
  const video = await f.manager.produce('publisher', 'room', screen, 'video', { codecs: [] },
    { mediaType: 'screen_video', shareId: 'one' });
  const broadcasts: Array<{ channel: string; payload: unknown }> = [];
  f.server['broadcastToChannel'] = async (channel, message) => { broadcasts.push({ channel, payload: message.payload }); };
  await f.server['handleMessage'](publisher, { type: MessageType.SFU_CLOSE_WEBRTC_TRANSPORT,
    requestId: 'close-native', payload: { channelId: 'room', transportId: screen, purpose: 'screen' } });
  assert.equal(f.sent.at(-1)?.type, MessageType.SFU_WEBRTC_TRANSPORT_CLOSED);
  assert.equal(f.sent.at(-1)?.requestId, 'close-native');
  assert.equal(f.manager['transports'].has(screen), false);
  assert.equal(f.manager['transports'].has(call), true);
  assert.deepEqual(broadcasts, [{ channel: 'room', payload: { channelId: 'room', producerId: video.id } }]);
  await f.server['handleMessage'](publisher, { type: MessageType.SFU_CLOSE_WEBRTC_TRANSPORT,
    requestId: 'close-native-again', payload: { channelId: 'room', transportId: screen, purpose: 'screen' } });
  assert.equal(f.sent.at(-1)?.type, MessageType.SFU_WEBRTC_TRANSPORT_CLOSED);
  assert.equal(f.sent.at(-1)?.requestId, 'close-native-again');
  assert.equal(broadcasts.length, 1, 'idempotent cleanup must not broadcast nonexistent producer changes');
  for (const payload of [
    { channelId: 'room', transportId: call, purpose: 'screen' },
    { channelId: 'room', transportId: call, purpose: 'call' },
    { channelId: 'room', transportId: 'recv-viewer-a', purpose: 'screen' },
  ]) {
    await f.server['handleMessage'](publisher, { type: MessageType.SFU_CLOSE_WEBRTC_TRANSPORT,
      requestId: 'invalid-close', payload });
    assert.equal(f.sent.at(-1)?.type, MessageType.SERVER_ERROR);
    assert.equal(f.sent.at(-1)?.requestId, 'invalid-close');
  }
  assert.equal(f.manager['transports'].has(call), true);
  assert.equal(f.manager['transports'].has('recv-viewer-a'), true);
  f.manager.close();
});

test('native SFU producer pause/resume and close replies settle their exact request IDs', async () => {
  const f = await signalingFixture();
  const publisher = f.clients[2];
  const screen = f.addSender('publisher', 'screen');
  const video = await f.manager.produce('publisher', 'room', screen, 'video', { codecs: [] },
    { mediaType: 'screen_video', shareId: 'one' });
  f.server['broadcastToChannel'] = async () => {};
  await f.server['handleMessage'](publisher, { type: MessageType.SFU_PRODUCER_SET_PAUSED, requestId: 'pause-producer',
    payload: { channelId: 'room', producerId: video.id, paused: true, purpose: 'screen' } });
  assert.equal(f.produced[0].paused, true);
  assert.equal(f.sent.at(-1)?.type, MessageType.SFU_PRODUCER_SET_PAUSED);
  assert.equal(f.sent.at(-1)?.requestId, 'pause-producer');
  await f.server['handleMessage'](f.clients[0], { type: MessageType.SFU_PRODUCER_SET_PAUSED, requestId: 'foreign-producer',
    payload: { channelId: 'room', producerId: video.id, paused: false, purpose: 'screen' } });
  assert.equal(f.sent.at(-1)?.type, MessageType.SERVER_ERROR);
  assert.equal(f.sent.at(-1)?.requestId, 'foreign-producer');
  assert.equal(f.produced[0].paused, true);
  await f.server['handleMessage'](publisher, { type: MessageType.SFU_PRODUCER_CLOSED, requestId: 'close-producer',
    payload: { channelId: 'room', producerId: video.id } });
  assert.equal(f.sent.at(-1)?.type, MessageType.SFU_PRODUCER_CLOSED);
  assert.equal(f.sent.at(-1)?.requestId, 'close-producer');
  assert.equal(f.manager['producers'].has(video.id), false);
  await f.server['handleMessage'](publisher, { type: MessageType.SFU_PRODUCER_CLOSED, requestId: 'close-producer-again',
    payload: { channelId: 'room', producerId: video.id } });
  assert.equal(f.sent.at(-1)?.type, MessageType.SFU_PRODUCER_CLOSED);
  assert.equal(f.sent.at(-1)?.requestId, 'close-producer-again');
  f.manager.close();
});

test('native SFU controls reject foreign/resumed retired consumers but acknowledge idempotent closure', async () => {
  const f = await signalingFixture();
  const viewer = f.clients[0];
  const consumer = await f.consume('video-one');
  const payload = { channelId: 'room', consumerId: consumer.id, paused: false };
  await f.server['handleMessage'](viewer, { type: MessageType.SFU_CONSUMER_SET_PAUSED, payload });
  assert.equal(f.sent.length, 0, 'the existing fire-and-forget browser path is unchanged');
  await f.server['handleMessage'](viewer, { type: MessageType.SFU_CONSUMER_SET_PAUSED, requestId: 'resume-consumer', payload });
  assert.equal(f.sent.at(-1)?.type, MessageType.SFU_CONSUMER_SET_PAUSED);
  assert.equal(f.sent.at(-1)?.requestId, 'resume-consumer');
  await f.server['handleMessage'](f.clients[1], { type: MessageType.SFU_CONSUMER_SET_PAUSED,
    requestId: 'foreign-consumer', payload });
  assert.equal(f.sent.at(-1)?.type, MessageType.SERVER_ERROR);
  assert.equal(f.sent.at(-1)?.requestId, 'foreign-consumer');
  await f.server['handleMessage'](f.clients[1], { type: MessageType.SFU_CONSUMER_CLOSED, requestId: 'foreign-close',
    payload: { channelId: 'room', consumerId: consumer.id } });
  assert.equal(f.sent.at(-1)?.type, MessageType.SERVER_ERROR);
  assert.equal(f.created[0].closed, false);
  await f.server['handleMessage'](viewer, { type: MessageType.SFU_CONSUMER_CLOSED, requestId: 'close-consumer',
    payload: { channelId: 'room', consumerId: consumer.id } });
  assert.equal(f.sent.at(-1)?.type, MessageType.SFU_CONSUMER_CLOSED);
  assert.equal(f.sent.at(-1)?.requestId, 'close-consumer');
  await f.server['handleMessage'](viewer, { type: MessageType.SFU_CONSUMER_CLOSED, requestId: 'close-consumer-again',
    payload: { channelId: 'room', consumerId: consumer.id } });
  assert.equal(f.sent.at(-1)?.type, MessageType.SFU_CONSUMER_CLOSED);
  assert.equal(f.sent.at(-1)?.requestId, 'close-consumer-again');
  await f.server['handleMessage'](viewer, { type: MessageType.SFU_CONSUMER_SET_PAUSED, requestId: 'late-consumer', payload });
  assert.equal(f.sent.at(-1)?.type, MessageType.SERVER_ERROR);
  assert.equal(f.sent.at(-1)?.requestId, 'late-consumer');
  f.manager.close();
});

test('native SFU consumer retirement is acknowledged after its parent already removed the resource', async () => {
  const f = await signalingFixture();
  const consumer = await f.consume('video-one');
  f.manager.closeSession('viewer-a');
  assert.equal(f.manager['consumers'].has(consumer.id), false);
  await f.server['handleMessage'](f.clients[0], {
    type: MessageType.SFU_CONSUMER_CLOSED, requestId: 'parent-retired-consumer',
    payload: { channelId: 'room', consumerId: consumer.id },
  });
  assert.equal(f.sent.at(-1)?.type, MessageType.SFU_CONSUMER_CLOSED);
  assert.equal(f.sent.at(-1)?.requestId, 'parent-retired-consumer');
  assert.equal(f.manager['transports'].has('recv-viewer-b'), true);
  f.manager.close();
});

test('native SFU worker errors return a terminal correlated response instead of stranding requests', async () => {
  const f = await signalingFixture();
  const consumer = await f.consume('video-one');
  f.delayResume(async () => { throw new Error('Injected worker failure'); });
  await f.server['handleMessage'](f.clients[0], { type: MessageType.SFU_CONSUMER_SET_PAUSED,
    requestId: 'failed-consumer', payload: { channelId: 'room', consumerId: consumer.id, paused: false } });
  assert.equal(f.sent.at(-1)?.type, MessageType.SERVER_ERROR);
  assert.equal(f.sent.at(-1)?.requestId, 'failed-consumer');
  assert.equal((f.sent.at(-1)?.payload as { code: ProtocolErrorCode }).code, ProtocolErrorCode.INTERNAL_ERROR);
  const sender = f.addSender('publisher', 'screen');
  const video = await f.manager.produce('publisher', 'room', sender, 'video', { codecs: [] },
    { mediaType: 'screen_video', shareId: 'one' });
  await f.server['handleMessage'](f.clients[2], { type: MessageType.SFU_PRODUCER_SET_PAUSED,
    requestId: 'failed-producer', payload: { channelId: 'room', producerId: video.id, paused: false, purpose: 'screen' } });
  assert.equal(f.sent.at(-1)?.type, MessageType.SERVER_ERROR);
  assert.equal(f.sent.at(-1)?.requestId, 'failed-producer');
  f.manager['transports'].get(sender)!.transport.close = () => { throw new Error('Injected close failure'); };
  await f.server['handleMessage'](f.clients[2], { type: MessageType.SFU_CLOSE_WEBRTC_TRANSPORT,
    requestId: 'failed-transport', payload: { channelId: 'room', transportId: sender, purpose: 'screen' } });
  assert.equal(f.sent.at(-1)?.type, MessageType.SERVER_ERROR);
  assert.equal(f.sent.at(-1)?.requestId, 'failed-transport');
  assert.equal(f.manager['transports'].has(sender), true);
  f.manager['transports'].get(sender)!.transport.close = () => {};
  f.manager.close();
});

test('screen Watch signaling is typed, bounded, authenticated and restricted to an available source in the same call', async () => {
  const f = await signalingFixture();
  const [viewer, other, publisher] = f.clients;
  const watch: ScreenWatchSignalPayload = {
    fromSessionId: 'forged', targetSessionId: 'publisher', signalType: 'screen-watch',
    streamId: 'one', subscriptionId: 'publisher-epoch', subscriptionRevision: 1, watching: true,
    watcherSubscriptionId: 'viewer-epoch',
  };
  await f.server['handleMessage'](viewer, { type: MessageType.RTC_SIGNAL, payload: watch });
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].socket, publisher.ws);
  assert.equal((f.sent[0].payload as ScreenWatchSignalPayload).fromSessionId, 'viewer-a');
  for (const value of [
    { ...watch, watching: 'true' }, { ...watch, subscriptionId: 'x'.repeat(65) },
    { ...watch, subscriptionRevision: -1 }, { ...watch, streamId: '<script>' },
    { ...watch, streamId: 'ended' }, { ...watch, extra: 'unbounded-field' },
  ]) {
    const before = f.sent.filter(message => message.socket === publisher.ws).length;
    await f.server['handleMessage'](viewer, { type: MessageType.RTC_SIGNAL, payload: value });
    assert.equal(f.sent.filter(message => message.socket === publisher.ws).length, before);
    assert.equal(f.sent.at(-1)?.type, MessageType.SERVER_ERROR);
  }
  await f.service.joinVoiceChannel('viewer-b', 'viewer-b', 'another-room');
  const before = f.sent.length;
  await f.server['handleMessage'](other, { type: MessageType.RTC_SIGNAL, payload: watch });
  assert.equal(f.sent.length, before, 'a different room never receives or controls this source');
  f.manager.close();
});

for (const backend of ['native', 'browser'] as const)
for (const codec of ['h264', 'av1'] as const)
test(`${backend}/${codec} screen signaling preserves codec and requires authenticated Watch with matching generation`, async () => {
  const f = await signalingFixture();
  const [viewer, other, publisher] = f.clients;
  const source = {
    shareId: 'one', instanceId: 'd54bc6e3-e54e-4127-bb03-a2972b65b2f6', audio: false, codec,
    video: { width: 1920, height: 1080, fps: 120, maxBitrateKbps: 20000 },
  };
  f.service.updateVoiceState('publisher', { nativeScreenShares: [source] });
  assert.equal(f.service.getVoiceState('publisher')?.nativeScreenShares?.[0].codec, codec);
  const scope = {
    fromSessionId: 'viewer-a', targetSessionId: 'publisher', publisherSessionId: 'publisher',
    channelId: 'room', shareId: source.shareId, sourceInstanceId: source.instanceId,
    subscriptionId: 'b3163b96-b5cc-48b5-a83b-f4df2d758ad7',
  };
  const control = nativeScreenSignalSchema.parse({
    ...scope, action: 'control', control: {
      protocol: 'monky-native-screen-p2p', version: 1, callId: source.instanceId, channelId: 'room',
      connectionId: scope.subscriptionId, generation: 1, type: 'negotiate', requestVersion: 1,
    },
  });
  const send = async (client: typeof viewer, payload: unknown) => {
    const requestId = crypto.randomUUID();
    await f.server['handleMessage'](client, { type: MessageType.NATIVE_SCREEN_SIGNAL, payload, requestId });
    const acknowledgement = f.sent.at(-1);
    if (acknowledgement?.type === MessageType.NATIVE_SCREEN_SIGNAL_ACK) {
      assert.equal(acknowledgement.socket, client.ws);
      assert.deepEqual(acknowledgement.payload, { subscriptionId: scope.subscriptionId, accepted: true });
      return f.sent.at(-2);
    }
    return f.sent.at(-1);
  };
  assert.equal((await send(viewer, control))?.type, MessageType.SERVER_ERROR);
  const watch = { ...scope, action: 'watch', quality: '720p60', backend };
  const routed = await send(viewer, { ...watch, fromSessionId: 'forged' });
  assert.equal(routed?.socket, publisher.ws);
  assert.equal(nativeScreenSignalSchema.parse(routed?.payload).fromSessionId, 'viewer-a');
  assert.equal((await send(viewer, { ...watch, backend: backend === 'native' ? 'browser' : 'native' }))?.type, MessageType.SERVER_ERROR);
  assert.equal((await send(viewer, control))?.type, MessageType.SERVER_ERROR, 'Watch alone does not admit native control');
  const accepted = { ...scope, fromSessionId: 'publisher', targetSessionId: 'viewer-a',
    action: 'accepted', quality: '720p60', backend, generation: 1 };
  const captureMode = { ...scope, fromSessionId: 'publisher', targetSessionId: 'viewer-a',
    action: 'capture-mode', generation: 1, capture: { mode: 'normal', ready: true } };
  assert.equal((await send(publisher, captureMode))?.type, MessageType.SERVER_ERROR, 'Mode cannot precede acceptance');
  assert.equal((await send(publisher, { ...accepted, quality: 'source' }))?.type, MessageType.SERVER_ERROR);
  assert.equal((await send(publisher, accepted))?.socket, viewer.ws);
  assert.equal((await send(publisher, captureMode))?.socket, viewer.ws);
  assert.equal((await send(publisher, { ...captureMode, generation: 2 }))?.type, MessageType.SERVER_ERROR);
  assert.equal((await send(viewer, captureMode))?.type, MessageType.SERVER_ERROR, 'Only the publisher owns the capture method');
  assert.equal((await send(viewer, control))?.socket, publisher.ws);
  if (control.action === 'control')
    assert.equal((await send(viewer, { ...control, control: { ...control.control, generation: 2 } }))?.type, MessageType.SERVER_ERROR);
  assert.equal((await send(other, control))?.type, MessageType.SERVER_ERROR);
  assert.equal((await send(viewer, { ...scope, action: 'stop' }))?.socket, publisher.ws);
  assert.equal((await send(publisher, captureMode))?.type, MessageType.SERVER_ERROR, 'Mode cannot revive a stopped Watch');
  assert.equal((await send(viewer, control))?.type, MessageType.SERVER_ERROR, 'late control cannot revive a stopped Watch');
  const beforeDuplicateStop = f.sent.length;
  await send(viewer, { ...scope, action: 'stop' });
  assert.equal(f.sent.length, beforeDuplicateStop + 1, 'Retried Stop only acknowledges the expired lease.');
  assert.equal(f.sent.at(-1)?.type, MessageType.NATIVE_SCREEN_SIGNAL_ACK);
  await send(viewer, watch);
  await send(publisher, accepted);
  f.service.updateVoiceState('publisher', { screenShareIds: ['two'] });
  assert.equal(f.service.getVoiceState('publisher')?.nativeScreenShares?.length, 0);
  assert.equal((await send(viewer, control))?.type, MessageType.SERVER_ERROR);
  f.manager.close();
});

test('native screen subscriptions cannot cross channel changes or replacement source instances', async () => {
  const f = await signalingFixture();
  const instanceId = '3995270b-dd41-4e3d-a19c-7012b0a32a88';
  const source = { shareId: 'one', instanceId, audio: false,
    video: { width: 1920, height: 1080, fps: 120, maxBitrateKbps: 20000 } };
  f.service.updateVoiceState('publisher', { nativeScreenShares: [source] });
  const scope = {
    fromSessionId: 'viewer-a', targetSessionId: 'publisher', publisherSessionId: 'publisher', channelId: 'room',
    shareId: 'one', sourceInstanceId: instanceId, subscriptionId: '6271f612-2551-47c1-a198-4e7f6adbdace',
  };
  const watch = nativeScreenSignalSchema.parse({ ...scope, action: 'watch', quality: 'source', backend: 'native' });
  assert.equal(f.service.authorizeNativeScreenSignal(watch).success, true);
  await f.service.joinVoiceChannel('viewer-a', 'viewer-a', 'other-room');
  assert.equal(f.service.authorizeNativeScreenSignal(watch).success, false);
  const stop = nativeScreenSignalSchema.parse({ ...scope, action: 'stop' });
  assert.equal(f.service.authorizeNativeScreenSignal(stop).success, false);
  await f.service.joinVoiceChannel('viewer-a', 'viewer-a', 'room');
  assert.deepEqual(f.service.authorizeNativeScreenSignal(stop), { success: true, forward: false });
  assert.equal(f.service.authorizeNativeScreenSignal(watch).success, true);
  f.service.updateVoiceState('publisher', { nativeScreenShares: [{
    ...source, instanceId: '1a34822d-46f4-41f6-9f69-7df5d44f56ba',
  }] });
  const replacement = nativeScreenSignalSchema.parse({
    ...watch, sourceInstanceId: '1a34822d-46f4-41f6-9f69-7df5d44f56ba', subscriptionId: crypto.randomUUID(),
  });
  assert.equal(f.service.authorizeNativeScreenSignal(replacement).success, true);
  assert.deepEqual(f.service.authorizeNativeScreenSignal(stop), { success: true, forward: false });
  assert.equal(f.service.authorizeNativeScreenSignal(nativeScreenSignalSchema.parse({
    ...replacement, fromSessionId: 'publisher', targetSessionId: 'viewer-a',
    action: 'accepted', backend: 'native', quality: 'source', generation: 1,
  })).success, true, 'Retiring an expired source cannot remove its replacement subscription.');
  assert.equal(f.service.authorizeNativeScreenSignal(watch).success, false);
  await f.service.joinVoiceChannel('publisher', 'publisher', 'other-room');
  assert.deepEqual(f.service.getVoiceState('publisher')?.nativeScreenShares, []);
  f.manager.close();
});

test('native SFU publications match their announced profile and exact engine transport before worker I/O', async () => {
  const f = await signalingFixture();
  const publisher = f.clients[2];
  const instanceId = 'd3ff5c19-0f2e-41ca-8b46-389be057c88b';
  const pipelineId = 'cc7b7233-f39c-41f9-aa8d-6717a494c8e5';
  const video = { width: 1920, height: 1080, fps: 120, maxBitrateKbps: 20000 };
  f.service.updateVoiceState('publisher', { nativeScreenShares: [{ shareId: 'one', instanceId, audio: false, video }] });
  const transportId = f.addSender('publisher', 'screen', pipelineId);
  const nativeScreen = { sourceInstanceId: instanceId, pipelineId, video };
  const payload = { channelId: 'room', transportId, kind: 'video', rtpParameters: { codecs: [] },
    appData: { mediaType: 'screen_video', shareId: 'one', nativeScreen } };
  for (const invalid of [
    { ...payload, appData: { ...payload.appData, nativeScreen: { ...nativeScreen, pipelineId: instanceId } } },
    { ...payload, appData: { ...payload.appData, nativeScreen: { ...nativeScreen, video: { ...video, fps: 90 } } } },
    { ...payload, kind: 'audio', appData: { ...payload.appData, mediaType: 'screen_audio' } },
  ]) {
    await f.server['handleMessage'](publisher, { type: MessageType.SFU_PRODUCE, payload: invalid });
    assert.equal(f.sent.at(-1)?.type, MessageType.SERVER_ERROR);
    assert.equal(f.produced.length, 0);
  }
  await f.server['handleMessage'](publisher, { type: MessageType.SFU_PRODUCE, payload });
  assert.equal(f.produced.length, 1);
  assert.equal(f.sent.filter(value => value.type === MessageType.SFU_NEW_PRODUCER).length, 2);
  const starting = gate(), resume = gate();
  f.delayCreate(async () => { starting.release(); await resume.promise; });
  const opening = f.server['handleMessage'](publisher, { type: MessageType.SFU_PRODUCE, payload });
  await starting.promise;
  f.service.updateVoiceState('publisher', { screenShareIds: [] });
  resume.release();
  await opening;
  assert.equal(f.produced[1].closed, true);
  assert.equal(f.sent.filter(value => value.type === MessageType.SFU_NEW_PRODUCER).length, 2, 'late profile creation is never advertised');
  f.manager.close();
});

test('screen SFU WebSocket controls reject malformed payloads, require call membership and cannot close another viewer or producer', async () => {
  const f = await signalingFixture();
  const [viewer, other] = f.clients;
  const consumer = await f.consume('video-one');
  for (const payload of [null, { channelId: 'room', consumerId: consumer.id, paused: 'false' },
    { channelId: 'room', consumerId: 'x'.repeat(129), paused: false }]) {
    await f.server['handleMessage'](viewer, { type: MessageType.SFU_CONSUMER_SET_PAUSED, payload });
    assert.equal(f.sent.at(-1)?.type, MessageType.SERVER_ERROR);
    assert.equal((f.sent.at(-1)?.payload as { code: ProtocolErrorCode }).code, ProtocolErrorCode.BAD_REQUEST);
  }
  await f.server['handleMessage'](other, {
    type: MessageType.SFU_CONSUMER_CLOSED, payload: { channelId: 'room', consumerId: consumer.id },
  });
  assert.equal(f.created[0].closed, false);
  await f.server['handleMessage'](viewer, {
    type: MessageType.SFU_PRODUCER_CLOSED, payload: { channelId: 'room', producerId: 'video-one' },
  });
  assert.equal(f.manager['producers'].has('video-one'), true);
  await f.server['handleMessage'](viewer, {
    type: MessageType.SFU_CONSUMER_CLOSED, payload: { channelId: 'room', consumerId: consumer.id },
  });
  assert.equal(f.created[0].closed, true);
  f.service.leaveVoiceChannel('viewer-a');
  await f.server['handleMessage'](viewer, {
    type: MessageType.SFU_CONSUME, payload: { channelId: 'room', transportId: 'recv-viewer-a', producerId: 'video-one', rtpCapabilities: {} },
  });
  assert.equal((f.sent.at(-1)?.payload as { code: ProtocolErrorCode }).code, ProtocolErrorCode.PERMISSION_DENIED);
  assert.equal(f.created.length, 1);
  f.manager.close();
});

for (const codec of ['h264', 'av1'] as const)
test(`${codec}: SFU admits only the codec-aligned announced 480p rendition`, async () => {
  const f = await signalingFixture();
  const publisher = f.clients[2];
  const instanceId = 'd3ff5c19-0f2e-41ca-8b46-389be057c88b';
  const pipelineId = 'cc7b7233-f39c-41f9-aa8d-6717a494c8e5';
  const video = { width: 1920, height: 1080, fps: 120, maxBitrateKbps: 20000 };
  f.service.updateVoiceState('publisher', { nativeScreenShares: [{ shareId: 'one', instanceId, audio: false, video, codec }] });
  const transportId = f.addSender('publisher', 'screen', pipelineId);
  const width = codec === 'av1' ? 848 : 852;
  const rendition = { width, height: 480, fps: 30, maxBitrateKbps: 1500 };
  const nativeScreen = { sourceInstanceId: instanceId, pipelineId, video: rendition };
  const payload = { channelId: 'room', transportId, kind: 'video', rtpParameters: { codecs: [] },
    appData: { mediaType: 'screen_video', shareId: 'one', nativeScreen } };
  await f.server['handleMessage'](publisher, { type: MessageType.SFU_PRODUCE,
    payload: { ...payload, appData: { ...payload.appData,
      nativeScreen: { ...nativeScreen, video: { ...rendition, width: codec === 'av1' ? 852 : 848 } } } } });
  assert.equal(f.sent.at(-1)?.type, MessageType.SERVER_ERROR);
  assert.equal(f.produced.length, 0);
  await f.server['handleMessage'](publisher, { type: MessageType.SFU_PRODUCE, payload });
  assert.equal(f.produced.length, 1);
  f.manager.close();
});
