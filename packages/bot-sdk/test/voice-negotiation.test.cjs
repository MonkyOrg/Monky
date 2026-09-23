const assert = require('node:assert/strict');
const { test } = require('node:test');
const { RTCPeerConnection, RTCRtpCodecParameters } = require('werift');
const { OpusPeer, opusCodec } = require('../dist/voice/OpusPeer');

const OPUS = Uint8Array.from([0xf8, 0xff, 0xfe]);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 300 && !predicate(); i++) await wait(10);
  assert.ok(predicate(), 'Condition did not become true');
}
function candidates(sdp) {
  return sdp.split(/\r?\nm=/).slice(1).flatMap((section, index) => {
    const mid = /^a=mid:([^\r\n]+)/m.exec(section)?.[1];
    const ufrag = /^a=ice-ufrag:([^\r\n]+)/m.exec(section)?.[1];
    return [...section.matchAll(/^a=(candidate:[^\r\n]+)/gm)].map(match => ({
      candidate: match[1], sdpMid: mid, sdpMLineIndex: index, usernameFragment: ufrag,
    }));
  });
}
function fixture(t) {
  const errors = [], signals = [], packets = [];
  const bot = new OpusPeer([], error => errors.push(error), signal => signals.push(signal));
  const human = new RTCPeerConnection({
    iceServers: [], bundlePolicy: 'max-bundle',
    codecs: { audio: [opusCodec()], video: [new RTCRtpCodecParameters({ mimeType: 'video/VP8', clockRate: 90000 })] },
  });
  human.addTransceiver('audio', { direction: 'sendrecv' });
  human.onTrack.subscribe(track => track.onReceiveRtp.subscribe(packet => packets.push(packet)));
  t.after(async () => { await bot.close(); await human.close(); });
  const signal = payload => bot.accept({ fromSessionId: 'human', targetSessionId: 'bot', ...payload }, false);
  return { bot, human, errors, signals, packets, signal };
}

test('glare candidates for discarded audio/video m-lines cannot poison the winning answer', { timeout: 30000 }, async t => {
  const f = fixture(t);
  f.human.addTransceiver('audio', { direction: 'sendrecv' });
  f.human.addTransceiver('video', { direction: 'sendrecv' });
  await f.bot.offer();
  const winningOffer = f.bot.pc.localDescription;
  await f.human.setLocalDescription(await f.human.createOffer());
  const collidedOffer = f.human.localDescription;
  const trickled = candidates(collidedOffer.sdp);
  assert.ok(trickled.some(candidate => candidate.sdpMLineIndex === 2));
  await f.signal({ signalType: 'offer', sdp: collidedOffer });
  assert.equal(f.bot.pc.signalingState, 'have-local-offer', 'Impolite bot must keep its elected offer.');
  for (const candidate of trickled) await f.signal({ signalType: 'candidate', candidate });
  await f.human.setLocalDescription({ type: 'rollback' });
  await f.human.setRemoteDescription(winningOffer);
  await f.human.setLocalDescription(await f.human.createAnswer());
  await f.signal({ signalType: 'answer', sdp: f.human.localDescription });
  for (const candidate of trickled) await f.signal({ signalType: 'candidate', candidate });
  await f.bot.ready;
  await f.bot.write(OPUS);
  await until(() => f.packets.length > 0);
  assert.deepEqual(f.packets[0].payload, Buffer.from(OPUS));
  assert.deepEqual(f.errors, []);
});

test('new media candidates arriving before a renegotiation offer wait for their matching description', { timeout: 30000 }, async t => {
  const f = fixture(t);
  await f.bot.offer();
  await f.human.setRemoteDescription(f.bot.pc.localDescription);
  await f.human.setLocalDescription(await f.human.createAnswer());
  await f.signal({ signalType: 'answer', sdp: f.human.localDescription });
  await f.bot.ready;
  await f.bot.write(OPUS);
  await until(() => f.packets.length > 0);
  f.human.addTransceiver('audio', { direction: 'sendrecv' });
  f.human.addTransceiver('video', { direction: 'sendrecv' });
  await f.human.setLocalDescription(await f.human.createOffer());
  const offer = f.human.localDescription;
  const early = candidates(offer.sdp).filter(candidate => candidate.sdpMLineIndex > 0);
  assert.ok(early.length > 0);
  for (const candidate of early) await f.signal({ signalType: 'candidate', candidate });
  await f.signal({ signalType: 'offer', sdp: offer });
  const answer = f.signals.findLast(signal => signal.signalType === 'answer').sdp;
  assert.equal((answer.sdp.match(/a=inactive/g) || []).length, 2);
  await f.human.setRemoteDescription(answer);
  for (const candidate of early) await f.signal({ signalType: 'candidate', candidate });
  await f.bot.write(OPUS);
  await until(() => f.packets.length >= 2);
  assert.deepEqual(f.errors, []);
});

test('polite glare rolls back and answers every audio/video m-line without receiving participant media', { timeout: 30000 }, async t => {
  const f = fixture(t);
  f.human.addTransceiver('audio', { direction: 'sendrecv' });
  f.human.addTransceiver('video', { direction: 'sendrecv' });
  await f.bot.offer();
  await f.human.setLocalDescription(await f.human.createOffer());
  const offer = f.human.localDescription;
  for (const candidate of candidates(offer.sdp)) await f.signal({ signalType: 'candidate', candidate });
  await f.bot.accept({ fromSessionId: 'human', targetSessionId: 'bot', signalType: 'offer', sdp: offer }, true);
  const answer = f.signals.findLast(signal => signal.signalType === 'answer').sdp;
  assert.equal((answer.sdp.match(/^m=/gm) || []).length, 3);
  assert.deepEqual(f.bot.pc.getTransceivers().map(transceiver => transceiver.direction), ['sendonly', 'inactive', 'inactive']);
  await f.human.setRemoteDescription(answer);
  await f.bot.ready;
  await f.bot.write(OPUS);
  await until(() => f.packets.length > 0);
  assert.deepEqual(f.errors, []);
});

test('ICE generations are checked before native application while malformed applicable candidates still fail', { timeout: 30000 }, async t => {
  const f = fixture(t);
  await f.bot.offer();
  await f.human.setRemoteDescription(f.bot.pc.localDescription);
  await f.human.setLocalDescription(await f.human.createAnswer());
  await f.signal({ signalType: 'answer', sdp: f.human.localDescription });
  await f.bot.ready;
  const candidate = candidates(f.human.localDescription.sdp)[0];
  assert.ok(candidate?.usernameFragment);
  await f.signal({ signalType: 'candidate', candidate: { ...candidate, usernameFragment: 'not-the-applied-generation' } });
  assert.equal(f.bot.pendingCandidates.length, 1);
  await f.signal({ signalType: 'candidate', candidate: {
    ...candidate, usernameFragment: undefined, candidate: `${candidate.candidate} ufrag ${candidate.usernameFragment}`,
  } });
  await f.signal({ signalType: 'candidate', candidate: {
    ...candidate, usernameFragment: undefined, candidate: candidate.candidate.replace(/^candidate:\S+/, 'candidate:ufrag'),
  } });
  assert.equal(f.bot.pendingCandidates.length, 1, 'An ICE foundation named ufrag is not a username-fragment extension.');
  await f.bot.write(OPUS);
  await until(() => f.packets.length > 0);
  assert.deepEqual(f.errors, []);
  await assert.rejects(f.signal({ signalType: 'candidate', candidate: { ...candidate, candidate: 'invalid ICE candidate' } }));
  assert.equal(f.errors.length, 1, 'Malformed candidates for the current transport must not be silently ignored.');
  await f.bot.close();
  assert.deepEqual(f.bot.pendingCandidates, []);
});

test('unmatched ICE candidates remain bounded and are released with the retired peer', async t => {
  const f = fixture(t);
  for (let i = 0; i < 256; i++) await f.signal({ signalType: 'candidate', candidate: {
    candidate: 'candidate:1 1 udp 1 127.0.0.1 12345 typ host',
    sdpMid: 'future', sdpMLineIndex: 0, usernameFragment: 'future',
  } });
  assert.equal(f.bot.pendingCandidates.length, 256);
  await assert.rejects(f.signal({ signalType: 'candidate', candidate: {
    candidate: 'candidate:1 1 udp 1 127.0.0.1 12345 typ host', sdpMid: 'future',
  } }), /candidate limit exceeded/);
  await f.bot.close();
  assert.deepEqual(f.bot.pendingCandidates, []);
});
