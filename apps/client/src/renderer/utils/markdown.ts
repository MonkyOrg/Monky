import { escapeHtml } from './html';
import { EVERYONE_MENTION_TOKENS } from '@monky/shared';
import { codeLanguageLabel, codeLineNumbers, highlightCode, resolveCodeLanguage } from './codeHighlight';
import { t } from '../i18n';
import { parser, Strikethrough } from '@lezer/markdown';

const inlineParser = parser.configure(Strikethrough);

export function findAutomaticLinks(text: string, tree = inlineParser.parse(text)): { from: number; to: number; url: string }[] {
  const excluded: { from: number; to: number }[] = [];
  tree.iterate({ enter: node => {
    if (['Link', 'Image', 'InlineCode', 'FencedCode', 'CodeBlock', 'Autolink'].includes(node.name)) {
      excluded.push({ from: node.from, to: node.to });
      return false;
    }
  } });
  const links: { from: number; to: number; url: string }[] = [];
  for (const match of text.matchAll(/(?:https?:\/\/|www\.)[^\s<>"'`\u0000]+/gi)) {
    const from = match.index;
    if (from > 0 && /[\p{L}\p{N}_@/]/u.test(text[from - 1])) continue;
    let display = match[0];
    const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
    const balance: Record<string, number> = {};
    for (const [close, open] of Object.entries(pairs)) {
      balance[close] = display.split(close).length - display.split(open).length;
    }
    while (display) {
      const last = display.at(-1)!;
      if (/[.,!?;:*_~]/.test(last)) display = display.slice(0, -1);
      else if (balance[last] > 0) { balance[last]--; display = display.slice(0, -1); }
      else break;
    }
    const to = from + display.length;
    if (excluded.some(range => from < range.to && to > range.from)) continue;
    const www = /^www\./i.test(display);
    const url = www ? `https://${display}` : display;
    try {
      const parsed = new URL(url);
      if (www && !/^www\.[^.]+\..+$/i.test(parsed.hostname)) continue;
      links.push({ from, to, url });
    } catch { /* Incomplete URLs remain editable text. */ }
  }
  return links;
}

/**
 * Renders a small, safe subset of Markdown for chat messages.
 *
 * The input is HTML-escaped first, so user content can never inject markup;
 * formatting tokens are then translated into a fixed whitelist of tags. Only
 * http(s) links are allowed and they always open in the external browser via
 * the `data-external-link` hook wired up by the ChatView.
 *
 * Supported syntax:
 *   # .. ###### h1..h6    -> <h1>..<h6>
 *   > quote               -> <blockquote>
 *   - / * / + item        -> <ul><li>
 *   1. item               -> <ol><li>
 *   --- / *** / ___       -> <hr>
 *   ```lang code```       -> highlighted block with a copy button
 *   `inline code`         -> <code>
 *   **bold**              -> <strong>
 *   *italic* / _italic_   -> <em>
 *   ~~strike~~            -> <del>
 *   [text](https://url)   -> <a>
 *   bare https://url      -> <a>
 *   newlines              -> <br> (inside paragraphs/quotes)
 */
export interface MarkdownOptions {
  interactive?: boolean;
  currentNickname?: string;
  knownNicknames?: string[];
  /** Highlight `@todos` / `@everyone` as a mention aimed at the reader (#464). */
  everyoneMentionEnabled?: boolean;
}

/**
 * A code block with its language header and copy button (#391).
 *
 * The source arrives raw here on purpose: `highlight.js` escapes what it emits,
 * and handing it already-escaped text would show `&amp;lt;` in the message.
 * When the language is unknown the code is escaped by hand instead.
 */
export function renderCodeBlock(tag: string, code: string, interactive = true): string {
  const language = resolveCodeLanguage(tag);
  const highlighted = language ? highlightCode(code, language) : '';
  const body = highlighted || escapeHtml(code);
  const label = language ? codeLanguageLabel(language) : t('chat.codeBlockPlain');
  const copyLabel = escapeHtml(t('chat.codeBlockCopy'));

  return (
    `<div class="md-code">` +
    `<div class="md-code-header">` +
    `<span class="md-code-lang"><span class="material-symbols-outlined md-16" aria-hidden="true">code</span>${escapeHtml(label)}</span>` +
    (interactive ? `<button type="button" class="md-code-copy" title="${copyLabel}">` +
    `<span class="material-symbols-outlined md-14">content_copy</span>` +
    `<span class="md-code-copy-label">${copyLabel}</span>` +
    `</button>` : '') +
    `</div>` +
    `<div class="md-code-content"><pre class="md-code-lines" aria-hidden="true">${codeLineNumbers(code)}</pre>` +
    `<pre class="md-codeblock"><code class="hljs${language ? ` language-${language}` : ''}">${body}</code></pre></div>` +
    `</div>`
  );
}

export function renderMarkdown(raw: string, options?: MarkdownOptions): string {
  if (!raw) return '';

  const automaticLinks: string[] = [];
  let text = raw;
  for (const link of findAutomaticLinks(raw).reverse()) {
    const url = escapeHtml(link.url);
    const index = automaticLinks.push(`<a href="${url}" class="md-link" data-external-link="${url}">${escapeHtml(raw.slice(link.from, link.to))}</a>`) - 1;
    text = text.slice(0, link.from) + `\u0000AL${index}\u0000` + text.slice(link.to);
  }

  // 1. Fenced code blocks are pulled out before anything else, while the source
  //    is still raw — the highlighter needs the original text, and the
  //    placeholders left behind survive the escaping pass untouched.
  const codeBlocks: string[] = [];
  const stash = (tag: string, code: string): string => {
    const idx = codeBlocks.push(renderCodeBlock(tag, code, options?.interactive !== false)) - 1;
    return `\u0000CB${idx}\u0000`;
  };

  //    A language tag only counts on a fence that opens its own line, so a
  //    single-line ```snippet``` keeps behaving as an untagged block.
  text = text.replace(/```([A-Za-z0-9+#._-]*)[ \t]*\r?\n([\s\S]*?)```/g, (_m, tag: string, code: string) =>
    stash(tag, code.replace(/\r?\n$/, ''))
  );
  text = text.replace(/```([\s\S]*?)```/g, (_m, code: string) => stash('', code.replace(/^\r?\n/, '').replace(/\r?\n$/, '')));

  // 2. Escape everything else - no raw HTML from users can survive this.
  text = escapeHtml(text);

  // 3. Inline code (`...`). Same placeholder treatment.
  const inlineCodes: string[] = [];
  text = text.replace(/`([^`\n]+?)`/g, (_m, code) => {
    const idx = inlineCodes.push(`<code class="md-inline-code">${code}</code>`) - 1;
    return `\u0000IC${idx}\u0000`;
  });

  // Inline-level formatting applied to the text content of each block.
  const applyInline = (s: string): string => {
    const links: string[] = [];
    // Links: [label](url) - only http/https.
    s = s.replace(/\[((?:\\.|[^\]\\])+?)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label: string, url: string) => {
      const display = label.replace(/\\([\\[\]])/g, '$1');
      const idx = links.push(`<a href="${url}" class="md-link" data-external-link="${url}">${display}</a>`) - 1;
      return `\u0000LK${idx}\u0000`;
    });
    // Use the editor's parser so nested/toggled emphasis has the same meaning after sending.
    const replacements: { from: number; to: number; html: string }[] = [];
    inlineParser.parse(s).iterate({ enter: node => {
      if (node.name === 'Escape') replacements.push({ from: node.from, to: node.from + 1, html: '' });
      const tag = node.name === 'StrongEmphasis' ? 'strong' : node.name === 'Emphasis' ? 'em'
        : node.name === 'Strikethrough' ? 'del' : null;
      const open = node.node.firstChild, close = node.node.lastChild;
      if (tag && open && close) replacements.push(
        { from: open.from, to: open.to, html: `<${tag}>` }, { from: close.from, to: close.to, html: `</${tag}>` });
    } });
    for (const replacement of replacements.sort((a, b) => b.from - a.from)) {
      s = s.slice(0, replacement.from) + replacement.html + s.slice(replacement.to);
    }

    // Mentions (@nickname)
    if (options?.everyoneMentionEnabled) {
      for (const token of EVERYONE_MENTION_TOKENS) {
        const regex = new RegExp(`(^|[\\s(])@${token}(?=$|[\\s),.!?:;])`, 'gi');
        s = s.replace(regex, `$1<span class="chat-mention chat-mention-me">@${token}</span>`);
      }
    }
    if (options?.knownNicknames && options.knownNicknames.length > 0) {
      const sortedNicks = [...new Set(options.knownNicknames)].sort((a, b) => b.length - a.length);
      for (const nick of sortedNicks) {
        if (!nick) continue;
        const isMe = !!options.currentNickname && nick.toLowerCase() === options.currentNickname.toLowerCase();
        const cls = isMe ? 'chat-mention chat-mention-me' : 'chat-mention';
        const escapedNick = nick.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const escapedHtmlNick = escapeHtml(nick);
        const regex = new RegExp(`(^|[\\s(])@${escapedNick}(?=$|[\\s),.!?:;])`, 'gi');
        s = s.replace(regex, `$1<span class="${cls}">@${escapedHtmlNick}</span>`);
      }
    } else if (options?.currentNickname) {
      const escapedNick = options.currentNickname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const escapedHtmlNick = escapeHtml(options.currentNickname);
      const regex = new RegExp(`(^|[\\s(])@${escapedNick}(?=$|[\\s),.!?:;])`, 'gi');
      s = s.replace(regex, `$1<span class="chat-mention chat-mention-me">@${escapedHtmlNick}</span>`);
    }

    // Restore link placeholders
    s = s.replace(/\u0000LK(\d+)\u0000/g, (_m, idx) => links[Number(idx)]);
    s = s.replace(/\u0000AL(\d+)\u0000/g, (_m, idx) => automaticLinks[Number(idx)]);

    return s;
  };

  // 4. Block-level parsing, line by line.
  const lines = text.split('\n');
  const out: string[] = [];
  let paragraph: string[] = [];
  let i = 0;

  const flushParagraph = () => {
    if (paragraph.length) {
      out.push(`<p class="md-p">${applyInline(paragraph.join('<br>'))}</p>`);
      paragraph = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Standalone fenced-code-block placeholder.
    const cb = trimmed.match(/^\u0000CB(\d+)\u0000$/);
    if (cb) {
      flushParagraph();
      out.push(codeBlocks[Number(cb[1])]);
      i++;
      continue;
    }

    // Blank line ends the current paragraph.
    if (trimmed === '') {
      flushParagraph();
      out.push('<p class="md-p md-blank-line"><br></p>');
      i++;
      continue;
    }

    // Heading (# .. ######).
    const h = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushParagraph();
      const level = h[1].length;
      out.push(`<h${level} class="md-h md-h${level}">${applyInline(h[2].trim())}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule.
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushParagraph();
      out.push('<hr class="md-hr">');
      i++;
      continue;
    }

    // Blockquote (consume consecutive `>` lines). Note the `>` has already
    // been HTML-escaped to `&gt;` by this point.
    if (/^&gt;\s?/.test(trimmed)) {
      flushParagraph();
      const quote: string[] = [];
      while (i < lines.length && /^&gt;\s?/.test(lines[i].trim())) {
        quote.push(lines[i].trim().replace(/^&gt;\s?/, ''));
        i++;
      }
      out.push(`<blockquote class="md-quote">${applyInline(quote.join('<br>'))}</blockquote>`);
      continue;
    }

    // Unordered list.
    if (/^[-*+]\s+/.test(trimmed)) {
      flushParagraph();
      const items: string[] = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
        items.push(`<li>${applyInline(lines[i].trim().replace(/^[-*+]\s+/, ''))}</li>`);
        i++;
      }
      out.push(`<ul class="md-ul">${items.join('')}</ul>`);
      continue;
    }

    // Ordered list.
    if (/^\d+\.\s+/.test(trimmed)) {
      flushParagraph();
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(`<li>${applyInline(lines[i].trim().replace(/^\d+\.\s+/, ''))}</li>`);
        i++;
      }
      const start = trimmed.match(/^(\d+)\./)?.[1] ?? '1';
      out.push(`<ol class="md-ol" start="${escapeHtml(start)}">${items.join('')}</ol>`);
      continue;
    }

    // Plain paragraph line.
    paragraph.push(line);
    i++;
  }
  flushParagraph();

  let html = out.join('');

  // 5. Restore placeholders (inline code, plus any code block left inline).
  html = html.replace(/\u0000IC(\d+)\u0000/g, (_m, idx) => inlineCodes[Number(idx)]);
  html = html.replace(/\u0000CB(\d+)\u0000/g, (_m, idx) => codeBlocks[Number(idx)]);
  if (options?.interactive === false) {
    html = html.replace(/<a\b[^>]*>/g, '<span class="md-link">').replace(/<\/a>/g, '</span>');
  }

  return html;
}
