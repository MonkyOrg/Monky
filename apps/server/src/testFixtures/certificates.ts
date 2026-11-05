import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import {
  ipAddressBytes, objectIdentifier, octetString, sequence, set, smallInteger, tlv, bitString,
} from '@monky/shared/dist/tls/der';

/** Test-only X.509 and DER helpers for automatic TLS (#860). */

export interface TestCertificate {
  certificatePem: string;
  privateKeyPem: string;
}

function time(ms: number): Buffer {
  const iso = new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/[-:T]/g, '').replace('.000', '');
  const year = new Date(ms).getUTCFullYear();
  return year < 2050 ? tlv(0x17, Buffer.from(iso.slice(2), 'ascii')) : tlv(0x18, Buffer.from(iso, 'ascii'));
}

function pem(label: string, der: Buffer): string {
  const body = der.toString('base64').match(/.{1,64}/g)?.join('\n') ?? '';
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

/** A certificate for `ip`, signed by its own key, valid between the given instants. */
export function createTestCertificate(options: {
  ip: string; notBefore: number; notAfter: number; publicKey?: KeyObject; commonName?: string;
}): TestCertificate {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const subjectKey = options.publicKey ?? publicKey;
  const name = sequence(set(sequence(objectIdentifier('2.5.4.3'), tlv(0x0c, Buffer.from(options.commonName ?? 'Monky test', 'utf8')))));
  const algorithm = sequence(objectIdentifier('1.2.840.10045.4.3.2'));
  const san = sequence(tlv(0x87, ipAddressBytes(options.ip)));
  const tbs = sequence(
    tlv(0xa0, smallInteger(2)),
    tlv(0x02, Buffer.concat([Buffer.from([0x01]), randomBytes(8)])),
    algorithm,
    name,
    sequence(time(options.notBefore), time(options.notAfter)),
    name,
    subjectKey.export({ type: 'spki', format: 'der' }),
    tlv(0xa3, sequence(sequence(objectIdentifier('2.5.29.17'), octetString(san)))),
  );
  const certificate = sequence(tbs, algorithm, bitString(sign('sha256', tbs, privateKey)));
  return {
    certificatePem: pem('CERTIFICATE', certificate),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

export interface DerNode {
  tag: number;
  /** The whole element, header included. */
  raw: Buffer;
  content: Buffer;
}

/** The elements directly inside `content`. */
export function derChildren(content: Buffer): DerNode[] {
  const nodes: DerNode[] = [];
  let offset = 0;
  while (offset < content.length) {
    const tag = content[offset];
    let length = content[offset + 1];
    let header = 2;
    if (length & 0x80) {
      const count = length & 0x7f;
      length = 0;
      for (let index = 0; index < count; index++) length = (length << 8) | content[offset + 2 + index];
      header += count;
    }
    const end = offset + header + length;
    nodes.push({ tag, raw: content.subarray(offset, end), content: content.subarray(offset + header, end) });
    offset = end;
  }
  return nodes;
}

/** The pieces of a PKCS#10 request a CA looks at. */
export function readCsr(der: Buffer): { info: Buffer; spki: Buffer; signature: Buffer; ipAddresses: Buffer[] } {
  const [request] = derChildren(der);
  const [info, , signature] = derChildren(request.content);
  const [, , spki, attributes] = derChildren(info.content);
  const ipAddresses: Buffer[] = [];
  for (const attribute of derChildren(attributes.content)) {
    const [, values] = derChildren(attribute.content);
    for (const extensions of derChildren(values.content)) {
      for (const extension of derChildren(extensions.content)) {
        const [, value] = derChildren(extension.content);
        const [names] = derChildren(value.content);
        for (const name of derChildren(names.content)) if (name.tag === 0x87) ipAddresses.push(name.content);
      }
    }
  }
  return { info: info.raw, spki: spki.raw, signature: signature.content.subarray(1), ipAddresses };
}
