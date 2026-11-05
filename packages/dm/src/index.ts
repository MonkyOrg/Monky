/**
 * Friends and end-to-end encrypted direct messages (#743): one engine for the
 * desktop app and the web version (#858). The host installs the crypto
 * primitives (`installDmCrypto`) and gives each identity a store.
 */
export { afterCurrentTask, dmCrypto, installDmCrypto, type DmCryptoBackend, type DmFileReader, type DmFileStore, type DmGcmSealer, type DmHash } from './backend';
export * from './bytes';
export {
  DM_ENVELOPE_VERSION, DmCryptoError, DmKeyring, canonicalJson, createSha256, isIdentityPublicKey, newDmId,
  normalizeIdentityKey, openAtRest, sealAtRest, sealAtRestStream, sha256Hex, verifyDmCertificate, verifyDmStatement,
  type DmEnvelopeHeader, type DmEnvelopeRoute, type DmKeyCertificate, type OpenedEnvelope,
} from './dmCrypto';
export { DmFriends } from './dmFriends';
export { DmHistory, monthOf } from './dmHistory';
export { DmLedger } from './dmLedger';
export * from './dmModel';
export { DmOutbox, OUTBOX_MESSAGE_TTL_MS } from './dmOutbox';
export { DmPersistence } from './dmPersistence';
export { DmService, DM_DOWNLOAD_STALL_MS, DM_FILE_CHUNK_BYTES, DM_FILE_TRANSFER_IDLE_MS, type DmServiceOptions } from './dmService';
export { parseWireMessage, storedMessage, toWireMessage } from './dmWire';
