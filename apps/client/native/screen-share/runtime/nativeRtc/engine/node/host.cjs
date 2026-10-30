'use strict';

// This is the only production JavaScript entry point allowed to load the RTC addon.
const assert = require('node:assert/strict');
const { encode, decode, errorRecord, METHODS, MAX_ORDINARY_CALLS, MAX_RETIREMENT_CALLS } = require('./wire.cjs');
const parent = process.parentPort;
const send = value => {
  const bytes = encode(value);
  if (parent) parent.postMessage(bytes);
  else process.send(bytes, error => { if (error) process.exit(71); });
};
let engine, surfaceSender, timer, configured = false, closed = false;
let nextEvent = 0, eventBytes = 0;
const events = new Map(), pending = new Set();
const exit = code => { clearInterval(timer); process.exit(code); };
function publish(event) {
  if (event.type === 'frame' && surfaceSender)
    surfaceSender.sendSurface(event.data.textureInfo.handle.ioSurfaceId, event.data.frameId);
  const id = ++nextEvent;
  const bytes = encode({ type: 'event', id, event });
  if (events.size >= 128 || eventBytes + bytes.length > 8 * 1024 * 1024) exit(72);
  events.set(id, bytes.length);
  eventBytes += bytes.length;
  if (parent) parent.postMessage(bytes);
  else process.send(bytes, error => { if (error) exit(71); });
}

async function receive(bytes) {
  const message = decode(bytes);
  if (message.type === 'finish') {
    assert.equal(closed, true, 'Only an acknowledged native close can finish its process.');
    exit(0);
    return;
  }
  if (message.type === 'event-ack') {
    assert.ok(events.has(message.id), 'Unknown RTC event acknowledgement.');
    eventBytes -= events.get(message.id);
    events.delete(message.id);
    return;
  }
  if (message.type === 'initialize') {
    assert.equal(configured, false);
    configured = true;
    const addon = require(message.filename);
    const capabilities = addon.capabilities();
    assert.deepEqual(capabilities, message.capabilities, 'RTC binary capabilities differ from the verified build.');
    if (capabilities.decodedOutput === 'NV12_IOSURFACE_LEASE')
      surfaceSender = require(message.handlesFile).openSender(message.surfaceChannel);
    engine = addon.createEngine(message.options, publish);
    await engine.ready;
    send({ type: 'ready', snapshot: engine.snapshot(), capabilities });
    timer = setInterval(() => {
      try { publish({ type: 'process.snapshot', snapshot: engine.snapshot() }); }
      catch (error) { send({ type: 'fatal', error: errorRecord(error) }); exit(73); }
    }, 500);
    return;
  }
  assert.equal(message.type, 'call');
  // Separate checks: a field failure (exit 74) must name which call contract broke.
  assert.ok(engine, `RTC call ${message.id} (${message.method}) arrived before the native engine was initialized.`);
  assert.ok(Number.isSafeInteger(message.id) && message.id > 0,
    `RTC call identifier ${message.id} (${message.method}) is invalid.`);
  assert.ok(!pending.has(message.id), `RTC call identifier ${message.id} (${message.method}) is already in flight.`);
  assert.ok(METHODS.has(message.method) && Array.isArray(message.args)
    && pending.size < MAX_ORDINARY_CALLS + MAX_RETIREMENT_CALLS);
  pending.add(message.id);
  try {
    // Native state may already be gone while asynchronous close is still draining.
    if (message.method === 'close') clearInterval(timer);
    const result = await engine[message.method](...message.args);
    if (message.method === 'close') {
      closed = true;
      surfaceSender?.close();
    }
    send({ type: 'result', id: message.id, result });
  } catch (error) {
    send({ type: 'result', id: message.id, error: errorRecord(error) });
  } finally {
    pending.delete(message.id);
  }
}

const onMessage = bytes => {
  void receive(bytes).catch(error => {
    try { send({ type: 'fatal', error: errorRecord(error) }); }
    finally { exit(74); }
  });
};
if (parent) parent.on('message', event => onMessage(event.data));
else {
  process.on('message', onMessage);
  process.on('disconnect', () => exit(75));
}
