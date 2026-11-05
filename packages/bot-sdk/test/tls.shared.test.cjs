const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { AutoTlsService } = require('@monky/shared/dist/tls');
const { bitString, ipAddressBytes, objectIdentifier, octetString, sequence, set, smallInteger, tlv } = require('@monky/shared/dist/tls/der');
const { createBotTls } = require('../dist');

const IP = '1.1.1.1';
const DAY = 24 * 60 * 60 * 1000;

function derTime(ms) {
  const iso = new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/[-:T]/g, '').replace('.000', '');
  return tlv(0x17, Buffer.from(iso.slice(2), 'ascii'));
}

function certificateFor(ip, notAfter) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const name = sequence(set(sequence(objectIdentifier('2.5.4.3'), tlv(0x0c, Buffer.from('Monky test')))));
  const algorithm = sequence(objectIdentifier('1.2.840.10045.4.3.2'));
  const tbs = sequence(
    tlv(0xa0, smallInteger(2)), tlv(0x02, Buffer.concat([Buffer.from([1]), crypto.randomBytes(8)])), algorithm, name,
    sequence(derTime(Date.now() - 60_000), derTime(notAfter)), name, publicKey.export({ type: 'spki', format: 'der' }),
    tlv(0xa3, sequence(sequence(objectIdentifier('2.5.29.17'), octetString(sequence(tlv(0x87, ipAddressBytes(ip))))))),
  );
  const der = sequence(tbs, algorithm, bitString(crypto.sign('sha256', tbs, privateKey)));
  const body = der.toString('base64').match(/.{1,64}/g).join('\n');
  return {
    ip,
    certificatePem: `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`,
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

function fingerprint(certificate) {
  return new crypto.X509Certificate(certificate.certificatePem).fingerprint256;
}

function servedFingerprint(port) {
  return new Promise((resolve, reject) => {
    const request = https.get({
      host: '127.0.0.1', port, agent: false, rejectUnauthorized: false, checkServerIdentity: () => undefined,
    }, (response) => {
      resolve(response.socket.getPeerCertificate().fingerprint256);
      response.resume();
    });
    request.on('error', reject);
  });
}

test('a bot serves https with the shared certificate and hot-swaps it when another process renews it', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-bot-tls-'));
  const saved = { shared: process.env.MONKY_TLS_DIR, state: process.env.MONKY_BOT_TLS_STATE_DIR, poll: AutoTlsService.PICKUP_INTERVAL_MS };
  process.env.MONKY_TLS_DIR = path.join(root, 'shared');
  process.env.MONKY_BOT_TLS_STATE_DIR = path.join(root, 'state');
  AutoTlsService.PICKUP_INTERVAL_MS = 40;
  fs.mkdirSync(process.env.MONKY_TLS_DIR, { recursive: true });
  t.after(() => {
    for (const [key, value] of [['MONKY_TLS_DIR', saved.shared], ['MONKY_BOT_TLS_STATE_DIR', saved.state]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    AutoTlsService.PICKUP_INTERVAL_MS = saved.poll;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const sharedFile = path.join(process.env.MONKY_TLS_DIR, 'certificate.json');
  const first = certificateFor(IP, Date.now() + 4 * DAY);
  fs.writeFileSync(sharedFile, JSON.stringify(first));

  const bot = createBotTls({ publicIp: async () => IP });
  t.after(() => bot.dispose());
  assert.equal(bot.status().enabled, false);
  assert.equal(bot.material(), null, 'nothing is served until the bot opts in');

  const changes = [];
  bot.onChange((change) => changes.push(change));
  const status = await bot.enable();
  assert.equal(bot.reusedSharedCertificate, true, 'the shared certificate is reused, the CA is never asked');
  assert.equal(status.active, true);
  assert.equal(status.ip, IP);
  assert.ok(fs.existsSync(path.join(root, 'state', 'settings.json')), 'the opt-in lives with this bot');

  const server = https.createServer(bot.material(), (_request, response) => response.end('ok'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const swapped = new Promise((resolve) => {
    bot.onChange(({ material }) => {
      if (!material) return;
      server.setSecureContext(material);
      if (material.cert !== first.certificatePem) resolve(material);
    });
  });
  bot.start();

  assert.equal(await servedFingerprint(port), fingerprint(first));

  const renewed = certificateFor(IP, Date.now() + 6 * DAY);
  fs.writeFileSync(sharedFile, JSON.stringify(renewed));
  await swapped;
  assert.equal(await servedFingerprint(port), fingerprint(renewed), 'new connections get the renewed certificate');
  assert.ok(changes.length >= 1);

  await bot.disable();
  assert.equal(bot.material(), null);
  assert.ok(fs.existsSync(sharedFile), 'turning it off here keeps the certificate for the others');
});
