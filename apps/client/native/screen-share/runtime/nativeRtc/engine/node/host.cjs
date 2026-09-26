'use strict';

// This is the only production JavaScript entry point allowed to load the RTC addon.
const assert = require('node:assert/strict');
const { encode, decode, errorRecord, METHODS } = require('./wire.cjs');
const parent = process.parentPort;
const send = value => {
  const bytes = encode(value);
  if (parent) parent.postMessage(bytes);
  else process.send(bytes, error => { if (error) process.exit(71); });
};
let engine, parentHandles, timer, configured = false, closed = false;
let nextEvent = 0, eventBytes = 0;
const events = new Map(), pending = new Set();
const inputLeases = new Map();
const exit = code => { clearInterval(timer); process.exit(code); };
function publish(event) {
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
    if (message.handlesFile) parentHandles = require(message.handlesFile).openProcess(message.parentPid);
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
  assert.ok(engine && Number.isSafeInteger(message.id) && message.id > 0 && !pending.has(message.id));
  assert.ok(METHODS.has(message.method) && Array.isArray(message.args) && pending.size < 192);
  pending.add(message.id);
  let inputLease = null, inputRetired = false;
  try {
    if (message.method === 'submitFrame') {
      assert.ok(parentHandles, 'Native input HANDLE duplication is unavailable.');
      assert.ok(inputLeases.size < 16, 'The native input HANDLE lease budget is full.');
      inputLease = parentHandles.duplicate(message.args[1].handle);
      inputLeases.set(message.id, inputLease);
      message.args[1].handle = inputLease.handle;
    }
    const result = await engine[message.method](...message.args);
    inputRetired = true;
    if (message.method === 'close') {
      closed = true;
      clearInterval(timer);
      for (const lease of inputLeases.values()) lease.close();
      inputLeases.clear();
    }
    send({ type: 'result', id: message.id, result });
  } catch (error) {
    inputRetired = error.nativeOwnershipRetained === false;
    send({ type: 'result', id: message.id, error: errorRecord(error) });
  } finally {
    if (inputLease && inputRetired) {
      inputLease.close();
      inputLeases.delete(message.id);
    }
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
