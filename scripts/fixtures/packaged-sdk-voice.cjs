const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');

async function main() {
  assert.ok(process.argv[2] && process.argv[3], 'Pass the installed SDK manifest and installation root.');
  const root = fs.realpathSync(process.argv[3]);
  const resolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...args) {
    const resolved = resolve.call(this, request, ...args);
    if (typeof resolved === 'string' && !Module.isBuiltin(resolved)) {
      const relative = path.relative(root, fs.realpathSync(resolved));
      assert.ok(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
        `${request} escaped the isolated installation.`);
    }
    return resolved;
  };
  const sdk = Module.createRequire(path.resolve(process.argv[2]));
  const { OpusPeer, opusCodec } = sdk('./dist/voice/OpusPeer');
  const { RTCPeerConnection } = sdk('werift');
  const failures = [];
  const sender = new OpusPeer([], error => failures.push(error));
  const receiver = new RTCPeerConnection({ codecs: { audio: [opusCodec()] }, iceServers: [] });
  const packets = [];
  receiver.onTrack.subscribe(track => track.onReceiveRtp.subscribe(packet => packets.push(packet.payload)));
  try {
    await sender.pc.setLocalDescription(await sender.pc.createOffer());
    assert.match(sender.pc.localDescription.sdp, /a=fingerprint:sha-256/i);
    await receiver.setRemoteDescription(sender.pc.localDescription);
    await receiver.setLocalDescription(await receiver.createAnswer());
    await sender.pc.setRemoteDescription(receiver.localDescription);
    await sender.ready;
    const silence = Uint8Array.from([0xf8, 0xff, 0xfe]);
    await sender.write(silence);
    const deadline = Date.now() + 5000;
    while (!packets.length && !failures.length && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.deepEqual(failures, []);
    assert.equal(receiver.connectionState, 'connected');
    assert.deepEqual(packets, [Buffer.from(silence)]);
    console.log('Packaged SDK negotiated ICE/DTLS/SRTP and delivered Opus.');
  } finally {
    await Promise.all([sender.close(), receiver.close()]);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
