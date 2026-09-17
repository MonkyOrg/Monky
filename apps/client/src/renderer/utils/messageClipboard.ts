import { LIMITS } from '@monky/shared';
import { renderMarkdown } from './markdown';

export type MessageCopyMode = 'formatted' | 'plain';

export interface MessageClipboardContent {
  text: string;
  html?: string;
}

const clipboardMarker = 'markdown-v1';
const allowedTags = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'STRONG', 'EM', 'DEL',
  'A', 'CODE', 'PRE', 'BLOCKQUOTE', 'UL', 'OL', 'LI', 'BR', 'HR']);
const blockTags = new Set(['DIV', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'BLOCKQUOTE', 'UL', 'OL', 'LI', 'HR']);

function safeLink(element: Element): string | null {
  try {
    const url = new URL(element.getAttribute('href') ?? '');
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/** Copy semantics, not app chrome, arbitrary attributes or stylesheet rules. */
function copySafeNodes(source: Node, target: Node): void {
  for (const child of source.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      target.appendChild(document.createTextNode(child.textContent ?? ''));
      continue;
    }
    if (!(child instanceof Element)) continue;
    if (child.matches('.md-code-header, button, script, style, iframe, object, embed, svg, [hidden], [aria-hidden="true"]')) continue;
    const href = child.tagName === 'A' ? safeLink(child) : null;
    if (!allowedTags.has(child.tagName) || (child.tagName === 'A' && !href)) {
      copySafeNodes(child, target);
      continue;
    }
    const element = document.createElement(child.tagName.toLowerCase());
    if (href) element.setAttribute('href', href);
    if (child.tagName === 'CODE') {
      const language = Array.from(child.classList).find((name) => /^language-[a-z0-9+#._-]+$/i.test(name));
      if (language) element.className = language;
      element.style.fontFamily = 'monospace';
    }
    if (child.tagName === 'PRE') element.style.whiteSpace = 'pre-wrap';
    if (child.tagName === 'OL' && /^[1-9]\d{0,5}$/.test(child.getAttribute('start') ?? '')) {
      element.setAttribute('start', child.getAttribute('start') ?? '1');
    }
    copySafeNodes(child, element);
    target.appendChild(element);
  }
}

function serializeChildren(node: Node, markdown: boolean): string {
  let result = '';
  let previousBlock = false;
  for (const child of node.childNodes) {
    const text = serializeNode(child, markdown);
    if (!text) continue;
    const block = child instanceof Element && blockTags.has(child.tagName);
    if (result && (previousBlock || block)) {
      result += node instanceof Element && ['UL', 'OL'].includes(node.tagName) ? '\n' : '\n\n';
    }
    result += text;
    previousBlock = block;
  }
  return result;
}

function serializeNode(node: Node, markdown: boolean): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (!(node instanceof Element)) return serializeChildren(node, markdown);
  if (node.tagName === 'BR') return '\n';
  if (node.tagName === 'PRE') {
    const code = node.textContent ?? '';
    if (!markdown) return code;
    const language = node.querySelector('code')?.className.replace(/^language-/, '') ?? '';
    return `\`\`\`${language}\n${code}\n\`\`\``;
  }
  const text = serializeChildren(node, markdown);
  if (!markdown) return text;
  switch (node.tagName) {
    case 'STRONG': return `**${text}**`;
    case 'EM': return `*${text}*`;
    case 'DEL': return `~~${text}~~`;
    case 'CODE': return `\`${node.textContent ?? ''}\``;
    case 'A': return `[${text}](${node.getAttribute('href')})`;
    case 'BLOCKQUOTE': return `> ${text.replace(/\n/g, '\n> ')}`;
    case 'HR': return '---';
    case 'LI': {
      const parent = node.parentElement;
      const index = parent ? Array.from(parent.children).indexOf(node) : 0;
      const prefix = parent?.tagName === 'OL' ? `${Number(parent.getAttribute('start') ?? '1') + index}. ` : '- ';
      return prefix + text;
    }
    default: return /^H[1-6]$/.test(node.tagName) ? `${'#'.repeat(Number(node.tagName[1]))} ${text}` : text;
  }
}

function clipboardContent(clean: HTMLElement, markdown?: string): MessageClipboardContent {
  const text = serializeChildren(clean, false);
  const original = markdown ?? serializeChildren(clean, true);
  clean.style.whiteSpace = 'pre-wrap';
  if (original.length <= LIMITS.MAX_MESSAGE_LENGTH) {
    clean.dataset.monkyClipboard = clipboardMarker;
    clean.dataset.monkyMarkdown = original;
  }
  return { text, html: clean.outerHTML };
}

export function renderedMessageClipboard(source: Node, markdown?: string): MessageClipboardContent {
  const clean = document.createElement('div');
  copySafeNodes(source, clean);
  return clipboardContent(clean, markdown);
}

export function markdownMessageClipboard(markdown: string): MessageClipboardContent {
  const template = document.createElement('template');
  template.innerHTML = renderMarkdown(markdown);
  return renderedMessageClipboard(template.content, markdown);
}

function messageTextAt(node: Node): Element | null {
  return (node instanceof Element ? node : node.parentElement)?.closest('.chat-message-text') ?? null;
}

/**
 * Clip each rendered message to the actual range. cloneContents alone drops
 * ancestors such as <strong> when both endpoints lie inside the same text node.
 */
export function selectedMessageClipboard(feed: HTMLElement, selection: Selection | null): MessageClipboardContent | null {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0);
  const start = messageTextAt(range.startContainer);
  const end = messageTextAt(range.endContainer);
  if (!start || !end || !feed.contains(start) || !feed.contains(end)) return null;
  const selected = document.createElement('div');
  for (const content of feed.querySelectorAll<HTMLElement>('.chat-message-text')) {
    if (!range.intersectsNode(content)) continue;
    const clipped = document.createRange();
    clipped.selectNodeContents(content);
    if (range.compareBoundaryPoints(Range.START_TO_START, clipped) > 0) clipped.setStart(range.startContainer, range.startOffset);
    if (range.compareBoundaryPoints(Range.END_TO_END, clipped) < 0) clipped.setEnd(range.endContainer, range.endOffset);
    if (clipped.collapsed) continue;
    let fragment: Node = clipped.cloneContents();
    let ancestor = clipped.commonAncestorContainer;
    if (!(ancestor instanceof Element)) ancestor = ancestor.parentNode ?? content;
    while (ancestor instanceof Element && ancestor !== content) {
      const wrapper = ancestor.cloneNode(false);
      wrapper.appendChild(fragment);
      fragment = wrapper;
      ancestor = ancestor.parentElement ?? content;
    }
    const section = document.createElement('div');
    section.appendChild(fragment);
    const clean = document.createElement('div');
    copySafeNodes(section, clean);
    if (!clean.hasChildNodes()) continue;
    selected.appendChild(clean);
  }
  if (!selected.hasChildNodes()) return null;
  // Keep message boundaries without retaining authors, timestamps or toolbars.
  return clipboardContent(selected);
}

export function writeMessageClipboard(content: MessageClipboardContent, mode: MessageCopyMode): Promise<void> {
  if (mode === 'plain' || !content.html) return navigator.clipboard.writeText(content.text);
  return navigator.clipboard.write([new ClipboardItem({
    'text/plain': new Blob([content.text], { type: 'text/plain' }),
    'text/html': new Blob([content.html], { type: 'text/html' }),
  })]);
}

export function setMessageClipboardData(data: DataTransfer, content: MessageClipboardContent): void {
  data.clearData();
  data.setData('text/plain', content.text);
  if (content.html) data.setData('text/html', content.html);
}

/** Metadata is only text for the composer, never HTML to mount in the document. */
export function readMonkyClipboardMarkdown(data: DataTransfer): string | null {
  const html = data.getData('text/html');
  if (!html || html.length > 1_000_000) return null;
  // Template contents are inert, including images and scripts from other apps.
  const template = document.createElement('template');
  template.innerHTML = html;
  const sources = template.content.querySelectorAll(`[data-monky-clipboard="${clipboardMarker}"]`);
  if (sources.length !== 1) return null;
  const markdown = sources[0].getAttribute('data-monky-markdown');
  if (!markdown || markdown.length > LIMITS.MAX_MESSAGE_LENGTH) return null;
  // A rich editor may retain the outer metadata while copying only a fragment.
  // Never let stale metadata expand that selection back to the whole message.
  const plain = data.getData('text/plain').replace(/\r\n?/g, '\n');
  return markdownMessageClipboard(markdown).text === plain ? markdown : null;
}

export function pasteMonkyClipboard(input: HTMLTextAreaElement, data: DataTransfer): boolean {
  if (input.readOnly || input.disabled || document.activeElement !== input) return false;
  const markdown = readMonkyClipboardMarkdown(data);
  if (markdown === null) return false;
  const available = input.maxLength < 0 ? markdown.length
    : Math.max(0, input.maxLength - input.value.length + input.selectionEnd - input.selectionStart);
  const text = markdown.slice(0, available);
  if (!text) return true;
  try {
    if (document.execCommand('insertText', false, text)) return true;
  } catch {
    // Keep text insertion working where Chromium's undo-aware command is unavailable.
  }
  input.setRangeText(text, input.selectionStart, input.selectionEnd, 'end');
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: text }));
  return true;
}
