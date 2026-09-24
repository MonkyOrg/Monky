import path from 'path';
import { Permission } from '@monky/shared';

export const EXPORT_PREFIX = 'MONKY-ID:';
export const PBKDF2_ITERATIONS = 210_000;
export const DEFAULT_DATA_INPUT = './data';
export const DEFAULT_DATA_DIR = path.resolve(process.cwd(), 'data');
export const DEFAULT_OWNER_NICKNAME = 'Owner';
export const DEFAULT_SERVER_NAME = 'Servidor dos Amigos';
export const DEFAULT_BOOTSTRAP_PORT = 3000;
export const SERVER_DB_NAME = 'server.db';

export const CONFIG_KEYS = [
  'name',
  'password',
  'port',
  'icon',
  'maxUsers',
  'maxMessageLength',
  'allowSoundboard',
  'allowEveryoneMention',
  'showRoleBadgesToEveryone',
  'voiceMode',
  'maxAttachmentFileBytes',
  'maxAttachmentStorageBytes',
  'autoUpdate',
  'turn',
] as const;

export type ConfigKey = (typeof CONFIG_KEYS)[number];

export const PERMISSION_OPTIONS = Object.keys(Permission)
  .filter((key) => Number.isNaN(Number(key)))
  .map((key) => ({ name: key as keyof typeof Permission, value: Permission[key as keyof typeof Permission] as number }));

export const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
};

export function color(text: string, code: string): string {
  return `${code}${text}${ANSI.reset}`;
}
