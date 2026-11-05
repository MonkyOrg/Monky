import { sign, type KeyObject } from 'node:crypto';
import { bitString, ipAddressBytes, objectIdentifier, octetString, sequence, set, smallInteger, tlv } from './der';

const ECDSA_WITH_SHA256 = '1.2.840.10045.4.3.2';
const EXTENSION_REQUEST = '1.2.840.113549.1.9.14';
const SUBJECT_ALT_NAME = '2.5.29.17';
/** `[7] IMPLICIT OCTET STRING`: GeneralName's iPAddress choice. */
const GENERAL_NAME_IP = 0x87;
/** `[0] IMPLICIT SET`: the attributes of a CertificationRequestInfo. */
const ATTRIBUTES = 0xa0;

/**
 * PKCS#10 request (RFC 2986) for one IP address, signed with an ECDSA P-256
 * key. The subject stays empty: the CA reads the address from the
 * subjectAltName, the only place an IP certificate may name it.
 */
export function createIpCsr(ip: string, privateKey: KeyObject, publicKey: KeyObject): Buffer {
  const subjectAltName = sequence(tlv(GENERAL_NAME_IP, ipAddressBytes(ip)));
  const extensions = sequence(sequence(objectIdentifier(SUBJECT_ALT_NAME), octetString(subjectAltName)));
  const info = sequence(
    smallInteger(0),
    sequence(),
    publicKey.export({ type: 'spki', format: 'der' }),
    tlv(ATTRIBUTES, sequence(objectIdentifier(EXTENSION_REQUEST), set(extensions))),
  );
  const signature = sign('sha256', info, privateKey);
  return sequence(info, sequence(objectIdentifier(ECDSA_WITH_SHA256)), bitString(signature));
}
