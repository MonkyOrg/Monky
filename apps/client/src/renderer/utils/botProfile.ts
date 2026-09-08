import { LIMITS } from '@monky/shared';

export function validateBotAvatar(dataUrl: string): 'type' | 'size' | null {
  const match = /^data:image\/(png|jpeg|webp);base64,([a-z0-9+/]+={0,2})$/i.exec(dataUrl);
  if (!match || match[2].length % 4 !== 0) return 'type';
  const base64 = match[2];
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  if (base64.length * 3 / 4 - padding > LIMITS.MAX_AVATAR_SIZE) return 'size';
  const header = atob(base64.slice(0, 24));
  const valid = match[1].toLowerCase() === 'png' ? header.startsWith('\x89PNG\r\n\x1a\n') :
    match[1].toLowerCase() === 'jpeg' ? header.startsWith('\xff\xd8\xff') :
      header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP';
  return valid ? null : 'type';
}
