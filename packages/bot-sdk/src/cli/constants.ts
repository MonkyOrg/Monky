export const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
} as const;

export const DEFAULT_MANUAL_SERVER_URL = 'ws://localhost:3000';
export const DEFAULT_TOKEN_ENV = 'MONKY_BOT_TOKEN';
export const DEFAULT_MARKETPLACE_PORT = 7780;
export const DEFAULT_AUTOUPDATE_SCHEDULE = '04:00';
export const BOT_ECOSYSTEM_FILE = 'ecosystem.bot.cjs';
export const UPDATER_ECOSYSTEM_FILE = 'ecosystem.updater.cjs';
export const GENERATED_WRAPPER_FILE = 'monky-cli.cjs';

export function color(text: string, code: string): string {
  return `${code}${text}${ANSI.reset}`;
}
