const assert = require('node:assert/strict');
const { createPublicKey, generateKeyPairSync, randomBytes, sign, verify } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { createInterface } = require('node:readline');
const { test } = require('node:test');
const { memberAuthChallenge, serverAuthChallenge } = require('@monky/shared');
const { nativeExecutable } = require('./native_test_paths.cjs');

const executable = process.env.MONKY_LIGHT_IDENTITY_TEST_BIN || nativeExecutable('monky-light-identity-test');

test('native identity key scenarios remain active in Release builds', () => {
  const result = spawnSync(executable, [], {
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 64 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('native nonce signatures verify with the server crypto implementation', { timeout: 20_000 }, async (t) => {
  const child = spawn(executable, ['--signing-fixture'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let diagnostic = '';
  let inputError;
  child.stdin.on('error', (error) => { inputError = error; });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (data) => { diagnostic = (diagnostic + data).slice(-8192); });
  const closed = new Promise((resolve) => {
    child.once('error', (error) => resolve({ error }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const reader = createInterface({ input: child.stdout });
  const lines = reader[Symbol.asyncIterator]();
  t.after(() => {
    reader.close();
    child.stdin.destroy();
    if (child.exitCode === null) child.kill();
  });
  async function line() {
    const result = await lines.next();
    assert.ifError(inputError);
    assert.equal(result.done, false, diagnostic || 'Native signing fixture closed before replying');
    return result.value;
  }

  const publicHex = await line();
  assert.match(publicHex, /^302a300506032b6570032100[0-9a-f]{64}$/);
  const publicKey = createPublicKey({ key: Buffer.from(publicHex, 'hex'), format: 'der', type: 'spki' });
  assert.equal(publicKey.asymmetricKeyType, 'ed25519');

  const nonce = randomBytes(32);
  child.stdin.write(`${nonce.toString('hex')}\n`);
  const signatureHex = await line();
  assert.match(signatureHex, /^[0-9a-f]{128}$/);
  const signature = Buffer.from(signatureHex, 'hex');
  assert.equal(verify(null, nonce, publicKey, signature), true);
  assert.equal(verify(null, Buffer.from(nonce.toString('hex')), publicKey, signature), false);
  const altered = Buffer.from(nonce);
  altered[0] ^= 1;
  assert.equal(verify(null, altered, publicKey, signature), false);

  child.stdin.write(`${nonce.toString('hex').toUpperCase()}\n`);
  assert.equal(await line(), signatureHex);

  // server-key-auth (#821): the bytes the native client signs are the ones the server verifies.
  const server = generateKeyPairSync('ed25519');
  const serverKey = server.publicKey.export({ format: 'der', type: 'spki' }).toString('hex');
  const nonceHex = nonce.toString('hex');
  child.stdin.write(`${nonceHex} ${serverKey}\n`);
  const bound = Buffer.from(await line(), 'hex');
  assert.equal(verify(null, Buffer.from(memberAuthChallenge(nonceHex, serverKey), 'utf8'), publicKey, bound), true);
  assert.equal(verify(null, nonce, publicKey, bound), false, 'A bound signature must not answer a bare-nonce challenge');
  const proof = sign(null, Buffer.from(serverAuthChallenge(nonceHex, serverKey), 'utf8'), server.privateKey).toString('hex');
  child.stdin.write(`verify ${nonceHex} ${serverKey} ${proof}\n`);
  assert.equal(await line(), '1', 'A server proof made by the server implementation must verify natively');
  const otherNonce = randomBytes(32).toString('hex');
  child.stdin.write(`verify ${otherNonce} ${serverKey} ${proof}\n`);
  assert.equal(await line(), '0', 'A proof for another challenge must not verify');
  child.stdin.end();
  const result = await closed;
  assert.ifError(inputError);
  assert.ifError(result.error);
  assert.equal(result.code, 0, diagnostic);
  assert.equal(result.signal, null);
});
