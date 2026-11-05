import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, verify, X509Certificate, type JsonWebKey } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { test, type TestContext } from 'node:test';
import { WebSocket } from 'ws';
import type { AutoTlsStatus } from '@monky/shared';
import { MonkyServer } from './server';
import { Logger } from './infrastructure/logger/Logger';
import { closeHttpServer, listenHttpServer } from './infrastructure/lifecycle/httpLifecycle';
import { AcmeChallenges, AcmeClient, AutoTlsFailure, AutoTlsService, CertificateStore, FileLock, LetsEncryptIssuer, TlsSettingsStore, inspectCertificate, type CertificateIssuer, type IssuedCertificate } from '@monky/shared/dist/tls';
import { createIpCsr } from '@monky/shared/dist/tls/Csr';
import { ipAddressBytes } from '@monky/shared/dist/tls/der';
import { DualProtocolListener } from './infrastructure/tls/DualProtocolListener';
import { createTestCertificate, readCsr } from './testFixtures/certificates';

const DAY = 24 * 60 * 60 * 1000;
const PUBLIC_IP = '1.1.1.1';

function quiet(t: TestContext): void {
  t.mock.method(Logger, 'info', () => {});
  t.mock.method(Logger, 'warn', () => {});
}

function temporaryDirectory(t: TestContext): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-auto-tls-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await listenHttpServer(probe, 0, '127.0.0.1');
  const address = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  assert.ok(address && typeof address === 'object');
  return address.port;
}

const flush = async (rounds = 20): Promise<void> => {
  for (let index = 0; index < rounds; index++) await new Promise<void>((resolve) => setImmediate(resolve));
};

// ---------------------------------------------------------------------------
// A small ACME CA (RFC 8555) that checks what Let's Encrypt checks: signed
// requests, single-use nonces, the IP identifier, the profile and the HTTP-01
// answer fetched from the validation port.
// ---------------------------------------------------------------------------

interface FakeCaOptions {
  validationPort: number;
  rateLimitOrders?: boolean;
  badNonceOnce?: boolean;
}

async function startFakeCa(t: TestContext, options: FakeCaOptions) {
  const nonces = new Set<string>();
  let nonceCounter = 0;
  let badNonceSent = false;
  const accounts = new Map<string, JsonWebKey>();
  const orders: Array<{ ip: string; profile: unknown; status: string; authorization: string; certificate?: string }> = [];
  const authorizations = new Map<string, { order: number; token: string; status: string; error?: object }>();
  const certificates = new Map<string, string>();
  const requests: string[] = [];
  let base = '';

  const newNonce = () => {
    const nonce = `nonce-${++nonceCounter}`;
    nonces.add(nonce);
    return nonce;
  };
  const reply = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, {
      'replay-nonce': newNonce(),
      'content-type': typeof body === 'string' ? 'application/pem-certificate-chain' : status >= 400 ? 'application/problem+json' : 'application/json',
      ...headers,
    });
    res.end(text);
  };
  const problem = (res: http.ServerResponse, status: number, type: string, detail: string) =>
    reply(res, status, { type: `urn:ietf:params:acme:error:${type}`, detail });

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '/';
    requests.push(`${req.method} ${url}`);
    if (req.method === 'GET' && url === '/dir') {
      reply(res, 200, { newNonce: `${base}/nonce`, newAccount: `${base}/account`, newOrder: `${base}/order` });
      return;
    }
    if (req.method === 'HEAD' && url === '/nonce') {
      res.writeHead(200, { 'replay-nonce': newNonce() });
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const jws = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { protected: string; payload: string; signature: string };
    const header = JSON.parse(Buffer.from(jws.protected, 'base64url').toString('utf8')) as {
      alg: string; nonce: string; url: string; jwk?: JsonWebKey; kid?: string;
    };
    assert.equal(header.alg, 'ES256');
    assert.equal(header.url, `${base}${url}`, 'the signed URL is the one requested');
    if (options.badNonceOnce && !badNonceSent) {
      badNonceSent = true;
      problem(res, 400, 'badNonce', 'stale nonce');
      return;
    }
    if (!nonces.delete(header.nonce)) {
      problem(res, 400, 'badNonce', 'unknown nonce');
      return;
    }
    const jwk = header.jwk ?? (header.kid ? accounts.get(header.kid) : undefined);
    assert.ok(jwk, 'every request names its key');
    const signed = verify('sha256', Buffer.from(`${jws.protected}.${jws.payload}`), {
      key: createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363',
    }, Buffer.from(jws.signature, 'base64url'));
    assert.ok(signed, 'the request signature verifies');
    const payload: unknown = jws.payload ? JSON.parse(Buffer.from(jws.payload, 'base64url').toString('utf8')) : null;

    if (url === '/account') {
      assert.ok(header.jwk, 'a new account is signed with its JWK');
      // Like Let's Encrypt: a key already registered gets its existing account back.
      const known = [...accounts].find(([, key]) => key.x === header.jwk?.x && key.y === header.jwk?.y)?.[0];
      const kid = known ?? `${base}/acct/${accounts.size + 1}`;
      accounts.set(kid, header.jwk);
      reply(res, 201, { status: 'valid' }, { location: kid });
      return;
    }
    assert.ok(header.kid && accounts.has(header.kid), 'later requests use the account URL');
    if (url === '/order') {
      if (options.rateLimitOrders) {
        problem(res, 429, 'rateLimited', 'too many certificates for this IP');
        return;
      }
      const order = payload as { identifiers: Array<{ type: string; value: string }>; profile?: unknown };
      assert.deepEqual(order.identifiers.map((item) => item.type), ['ip']);
      const index = orders.length;
      const authorization = `${base}/authz/${index}`;
      orders.push({ ip: order.identifiers[0].value, profile: order.profile, status: 'pending', authorization });
      authorizations.set(authorization, { order: index, token: `token${index}abc`, status: 'pending' });
      reply(res, 201, { status: 'pending', authorizations: [authorization], finalize: `${base}/finalize/${index}` },
        { location: `${base}/orders/${index}` });
      return;
    }
    const authzMatch = /^\/authz\/(\d+)$/.exec(url);
    if (authzMatch) {
      const authz = authorizations.get(`${base}${url}`)!;
      reply(res, 200, {
        status: authz.status,
        challenges: [{ type: 'http-01', url: `${base}/challenge/${authzMatch[1]}`, token: authz.token,
          status: authz.status, ...(authz.error ? { error: authz.error } : {}) }],
      });
      return;
    }
    const challengeMatch = /^\/challenge\/(\d+)$/.exec(url);
    if (challengeMatch) {
      const authz = authorizations.get(`${base}/authz/${challengeMatch[1]}`)!;
      const thumbprint = createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest('base64url');
      let answer = '';
      try {
        const response = await fetch(`http://127.0.0.1:${options.validationPort}/.well-known/acme-challenge/${authz.token}`);
        answer = response.ok ? await response.text() : '';
      } catch {
        answer = '';
      }
      if (answer === `${authz.token}.${thumbprint}`) {
        authz.status = 'valid';
        orders[authz.order].status = 'ready';
      } else {
        authz.status = 'invalid';
        authz.error = { type: 'urn:ietf:params:acme:error:connection', detail: 'Connection refused' };
        orders[authz.order].status = 'invalid';
      }
      reply(res, 200, { type: 'http-01', status: 'processing', url: `${base}${url}`, token: authz.token });
      return;
    }
    const finalizeMatch = /^\/finalize\/(\d+)$/.exec(url);
    if (finalizeMatch) {
      const index = Number(finalizeMatch[1]);
      const order = orders[index];
      assert.equal(order.status, 'ready');
      const csr = readCsr(Buffer.from((payload as { csr: string }).csr, 'base64url'));
      const spki = createPublicKey({ key: csr.spki, format: 'der', type: 'spki' });
      assert.ok(verify('sha256', csr.info, spki, csr.signature), 'the CSR is signed by its own key');
      assert.deepEqual(csr.ipAddresses, [ipAddressBytes(order.ip)], 'the CSR names the ordered IP');
      const issued = createTestCertificate({ ip: order.ip, publicKey: spki, notBefore: Date.now() - 60_000, notAfter: Date.now() + 6 * DAY });
      const certificateUrl = `${base}/cert/${index}`;
      certificates.set(certificateUrl, issued.certificatePem);
      order.status = 'valid';
      order.certificate = certificateUrl;
      reply(res, 200, { status: 'processing', authorizations: [order.authorization], finalize: `${base}${url}` });
      return;
    }
    const orderMatch = /^\/orders\/(\d+)$/.exec(url);
    if (orderMatch) {
      const index = Number(orderMatch[1]);
      const order = orders[index];
      reply(res, 200, { status: order.status, authorizations: [order.authorization], finalize: `${base}/finalize/${index}`,
        ...(order.certificate ? { certificate: order.certificate } : {}),
        ...(order.status === 'invalid' ? { error: authorizations.get(order.authorization)?.error } : {}) });
      return;
    }
    if (url.startsWith('/cert/')) {
      reply(res, 200, certificates.get(`${base}${url}`)!);
      return;
    }
    problem(res, 404, 'malformed', `unknown ${url}`);
  });
  await listenHttpServer(server, 0, '127.0.0.1');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  base = `http://127.0.0.1:${address.port}`;
  t.after(() => closeHttpServer(server));
  return { directoryUrl: `${base}/dir`, orders, requests, accounts };
}

async function portIsFree(port: number): Promise<boolean> {
  const probe = net.createServer();
  try {
    await listenHttpServer(probe, port, '0.0.0.0');
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------

test('the CSR names one IP in its subjectAltName and is signed by its own key', () => {
  for (const ip of ['203.0.113.9', '2001:db8::1', '::ffff:1.2.3.4']) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const csr = readCsr(createIpCsr(ip, privateKey, publicKey));
    assert.ok(verify('sha256', csr.info, publicKey, csr.signature), `${ip}: signature verifies`);
    assert.deepEqual(csr.spki, publicKey.export({ type: 'spki', format: 'der' }));
    assert.deepEqual(csr.ipAddresses, [ipAddressBytes(ip)]);
  }
  assert.deepEqual([...ipAddressBytes('::ffff:1.2.3.4')], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 1, 2, 3, 4]);
  assert.deepEqual([...ipAddressBytes('2001:db8::1')], [0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
});

test('Let\'s Encrypt issuer: a short-lived certificate for the IP, validated on a port opened only meanwhile', async (t) => {
  const validationPort = await freePort();
  const ca = await startFakeCa(t, { validationPort, badNonceOnce: true });
  const store = new CertificateStore(temporaryDirectory(t));
  const issuer = new LetsEncryptIssuer({
    store, challenges: new AcmeChallenges(), serverPort: 1, directoryOverride: ca.directoryUrl, validationPort,
  });
  const issued = await issuer.issue(PUBLIC_IP, new AbortController().signal);
  const leaf = new X509Certificate(issued.certificatePem);
  assert.equal(leaf.checkIP(PUBLIC_IP), PUBLIC_IP);
  assert.ok(leaf.checkPrivateKey(createPrivateKey(issued.privateKeyPem)));
  assert.deepEqual(ca.orders.map((order) => [order.ip, order.profile, order.status]), [[PUBLIC_IP, 'shortlived', 'valid']]);
  assert.ok(await portIsFree(validationPort), 'the validation port closes after the order');

  await issuer.precheck(PUBLIC_IP, new AbortController().signal);
  assert.equal(ca.accounts.size, 1, 'the account key is kept and reused');
});

test('Let\'s Encrypt issuer: what goes wrong is told apart for the owner', async (t) => {
  const validationPort = await freePort();
  const challenges = new AcmeChallenges();
  const unreachableCa = await startFakeCa(t, { validationPort: await freePort() });
  const unreachable = new LetsEncryptIssuer({
    store: new CertificateStore(temporaryDirectory(t)), challenges, serverPort: 1,
    directoryOverride: unreachableCa.directoryUrl, validationPort,
  });
  await assert.rejects(unreachable.issue(PUBLIC_IP, new AbortController().signal),
    (error) => error instanceof AutoTlsFailure && error.code === 'unreachable');
  assert.ok(await portIsFree(validationPort), 'the validation port closes after a failure too');

  const limitedCa = await startFakeCa(t, { validationPort, rateLimitOrders: true });
  const limited = new LetsEncryptIssuer({
    store: new CertificateStore(temporaryDirectory(t)), challenges, serverPort: 1,
    directoryOverride: limitedCa.directoryUrl, validationPort,
  });
  await assert.rejects(limited.issue(PUBLIC_IP, new AbortController().signal),
    (error) => error instanceof AutoTlsFailure && error.code === 'rate-limited');

  const blocker = net.createServer();
  await listenHttpServer(blocker, validationPort, '0.0.0.0');
  t.after(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
  await assert.rejects(limited.issue(PUBLIC_IP, new AbortController().signal),
    (error) => error instanceof AutoTlsFailure && error.code === 'port-in-use');
});

test('the ACME thumbprint follows RFC 7638', () => {
  // RFC 7638 §3.1 uses an RSA key; the same canonical form applies to the EC members.
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const client = new AcmeClient({ directoryUrl: 'http://127.0.0.1/', accountKey: privateKey, signal: new AbortController().signal });
  const jwk = publicKey.export({ format: 'jwk' });
  const expected = createHash('sha256').update(`{"crv":"${jwk.crv}","kty":"EC","x":"${jwk.x}","y":"${jwk.y}"}`).digest('base64url');
  assert.equal(client.thumbprint(), expected);
});

// ---------------------------------------------------------------------------

async function startListener(t: TestContext) {
  const httpServer = http.createServer((req, res) => res.end(`${req.socket instanceof tls.TLSSocket ? 'tls' : 'plain'}`));
  const listener = new DualProtocolListener(httpServer);
  await listenHttpServer(listener.listener, 0, '127.0.0.1');
  t.after(async () => {
    await listener.close();
    await closeHttpServer(httpServer);
  });
  const address = listener.address();
  assert.ok(address && typeof address === 'object');
  return { httpServer, listener, port: address.port };
}

function peerCertificateOf(port: number): Promise<{ socket: tls.TLSSocket; fingerprint: string }> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] }, () => {
      resolve({ socket, fingerprint: socket.getPeerCertificate().fingerprint256 });
    });
    socket.once('error', reject);
  });
}

test('one port serves plain and TLS connections, and a new certificate never drops open ones', async (t) => {
  const { httpServer, listener, port } = await startListener(t);
  const plain = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(await plain.text(), 'plain');

  const refused = await new Promise<string>((resolve) => {
    const socket = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false });
    socket.once('secureConnect', () => resolve('connected'));
    socket.once('error', () => resolve('refused'));
    socket.once('close', () => resolve('refused'));
  });
  assert.equal(refused, 'refused', 'without a certificate a TLS handshake is refused');

  const first = createTestCertificate({ ip: '127.0.0.1', notBefore: Date.now() - DAY, notAfter: Date.now() + 6 * DAY });
  const second = createTestCertificate({ ip: '127.0.0.1', notBefore: Date.now() - DAY, notAfter: Date.now() + 6 * DAY });
  listener.setSecureContext(tls.createSecureContext({ cert: first.certificatePem, key: first.privateKeyPem }));

  const wss = new (await import('ws')).WebSocketServer({ server: httpServer });
  t.after(() => new Promise<void>((resolve) => wss.close(() => resolve())));
  wss.on('connection', (socket) => socket.on('message', (data) => socket.send(`echo:${String(data)}`)));
  const ca = first.certificatePem;
  const secureSocket = new WebSocket(`wss://127.0.0.1:${port}/`, { ca });
  await once(secureSocket, 'open');
  const plainSocket = new WebSocket(`ws://127.0.0.1:${port}/`);
  await once(plainSocket, 'open');

  const before = await peerCertificateOf(port);
  listener.setSecureContext(tls.createSecureContext({ cert: second.certificatePem, key: second.privateKeyPem }));
  const after = await peerCertificateOf(port);
  before.socket.destroy();
  after.socket.destroy();
  assert.notEqual(before.fingerprint, after.fingerprint, 'new connections get the new certificate');
  assert.equal(after.fingerprint, new X509Certificate(second.certificatePem).fingerprint256);

  secureSocket.send('still here');
  const [reply] = await once(secureSocket, 'message');
  assert.equal(String(reply), 'echo:still here', 'the connection opened before the swap keeps working');
  plainSocket.send('plain');
  assert.equal(String((await once(plainSocket, 'message'))[0]), 'echo:plain');
  secureSocket.close();
  plainSocket.close();

  listener.setSecureContext(null);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'plain', 'turning TLS off keeps ws:// working');
});

test('a connection that never speaks is dropped', async (t) => {
  const timeout = DualProtocolListener.FIRST_BYTE_TIMEOUT_MS;
  DualProtocolListener.FIRST_BYTE_TIMEOUT_MS = 50;
  t.after(() => { DualProtocolListener.FIRST_BYTE_TIMEOUT_MS = timeout; });
  const { port } = await startListener(t);
  const socket = net.connect(port, '127.0.0.1');
  await once(socket, 'connect');
  await once(socket, 'close');
});

// ---------------------------------------------------------------------------

class FakeIssuer implements CertificateIssuer {
  public prechecks: string[] = [];
  public issues: string[] = [];
  public failure: AutoTlsFailure | null = null;
  public precheckFailure: AutoTlsFailure | null = null;
  public lifetimeMs = 6 * DAY;

  async precheck(ip: string): Promise<void> {
    this.prechecks.push(ip);
    if (this.precheckFailure) {
      const failure = this.precheckFailure;
      this.precheckFailure = null;
      throw failure;
    }
  }

  async issue(ip: string): Promise<IssuedCertificate> {
    this.issues.push(ip);
    if (this.failure) throw this.failure;
    return createTestCertificate({ ip, notBefore: Date.now() - 60_000, notAfter: Date.now() + this.lifetimeMs });
  }
}

function service(t: TestContext, directory: string, issuer: FakeIssuer, ip: { value: string | null }) {
  const installs: Array<tls.SecureContext | null> = [];
  const grants: number[] = [];
  const store = new CertificateStore(path.join(directory, 'shared'));
  const instance = new AutoTlsService({
    store,
    settings: new TlsSettingsStore(path.join(directory, 'tls')),
    legacyDirectory: path.join(directory, 'tls'),
    issuer,
    publicIp: async () => ip.value,
    install: (context) => installs.push(context),
    grantPortPermission: async () => { grants.push(Date.now()); },
  });
  t.after(() => instance.dispose());
  return { instance, installs, grants, store };
}

test('automatic TLS turns on only after the CA proved it reaches the host', async (t) => {
  quiet(t);
  const directory = temporaryDirectory(t);
  const issuer = new FakeIssuer();
  const ip: { value: string | null } = { value: PUBLIC_IP };
  const { instance, installs, grants } = service(t, directory, issuer, ip);

  issuer.precheckFailure = new AutoTlsFailure('unreachable', 'port 80 closed');
  await assert.rejects(instance.enable(), (error) => error instanceof AutoTlsFailure && error.code === 'unreachable');
  assert.equal(instance.status().enabled, false, 'a closed port blocks activation');
  assert.deepEqual(issuer.issues, [], 'nothing is issued for real');
  assert.deepEqual(installs, []);

  issuer.precheckFailure = new AutoTlsFailure('port-permission');
  await assert.rejects(instance.enable(), (error) => error instanceof AutoTlsFailure && error.code === 'port-permission');
  assert.deepEqual(grants, [], 'the port restriction is only lifted with consent');

  issuer.precheckFailure = new AutoTlsFailure('port-permission');
  const status = await instance.enable({ grantPortPermission: true });
  assert.equal(grants.length, 1);
  assert.equal(status.enabled, true);
  assert.equal(status.busy, false, 'the returned status is the one after the work');
  assert.equal(status.active, true);
  assert.equal(status.ip, PUBLIC_IP);
  assert.equal(instance.secureAddress(), PUBLIC_IP);
  assert.ok(installs.at(-1));
  assert.ok(status.validUntil && status.nextRenewalAt && status.validUntil - status.nextRenewalAt === AutoTlsService.RENEW_BEFORE_MS);

  ip.value = '10.0.0.5';
  const restarted = service(t, directory, new FakeIssuer(), ip);
  assert.equal(restarted.instance.status().enabled, true, 'the choice survives a restart');

  const disabled = await instance.disable();
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.active, false);
  assert.equal(installs.at(-1), null, 'turning it off leaves ws:// only');
  assert.equal(fs.existsSync(path.join(directory, 'shared', 'certificate.json')), true, 'the certificate stays shared for the others');

  ip.value = '192.168.0.10';
  await assert.rejects(instance.enable(), (error) => error instanceof AutoTlsFailure && error.code === 'address-not-public');
  ip.value = null;
  await assert.rejects(instance.enable(), (error) => error instanceof AutoTlsFailure && error.code === 'no-public-ip');
});

test('renewal: ahead of expiry, with retries, ws:// only after expiry, and a new certificate when the IP changes', async (t) => {
  quiet(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2030, 0, 1) });
  const directory = temporaryDirectory(t);
  const issuer = new FakeIssuer();
  const ip: { value: string | null } = { value: PUBLIC_IP };
  const { instance, installs } = service(t, directory, issuer, ip);
  const changes: AutoTlsStatus[] = [];
  instance.subscribe((status) => changes.push(status));

  const enabled = await instance.enable();
  const renewAt = enabled.nextRenewalAt!;
  assert.equal(issuer.issues.length, 1);

  // Hourly checks with the same IP issue nothing.
  t.mock.timers.tick(3 * 60 * 60 * 1000);
  await flush();
  assert.equal(issuer.issues.length, 1);

  // Renewal starts two days ahead and fails: the old certificate stays.
  issuer.failure = new AutoTlsFailure('network', 'CA down');
  t.mock.timers.setTime(renewAt);
  t.mock.timers.tick(0);
  await flush();
  assert.equal(issuer.issues.length, 2);
  assert.equal(instance.status().active, true, 'the current certificate keeps serving');
  assert.equal(instance.status().lastError?.code, 'network', 'the owner is told');
  t.mock.timers.tick(AutoTlsService.RETRY_DELAYS_MS[0]);
  await flush();
  assert.equal(issuer.issues.length, 3, 'it tries again');

  // Still failing at expiry: TLS goes off, ws:// keeps working.
  const installsBeforeExpiry = installs.length;
  for (let index = 0; index < 40 && instance.status().active; index++) {
    t.mock.timers.tick(6 * 60 * 60 * 1000);
    await flush();
  }
  assert.equal(instance.status().active, false);
  assert.equal(installs.length, installsBeforeExpiry + 1);
  assert.equal(installs.at(-1), null);
  assert.equal(instance.status().enabled, true, 'it stays on and keeps trying');

  // The CA is back: a certificate is issued again and the error clears.
  issuer.failure = null;
  t.mock.timers.tick(6 * 60 * 60 * 1000);
  await flush();
  assert.equal(instance.status().active, true);
  assert.equal(instance.status().lastError, null);

  // A new public IP gets its own certificate at the next hourly check.
  ip.value = '8.8.4.4';
  t.mock.timers.tick(AutoTlsService.IP_CHECK_INTERVAL_MS);
  await flush();
  assert.equal(issuer.issues.at(-1), '8.8.4.4');
  assert.equal(instance.secureAddress(), '8.8.4.4');
  assert.ok(changes.some((status) => status.busy), 'listeners see the work in progress');

  const issued = issuer.issues.length;
  instance.dispose();
  instance.dispose();
  t.mock.timers.tick(7 * DAY);
  await flush();
  assert.equal(issuer.issues.length, issued, 'nothing runs after dispose');
});

test('a restarted server serves its saved certificate at once', async (t) => {
  quiet(t);
  const directory = temporaryDirectory(t);
  const ip: { value: string | null } = { value: PUBLIC_IP };
  const first = service(t, directory, new FakeIssuer(), ip);
  await first.instance.enable();
  first.instance.dispose();

  const issuer = new FakeIssuer();
  const second = service(t, directory, issuer, ip);
  second.instance.start();
  assert.equal(second.instance.status().active, true);
  assert.ok(second.installs[0]);
  await flush();
  assert.deepEqual(issuer.issues, [], 'a valid certificate is not issued again');
});

// ---------------------------------------------------------------------------

function savedCertificate(ip: string, notAfterFromNow: number) {
  const issued = createTestCertificate({ ip, notBefore: Date.now() - 60_000, notAfter: Date.now() + notAfterFromNow });
  return inspectCertificate(ip, issued.certificatePem, issued.privateKeyPem);
}

test('shared certificate: a valid one is reused without asking the CA', async (t) => {
  const directory = temporaryDirectory(t);
  const ip: { value: string | null } = { value: PUBLIC_IP };
  const { instance, installs, store } = service(t, directory, new FakeIssuer(), ip);
  const shared = savedCertificate(PUBLIC_IP, 5 * DAY);
  store.writeCertificate(shared);
  const issuer = new FakeIssuer();
  const other = service(t, directory, issuer, ip);

  const status = await other.instance.enable();
  assert.equal(other.instance.reusedSharedCertificate, true);
  assert.equal(status.active, true);
  assert.equal(status.validUntil, shared.notAfter);
  assert.deepEqual([issuer.prechecks, issuer.issues], [[], []]);
  assert.ok(other.installs.at(-1));
  assert.equal(installs.length, 0);
  assert.equal(instance.status().enabled, false, 'each process opts in on its own');
});

test('shared certificate: issued once when absent, then every process reuses it', async (t) => {
  const directory = temporaryDirectory(t);
  const ip: { value: string | null } = { value: PUBLIC_IP };
  const first = new FakeIssuer();
  const a = service(t, directory, first, ip);
  await a.instance.enable();
  assert.equal(a.instance.reusedSharedCertificate, false);
  assert.deepEqual([first.prechecks.length, first.issues.length], [1, 1]);
  assert.equal(a.store.findUsable(PUBLIC_IP)?.ip, PUBLIC_IP);

  const second = new FakeIssuer();
  const b = service(t, path.join(directory, 'other-process'), second, ip);
  const sharedStore = new CertificateStore(path.join(directory, 'shared'));
  assert.ok(sharedStore.findUsable(PUBLIC_IP));
  const c = new AutoTlsService({
    store: sharedStore, settings: new TlsSettingsStore(path.join(directory, 'another-tls')),
    issuer: second, publicIp: async () => ip.value, install: () => {},
  });
  t.after(() => c.dispose());
  await c.enable();
  assert.equal(c.reusedSharedCertificate, true);
  assert.deepEqual(second.issues, []);
  assert.equal(b.instance.status().enabled, false);
});

test('shared certificate: an expired one or one for another IP is not trusted', async (t) => {
  const directory = temporaryDirectory(t);
  const ip: { value: string | null } = { value: PUBLIC_IP };
  const issuer = new FakeIssuer();
  const { instance, store } = service(t, directory, issuer, ip);

  store.writeCertificate(savedCertificate(PUBLIC_IP, -1000));
  assert.equal(store.findUsable(PUBLIC_IP), null, 'expired');
  store.writeCertificate(savedCertificate('8.8.8.8', 5 * DAY));
  assert.equal(store.findUsable(PUBLIC_IP), null, 'another IP');

  await instance.enable();
  assert.equal(instance.reusedSharedCertificate, false);
  assert.deepEqual(issuer.issues, [PUBLIC_IP]);
  assert.equal(store.findUsable(PUBLIC_IP)?.ip, PUBLIC_IP, 'the new certificate replaces the stale one');

  const damaged = savedCertificate(PUBLIC_IP, 5 * DAY);
  fs.writeFileSync(store.file('certificate.json'), JSON.stringify({ ip: PUBLIC_IP, certificatePem: damaged.certificatePem, privateKeyPem: 'nope' }));
  assert.equal(store.readCertificate(), null, 'a mismatched pair is ignored');
});

test('shared certificate: a server\'s own certificate from before sharing is adopted once', async (t) => {
  const directory = temporaryDirectory(t);
  const ip: { value: string | null } = { value: PUBLIC_IP };
  const legacy = savedCertificate(PUBLIC_IP, 5 * DAY);
  fs.mkdirSync(path.join(directory, 'tls'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'tls', 'certificate.json'), JSON.stringify(legacy));
  fs.writeFileSync(path.join(directory, 'tls', 'settings.json'), JSON.stringify({ enabled: true, lastError: null }));

  const issuer = new FakeIssuer();
  const { instance, installs, store } = service(t, directory, issuer, ip);
  assert.equal(store.readCertificate()?.certificatePem, legacy.certificatePem, 'copied into the shared folder');
  instance.start();
  assert.equal(instance.status().active, true, 'the opt-in is kept');
  assert.ok(installs[0]);
  await flush();
  assert.deepEqual(issuer.issues, []);

  await instance.disable();
  assert.equal(fs.existsSync(path.join(directory, 'tls', 'certificate.json')), false, 'the per-server copy is gone');
  assert.ok(store.readCertificate(), 'the shared one remains');

  const newer = savedCertificate(PUBLIC_IP, 6 * DAY);
  store.writeCertificate(newer);
  fs.writeFileSync(path.join(directory, 'tls', 'certificate.json'), JSON.stringify(legacy));
  const again = service(t, directory, issuer, ip);
  assert.equal(again.store.readCertificate()?.certificatePem, newer.certificatePem, 'a valid shared certificate is not overwritten');
});

test('shared certificate: while another process renews, this one waits and picks up the result', async (t) => {
  quiet(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2030, 0, 1) });
  const directory = temporaryDirectory(t);
  const ip: { value: string | null } = { value: PUBLIC_IP };
  const issuer = new FakeIssuer();
  const { instance, installs, store } = service(t, directory, issuer, ip);
  const enabled = await instance.enable();
  assert.equal(issuer.issues.length, 1);
  const installsBefore = installs.length;

  t.mock.timers.setTime(enabled.nextRenewalAt!);
  const otherProcess = new FileLock(store.file('renew.lock'));
  const release = otherProcess.tryAcquire();
  assert.ok(release, 'another process is renewing');

  t.mock.timers.tick(0);
  await flush();
  assert.equal(issuer.issues.length, 1, 'the lock keeps this process from renewing too');
  assert.equal(instance.status().lastError, null, 'waiting is not a failure');

  const renewed = savedCertificate(PUBLIC_IP, 6 * DAY);
  store.writeCertificate(renewed);
  release();
  instance.syncFromDisk();
  assert.equal(instance.status().validUntil, renewed.notAfter, 'the renewed certificate is served');
  assert.equal(installs.length, installsBefore + 1);
  assert.equal(issuer.issues.length, 1);

  t.mock.timers.tick(AutoTlsService.LOCK_RETRY_MS);
  await flush();
  assert.equal(issuer.issues.length, 1, 'nothing left to renew');
});

test('shared certificate: the lock is released after issuing and a dead holder does not block', async (t) => {
  const directory = temporaryDirectory(t);
  const lock = new FileLock(path.join(directory, 'renew.lock'));
  const first = lock.tryAcquire();
  assert.ok(first);
  assert.equal(new FileLock(path.join(directory, 'renew.lock')).tryAcquire(), null);
  first();
  const second = lock.tryAcquire();
  assert.ok(second);
  second();

  fs.writeFileSync(path.join(directory, 'renew.lock'), JSON.stringify({ id: 'x', pid: 2 ** 22 - 3, at: Date.now() }));
  const taken = new FileLock(path.join(directory, 'renew.lock')).tryAcquire();
  assert.ok(taken, 'a lock whose process is gone is taken over');
  taken();
});

test('a hosted server turns on wss:// on its own port and the invitation marks the secure address', async (t) => {
  quiet(t);
  const validationPort = await freePort();
  const ca = await startFakeCa(t, { validationPort });
  const saved = { ...process.env };
  t.after(() => {
    for (const key of ['MONKY_ACME_DIRECTORY', 'MONKY_ACME_HTTP_PORT', 'MONKY_ACME_PUBLIC_IP']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  process.env.MONKY_ACME_DIRECTORY = ca.directoryUrl;
  process.env.MONKY_ACME_HTTP_PORT = String(validationPort);
  process.env.MONKY_ACME_PUBLIC_IP = PUBLIC_IP;

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-auto-tls-server-'));
  process.env.MONKY_TLS_DIR = path.join(dataDir, 'shared-tls');
  t.after(() => { delete process.env.MONKY_TLS_DIR; });
  const server = await MonkyServer.create({ port: 0, dataDir, serverName: 'TLS fixture' });
  t.after(async () => {
    await server.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  t.mock.method(server['lanBroadcaster'], 'start', async () => {});
  const listener = server['listener'].listener;
  const nativeListen = listener.listen.bind(listener);
  t.mock.method(listener, 'listen', (_port: number, _host: string) => nativeListen(0, '127.0.0.1'));
  await server.start();
  const { port } = await server.getStats();

  assert.equal(server.getAutoTlsStatus().enabled, false);
  const status = await server.enableAutoTls();
  assert.equal(status.active, true);
  assert.deepEqual(ca.orders.map((order) => order.profile), ['shortlived', 'shortlived'], 'staging precheck, then the real one');

  const certificate = JSON.parse(fs.readFileSync(path.join(dataDir, 'shared-tls', 'certificate.json'), 'utf8')) as { certificatePem: string };
  // The certificate names the stand-in public IP, so only the chain is checked over loopback.
  const handshake = tls.connect({ host: '127.0.0.1', port, ca: certificate.certificatePem, checkServerIdentity: () => undefined });
  await once(handshake, 'secureConnect');
  assert.equal(handshake.authorized, true, 'the issued certificate is served on the server port');
  handshake.destroy();
  const secure = new WebSocket(`wss://127.0.0.1:${port}/`, { rejectUnauthorized: false });
  await once(secure, 'open');
  secure.close();
  const plain = new WebSocket(`ws://127.0.0.1:${port}/`);
  await once(plain, 'open');
  plain.close();

  const invite = await (await fetch(`http://127.0.0.1:${port}/invite-info`)).json() as { networkInterfaces: Array<{ address: string; secure?: true }> };
  assert.deepEqual(invite.networkInterfaces.filter((item) => item.secure).map((item) => item.address), [PUBLIC_IP]);
});
