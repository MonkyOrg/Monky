'use strict';

const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const path = require('node:path');
const { within } = require('../runtime/nativeDeadline.cjs');
const { MessageType, sfuCreateWebRtcTransportSchema, sfuMediaAppDataSchema } = require('@monky/shared');
const { SfuManager } = require(path.resolve(__dirname, '..', '..', '..', '..',
  'server', 'dist', 'infrastructure', 'sfu', 'SfuManager.js'));

async function availablePort() {
  const socket = dgram.createSocket('udp4');
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, '127.0.0.1', resolve);
  });
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  assert.ok(port + 63 <= 65535, 'The OS-selected test port has no room for its bounded SFU range.');
  return port;
}

async function createSfuFixture(channelId) {
  const port = await availablePort();
  // Native ICE uses real adapters; announcing LAN addresses from sockets bound
  // only to loopback makes those candidates unreachable.
  const manager = new SfuManager({ listenIp: '0.0.0.0', announcedIp: '127.0.0.1', rtcMinPort: port, rtcMaxPort: port + 63 });
  assert.equal(await manager.init(), true, manager.getLastError());
  const worker = manager.worker;
  const producerListeners = new Set();
  let connected = true;
  const subprocessClosed = new Promise(resolve => worker.once('subprocessclose', resolve));
  const dispatch = sessionId => async (type, payload) => {
    assert.equal(payload.channelId, channelId);
    switch (type) {
      case MessageType.SFU_GET_ROUTER_RTP_CAPABILITIES:
        return { channelId, rtpCapabilities: await manager.getRouterRtpCapabilities(channelId) };
      case MessageType.SFU_CREATE_WEBRTC_TRANSPORT: {
        const { direction, purpose, screenSessionId } = sfuCreateWebRtcTransportSchema.parse(payload);
        assert.equal(purpose, 'screen');
        manager.closeTransportsFor(sessionId, channelId, direction, purpose, screenSessionId);
        const transportOptions = await manager.createWebRtcTransport(sessionId, channelId, direction, undefined, purpose, screenSessionId);
        return { channelId, direction, purpose, screenSessionId, transportOptions };
      }
      case MessageType.SFU_CONNECT_WEBRTC_TRANSPORT:
        assert.ok(manager.ownsTransport(sessionId, channelId, payload.transportId, undefined, 'screen'));
        await manager.connectWebRtcTransport(payload.transportId, payload.dtlsParameters);
        return { channelId, transportId: payload.transportId };
      case MessageType.SFU_PRODUCE: {
        const appData = sfuMediaAppDataSchema.parse(payload.appData);
        assert.ok(appData.mediaType === 'screen_video' || appData.mediaType === 'screen_audio');
        const produced = await manager.produce(sessionId, channelId, payload.transportId, payload.kind, payload.rtpParameters, appData);
        const notification = { channelId, producerId: produced.id, producerSessionId: sessionId, kind: payload.kind, appData };
        queueMicrotask(() => {
          for (const listener of producerListeners) listener(JSON.parse(JSON.stringify(notification)));
        });
        return { channelId, ...produced };
      }
      case MessageType.SFU_CONSUME:
        return { channelId, ...await manager.consume(sessionId, channelId, payload.transportId, payload.producerId, payload.rtpCapabilities) };
      case MessageType.SFU_PRODUCER_SET_PAUSED:
        assert.ok(manager.ownsProducer(sessionId, channelId, payload.producerId, 'screen'));
        await manager.setProducerPaused(sessionId, channelId, payload.producerId, payload.paused, 'screen');
        return payload;
      case MessageType.SFU_CONSUMER_SET_PAUSED:
        await manager.setConsumerPaused(sessionId, channelId, payload.consumerId, payload.paused);
        return payload;
      case MessageType.SFU_PRODUCER_CLOSED:
        if (manager.ownsProducer(sessionId, channelId, payload.producerId, 'screen')) manager.closeProducer(payload.producerId);
        assert.equal(manager.producers.has(payload.producerId), false);
        return payload;
      case MessageType.SFU_CONSUMER_CLOSED:
        manager.closeConsumer(sessionId, channelId, payload.consumerId);
        assert.equal(manager.consumers.has(payload.consumerId), false);
        return payload;
      case MessageType.SFU_CLOSE_WEBRTC_TRANSPORT:
        manager.closeTransport(sessionId, channelId, payload.transportId, 'screen');
        assert.equal(manager.transports.has(payload.transportId), false);
        return payload;
      default: throw new Error(`The native test attempted an unrelated RPC: ${type}`);
    }
  };
  return {
    rpc: sessionId => {
      const route = dispatch(sessionId);
      // The real WebSocket carrier omits undefined optional SDK fields.
      return async (type, payload) => {
        if (!connected) throw new Error('The test deliberately disconnected its authenticated SFU signaling.');
        return JSON.parse(JSON.stringify(await route(type, JSON.parse(JSON.stringify(payload)))));
      };
    },
    disconnectRpc() { connected = false; },
    producers: () => manager.getProducersInChannel(channelId).map(producer => ({ channelId, ...producer })),
    onProducer(listener) {
      assert.equal(typeof listener, 'function');
      producerListeners.add(listener);
      return () => producerListeners.delete(listener);
    },
    stats: () => Promise.all([...manager.transports.values()].map(record => record.transport.getStats())),
    assertNoConsumers() { assert.equal(manager.consumers.size, 0, 'Stop Watching retained a server media consumer.'); },
    assertRetired() {
      for (const resources of [manager.producers, manager.consumers, manager.transports]) assert.equal(resources.size, 0);
    },
    async close() {
      producerListeners.clear();
      manager.close();
      await within(subprocessClosed, 5000, 'The owned SFU subprocess did not terminate.');
      assert.equal(worker.subprocessClosed, true);
    },
  };
}

module.exports = { createSfuFixture };
