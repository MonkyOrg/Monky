import { isIP } from 'node:net';

/**
 * The few DER encodings a certificate signing request needs (X.690). Only
 * what the ACME client writes; nothing here parses untrusted input.
 */

function encodeLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(content.length), content]);
}

export const sequence = (...items: Buffer[]): Buffer => tlv(0x30, Buffer.concat(items));
export const set = (...items: Buffer[]): Buffer => tlv(0x31, Buffer.concat(items));
export const octetString = (content: Buffer): Buffer => tlv(0x04, content);
/** A BIT STRING whose content is whole bytes. */
export const bitString = (content: Buffer): Buffer => tlv(0x03, Buffer.concat([Buffer.from([0]), content]));

export function smallInteger(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 0x7f) throw new RangeError('Only 0..127 is supported.');
  return tlv(0x02, Buffer.from([value]));
}

export function objectIdentifier(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number);
  const bytes = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const chunk = [part & 0x7f];
    for (let rest = part >>> 7; rest > 0; rest >>>= 7) chunk.unshift((rest & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

/** Network-order bytes of an IPv4 or IPv6 address, as `iPAddress` in a SAN carries it. */
export function ipAddressBytes(address: string): Buffer {
  const family = isIP(address);
  if (family === 4) return Buffer.from(address.split('.').map(Number));
  if (family !== 6) throw new Error(`Not an IP address: ${address}`);
  let text = address;
  let tail: number[] = [];
  const embedded = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (embedded) {
    const v4 = embedded[1].split('.').map(Number);
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    text = text.slice(0, -embedded[1].length) + '0:0';
  }
  const [head, rest] = text.split('::');
  const groups = (part: string | undefined): number[] => part ? part.split(':').map((group) => parseInt(group, 16)) : [];
  let words = rest === undefined ? groups(head) : (() => {
    const left = groups(head);
    const right = groups(rest);
    return [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right];
  })();
  if (tail.length) words = [...words.slice(0, 6), ...tail];
  const bytes = Buffer.alloc(16);
  words.forEach((word, index) => bytes.writeUInt16BE(word, index * 2));
  return bytes;
}
