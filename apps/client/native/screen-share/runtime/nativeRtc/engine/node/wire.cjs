'use strict';

const v8 = require('node:v8');
const MAX_MESSAGE_BYTES = 5 * 1024 * 1024;
const METHODS = new Set(['request', 'respond', 'cancel', 'submitFrame', 'submitEncodedFrame',
  'submitAudioPacket', 'grantAudioCredits', 'audioClockProbe', 'calibrateAudioClock',
  'setAudioOutputFeedback', 'releaseFrame', 'snapshot', 'close']);

function encode(value) {
  const bytes = v8.serialize(value);
  if (bytes.length > MAX_MESSAGE_BYTES) throw new Error('Native RTC IPC message exceeded its bound.');
  return bytes;
}

function decode(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_MESSAGE_BYTES)
    throw new Error('Invalid native RTC IPC message.');
  return v8.deserialize(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
}

function errorRecord(error) {
  const result = { message: String(error?.message ?? error), name: error?.name ?? 'Error' };
  for (const key of ['code', 'status', 'hresult', 'nativeOwnershipRetained', 'processingPending',
    'sourceId', 'frameId', 'epoch', 'sequence', 'frameIndex', 'frames'])
    if (Object.hasOwn(error ?? {}, key)) result[key] = error[key];
  return result;
}

const fromError = record => Object.assign(new Error(record.message), record);
module.exports = { encode, decode, errorRecord, fromError, METHODS };
