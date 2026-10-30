import { EVERYONE_MENTION_TOKENS } from './constants.js';

/** One `@` mention found in a message. */
export interface Mention {
  /** Position of the `@`. */
  index: number;
  /** Length of the whole mention, `@` included. */
  length: number;
  /** The nickname as the matcher knows it, or the `@todos` / `@everyone` token. */
  name: string;
  /** `@todos` / `@everyone`: everyone who can read the channel (#464). */
  everyone: boolean;
}

export interface MentionMatcherOptions {
  /** Whether `@todos` / `@everyone` reach the whole channel (the server's `allowEveryoneMention`). */
  everyone?: boolean;
}

interface MentionName {
  name: string;
  everyone: boolean;
}

// What may sit right before the `@`, besides the start of the text and spaces:
// an opening bracket or quote, or a blockquote marker.
const OPENERS = new Set(['(', '[', '{', '<', '>', '"', "'", '“', '‘', '«']);
// Markdown emphasis right before the `@` (`**@Ana**`, `_@Ana_`, `~~@Ana~~`) is looked
// past: it counts only where it could open emphasis, so `ana_@mail.com` mentions nobody.
const EMPHASIS = new Set(['*', '_', '~']);
// What may not follow the name: it would still be part of a longer word.
const NAME_CHARACTER = /[\p{L}\p{M}\p{N}_-]/u;
// The spans `renderMarkdown` draws as code, in the order it finds them.
const CODE_PATTERNS = [/```([A-Za-z0-9+#._-]*)[ \t]*\r?\n([\s\S]*?)```/g, /```([\s\S]*?)```/g, /`([^`\n]+?)`/g];
// A web address runs to the next space. The chat draws it, or the destination of a
// Markdown link, as a link, so a mention there could never be shown.
const WEB_ADDRESS = /(?:https?:\/\/|www\.)\S*/giu;

function codeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let masked = text;
  for (const pattern of CODE_PATTERNS) {
    const found = [...masked.matchAll(pattern)].map((match): [number, number] => [match.index, match.index + match[0].length]);
    // The renderer swaps each code span for a placeholder without backticks or
    // line breaks before looking for the next kind; blanking it keeps positions.
    for (const [start, end] of found) masked = masked.slice(0, start) + '\u0000'.repeat(end - start) + masked.slice(end);
    ranges.push(...found);
  }
  return ranges;
}

function webRanges(text: string): Array<[number, number]> {
  return [...text.matchAll(WEB_ADDRESS)].map((match): [number, number] => [match.index, match.index + match[0].length]);
}

function startsMention(text: string, at: number): boolean {
  let before = at - 1;
  while (before >= 0 && EMPHASIS.has(text[before])) before--;
  const previous = text[before];
  return previous === undefined || /\s/u.test(previous) || OPENERS.has(previous);
}

function endsMention(text: string, end: number): boolean {
  // `_` closes emphasis (`_@Ana_`) unless a letter or digit glues it into a longer name.
  while (text[end] === '_') end++;
  const next = text.codePointAt(end);
  return next === undefined || !NAME_CHARACTER.test(String.fromCodePoint(next));
}

/**
 * The single rule for "this message mentions someone" (#14, #464). The server
 * records mentions with it, the client plays the cue and marks the channel with
 * it, and the feed highlights exactly what it finds.
 *
 * A mention is `@` and a known nickname, in any letter case:
 * - before the `@` comes the start of the text, a space, an opening bracket or
 *   quote, possibly followed by Markdown emphasis (`(@Ana)`, `"@Ana"`, `**@Ana**`,
 *   `(_@Ana_)`), never a letter or a `/`: `ana@mail.com`, `ana_@mail.com` and
 *   `site.com/@ana` mention nobody;
 * - after the name comes the end of the text or anything but a letter, digit,
 *   `_` or `-` (past `_` that closes emphasis), so `@Lucas` does not mention "Lu"
 *   and neither does `@Lu_x`;
 * - the longest known name wins and mentions never overlap, so `@Ana Paula`
 *   mentions "Ana Paula" and not "Ana";
 * - nothing inside code (fenced blocks or inline spans) or a web address (from
 *   `https://` or `www.` to the next space, a Markdown link destination included)
 *   is a mention.
 *
 * Both sides must match against the same names: the members of the server, never
 * bots, so whether a bot is online never changes who a message mentions. Build one
 * per list and reuse it: finding mentions only walks the `@`s of the text, whatever
 * the size of the server.
 */
export class MentionMatcher {
  /** Known names by length, longest first. */
  private readonly lengths: Array<[number, Map<string, MentionName>]>;

  constructor(nicknames: Iterable<string>, options: MentionMatcherOptions = {}) {
    const byLength = new Map<number, Map<string, MentionName>>();
    const add = (value: string, everyone: boolean) => {
      const name = value.trim();
      if (!name) return;
      let names = byLength.get(name.length);
      if (!names) byLength.set(name.length, names = new Map());
      names.set(name.toLowerCase(), { name, everyone });
    };
    for (const nickname of nicknames) add(nickname, false);
    // Added last, so `@todos` reaches the channel even if someone is called "Todos".
    if (options.everyone) for (const token of EVERYONE_MENTION_TOKENS) add(token, true);
    this.lengths = [...byLength].sort(([left], [right]) => right - left);
  }

  /** Every mention in `text`, in order. */
  find(text: string): Mention[] {
    const mentions: Mention[] = [];
    let at = text.indexOf('@');
    if (at < 0 || !this.lengths.length) return mentions;
    const excluded = [...(text.includes('`') ? codeRanges(text) : []), ...webRanges(text)];
    while (at >= 0) {
      const mention = this.matchAt(text, at, excluded);
      if (mention) mentions.push(mention);
      at = text.indexOf('@', mention ? at + mention.length : at + 1);
    }
    return mentions;
  }

  /** Whether `text` mentions `nickname`, which must be one of the known names, or everyone. */
  mentions(text: string, nickname: string): boolean {
    const name = nickname.trim().toLowerCase();
    return this.find(text).some(mention => mention.everyone || (!!name && mention.name.toLowerCase() === name));
  }

  private matchAt(text: string, at: number, excluded: ReadonlyArray<[number, number]>): Mention | null {
    if (!startsMention(text, at) || excluded.some(([start, end]) => at >= start && at < end)) return null;
    for (const [length, names] of this.lengths) {
      const end = at + 1 + length;
      if (end > text.length) continue;
      const known = names.get(text.slice(at + 1, end).toLowerCase());
      if (known && endsMention(text, end)) return { index: at, length: length + 1, ...known };
    }
    return null;
  }
}

/** True when the text mentions `@todos` / `@everyone`, by the same rule as every other mention. */
export function hasEveryoneMention(content: string): boolean {
  return new MentionMatcher([], { everyone: true }).find(content).some(mention => mention.everyone);
}
