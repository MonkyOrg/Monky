import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IDENTIFIER = /^[A-Z][A-Z0-9_]*$/;

function entries(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object.`);
  }
  const result = Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  if (result.length === 0) throw new TypeError(`${name} must not be empty.`);
  for (const [key] of result) {
    if (!IDENTIFIER.test(key)) throw new TypeError(`Invalid native contract identifier: ${key}`);
  }
  return result;
}

function stringConstants(values, name) {
  return entries(values, name).map(([key, value]) => {
    if (typeof value !== 'string' || !/^[\x20-\x7e]+$/.test(value)) {
      throw new TypeError(`${name}.${key} must be a nonempty printable ASCII string.`);
    }
    return `inline constexpr std::string_view ${key} = ${JSON.stringify(value)};`;
  });
}

export function nativeProtocolHeader({ version, messageTypes, errorCodes, limits, reconnectDelays }) {
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new TypeError('Protocol version must be a positive safe integer.');
  }
  if (!Array.isArray(reconnectDelays) || reconnectDelays.length === 0 ||
      reconnectDelays.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError('Reconnect delays must be a nonempty array of nonnegative safe integers.');
  }

  const messages = stringConstants(messageTypes, 'MessageType');
  const errors = stringConstants(errorCodes, 'ProtocolErrorCode');
  const sharedLimits = entries(limits, 'LIMITS').map(([key, value]) => {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new TypeError(`LIMITS.${key} must be a finite number without an unsafe integer.`);
    }
    return Number.isInteger(value)
      ? `inline constexpr std::int64_t ${key} = ${value}LL;`
      : `inline constexpr double ${key} = ${value};`;
  });

  return [
    '// Generated from @monky/shared by scripts/generate-light-contracts.js. Do not edit.',
    '#pragma once',
    '',
    '#include <array>',
    '#include <cstdint>',
    '#include <string_view>',
    '',
    'namespace monky::protocol {',
    `inline constexpr std::int64_t VERSION = ${version}LL;`,
    `inline constexpr std::array<std::int64_t, ${reconnectDelays.length}> RECONNECT_DELAYS_MS = {${reconnectDelays.map((value) => `${value}LL`).join(', ')}};`,
    '',
    'namespace message {',
    ...messages,
    '}',
    '',
    'namespace error {',
    ...errors,
    '}',
    '',
    'namespace limits {',
    ...sharedLimits,
    '}',
    '}',
    '',
  ].join('\n');
}

export async function writeNativeProtocol(output) {
  const constantsUrl = pathToFileURL(path.join(ROOT, 'packages', 'shared', 'dist', 'constants.js'));
  const protocolUrl = pathToFileURL(path.join(ROOT, 'packages', 'shared', 'dist', 'protocol.js'));
  const [{ PROTOCOL_VERSION, LIMITS, RECONNECT_DELAYS_MS }, { MessageType, ProtocolErrorCode }] = await Promise.all([
    import(constantsUrl.href),
    import(protocolUrl.href),
  ]);
  const header = nativeProtocolHeader({
    version: PROTOCOL_VERSION,
    messageTypes: MessageType,
    errorCodes: ProtocolErrorCode,
    limits: LIMITS,
    reconnectDelays: RECONNECT_DELAYS_MS,
  });

  let previous = null;
  try {
    previous = await readFile(output, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  // Preserve timestamps when tsc rewrites an unchanged shared package.
  if (previous === header) return false;
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, header, 'utf8');
  return true;
}

async function main(args) {
  if (args.length !== 2 || args[0] !== '--output' || !args[1] || args[1].startsWith('--')) {
    throw new Error('Usage: node scripts/generate-light-contracts.js --output <protocol.hpp>');
  }
  await writeNativeProtocol(path.resolve(args[1]));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
