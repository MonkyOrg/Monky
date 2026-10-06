import { z } from 'zod';
import { LIMITS } from './constants.js';
import type { MessageReply } from './models.js';

const text = z.string().max(LIMITS.WS_MAX_PAYLOAD_BYTES);
export const messageBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text }).strict(),
  z.object({ type: z.literal('code'), language: z.string().max(40).regex(/^[A-Za-z0-9+#._-]*$/), code: text }).strict(),
  z.object({ type: z.literal('reply'), messageId: z.string().min(1).max(128) }).strict(),
]);
export const messageBlocksSchema = z.array(messageBlockSchema).min(1).max(100);
export type MessageBlock = z.infer<typeof messageBlockSchema>;
export type ResolvedMessageBlock = Exclude<MessageBlock, { type: 'reply' }>
  | { type: 'reply'; messageId: string; reply: MessageReply };

export function parseFencedMessageBlocks(value: string): Exclude<MessageBlock, { type: 'reply' }>[] {
  const blocks: Exclude<MessageBlock, { type: 'reply' }>[] = [];
  const pattern = /(?:^|\n)```([A-Za-z0-9+#._-]{0,40})\r?\n([\s\S]*?)\r?\n```(?=\r?\n|$)/g;
  let start = 0;
  for (const match of value.matchAll(pattern)) {
    const before = value.slice(start, match.index);
    if (before) blocks.push({ type: 'text', text: before });
    blocks.push({ type: 'code', language: match[1] || 'plaintext', code: match[2] });
    start = match.index + match[0].length;
  }
  if (start < value.length) blocks.push({ type: 'text', text: value.slice(start) });
  return blocks;
}

export function messageBlocksContent(blocks: readonly MessageBlock[]): string {
  return blocks.map(block => {
    if (block.type === 'reply') return '';
    if (block.type === 'text') return block.text;
    const code = block.code.replace(/\r\n/g, '\n').replace(/```/g, '`\u200b``');
    return `\`\`\`${block.language === 'plaintext' ? '' : block.language}\n${code}\n\`\`\``;
  }).filter(Boolean).join('\n\n').trim();
}

export function messageBlocksInput(blocks: readonly ResolvedMessageBlock[]): MessageBlock[] {
  return blocks.map(block => block.type === 'reply' ? { type: 'reply', messageId: block.messageId } : { ...block });
}
