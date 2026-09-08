import { EMOJI_CATALOG } from './emojiCatalog';

export const RECENT_EMOJIS_KEY = 'monky.recent-emojis';
export const MAX_RECENT_EMOJIS = 32;
const knownEmojis = new Set(EMOJI_CATALOG.flatMap((group) => group.emojis.map(([char]) => char)));
type EmojiStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function sanitizeRecentEmojis(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const emoji of value.slice(0, 1024)) {
    if (typeof emoji === 'string' && knownEmojis.has(emoji) && !result.includes(emoji)) result.push(emoji);
    if (result.length === MAX_RECENT_EMOJIS) break;
  }
  return result;
}

/** One shared source for composer and reaction pickers, with an in-memory fallback. */
export class RecentEmojis {
  private recent: string[] = [];
  private unsaved = false;

  constructor(private readonly storage: () => EmojiStorage | undefined = () => globalThis.localStorage) {}

  public get(): string[] {
    if (this.unsaved) return [...this.recent];
    try {
      const raw = this.storage()?.getItem(RECENT_EMOJIS_KEY);
      if (raw && raw.length <= 65536) this.recent = sanitizeRecentEmojis(JSON.parse(raw));
    } catch (error) {
      console.warn('[RecentEmojis] Could not read recent emojis', error);
    }
    return [...this.recent];
  }

  public select(emoji: string): void {
    if (!knownEmojis.has(emoji)) return;
    this.recent = [emoji, ...this.get().filter((entry) => entry !== emoji)].slice(0, MAX_RECENT_EMOJIS);
    try {
      this.storage()?.setItem(RECENT_EMOJIS_KEY, JSON.stringify(this.recent));
      this.unsaved = false;
    } catch (error) {
      this.unsaved = true;
      console.warn('[RecentEmojis] Could not save recent emojis', error);
    }
  }
}

export const recentEmojis = new RecentEmojis();
