/**
 * Turns rendered chat messages back into what the clipboard should carry (#516).
 *
 * A chat message is stored as Markdown and displayed as HTML. Copying the
 * displayed text used to hand over neither one: the asterisks were gone, so
 * pasting back into the chat lost the formatting, and the code-block toolbar
 * ("TypeScript", "Copiar") came along as if it were part of the message.
 *
 * So a copy writes two flavours at once, which is what every clipboard is built
 * to carry:
 *   - `text/html`  — for editors that understand formatting (Word, Docs, Slack)
 *   - `text/plain` — the Markdown source, so pasting back into Monky, or into
 *                    any plain field, round-trips to the same message
 *
 * The conversion mirrors `renderMarkdown` exactly: it only has to understand
 * the fixed whitelist of tags that renderer emits, which is what makes an
 * HTML-to-Markdown pass tractable here instead of a guessing game.
 */

/**
 * Interface chrome that lives inside a message but is not the message.
 *
 * The code-block header carries the language label and the copy button, and
 * `.chat-message-text *` is selectable (#148), so a drag over a message with
 * code used to pull "TypeScript Copiar" into the clipboard. Link preview cards
 * are generated after the fact and repeat a URL that is already in the text.
 */
const CHROME_SELECTOR =
  '.md-code-header, .chat-link-previews, .chat-message-actions, .chat-message-editor, .chat-edited-badge';

/** Tags whose content is a block: they get a blank line around them. */
const BLOCK_SEPARATOR = '\n\n';

/**
 * Marks a newline that must stay single after the blank lines are collapsed.
 *
 * Used to keep an author line glued to the message under it. Blocks pad
 * themselves with blank lines on both sides, so without this the name would
 * end up separated from what the person actually said.
 */
const ATTACHED_BREAK = '\u0001';

/**
 * Stands in for the body of a code block while the separators are collapsed.
 *
 * The collapse at the end of `toMarkdown` trims spaces before a newline and
 * squeezes runs of blank lines. That is right for the prose the walker
 * produced and wrong for code, where a trailing space or a run of blank lines
 * is content — inside a multiline string it is part of the value. So the body
 * leaves the walker as a marker and comes back untouched afterwards.
 */
const CODE_MARK = '\u0002';
const codeBodies: string[] = [];

function isElement(node: Node): node is HTMLElement {
  return node.nodeType === Node.ELEMENT_NODE;
}

function isChrome(el: Element): boolean {
  return el.matches(CHROME_SELECTOR);
}

/** Wraps inline content in a marker, skipping empty content so no `****` is emitted. */
function wrapInline(marker: string, content: string): string {
  if (!content.trim()) return content;
  // Markers have to hug the text or Markdown will not read them back, so any
  // surrounding spaces are moved outside the marker.
  const leading = content.match(/^\s*/)?.[0] ?? '';
  const trailing = content.match(/\s*$/)?.[0] ?? '';
  return `${leading}${marker}${content.trim()}${marker}${trailing}`;
}

function block(content: string): string {
  if (!content.trim()) return '';
  return `${BLOCK_SEPARATOR}${content.trim()}${BLOCK_SEPARATOR}`;
}

/**
 * Fence tag to write back for a code block.
 *
 * The tag the author typed is preferred over the resolved language, because the
 * renderer canonicalises aliases: a block opened with ```ts carries
 * `language-typescript`, and reading only the class would quietly rewrite the
 * message on a round-trip. The class remains the fallback for a `<pre>` that
 * did not come from `renderMarkdown`.
 */
function codeLanguageOf(pre: Element): string {
  const original = pre.closest('.md-code')?.getAttribute('data-md-lang');
  if (original) return original;
  const code = pre.querySelector('code');
  const match = code?.className.match(/language-([A-Za-z0-9+#._-]+)/);
  return match ? match[1] : '';
}

function childrenToMarkdown(el: Node): string {
  return Array.from(el.childNodes).map(nodeToMarkdown).join('');
}

function nodeToMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? '';
  if (!isElement(node)) return '';
  if (isChrome(node)) return '';

  const el = node;

  // Who said it and when. Selecting across several messages should keep the
  // attribution, but the pieces sit in separate spans and would otherwise come
  // out run together as "Fulano14:32".
  if (el.classList.contains('chat-author-header')) {
    const parts = Array.from(el.children)
      .filter((child) => !isChrome(child))
      .map((child) => (child.textContent ?? '').trim())
      .filter(Boolean);
    if (!parts.length) return '';
    return `${BLOCK_SEPARATOR}${parts.join(' — ')}${ATTACHED_BREAK}`;
  }

  const tag = el.tagName.toLowerCase();

  switch (tag) {
    case 'br':
      return '\n';

    case 'strong':
    case 'b':
      return wrapInline('**', childrenToMarkdown(el));
    case 'em':
    case 'i':
      return wrapInline('*', childrenToMarkdown(el));
    case 'del':
    case 's':
      return wrapInline('~~', childrenToMarkdown(el));

    case 'code':
      // Code inside a <pre> is emitted by the <pre> branch, fence and all.
      if (el.closest('pre')) return el.textContent ?? '';
      return wrapInline('`', childrenToMarkdown(el));

    case 'pre': {
      // textContent rather than the children: highlight.js wraps every token in
      // a <span>, and those must not become part of the code.
      const code = (el.textContent ?? '').replace(/\n$/, '');
      const language = codeLanguageOf(el);
      const slot = codeBodies.push(code) - 1;
      return block(`\`\`\`${language}\n${CODE_MARK}${slot}${CODE_MARK}\n\`\`\``);
    }

    case 'a': {
      const href = el.getAttribute('href') || el.getAttribute('data-external-link') || '';
      const label = childrenToMarkdown(el);
      if (!href) return label;
      // A bare URL was written as a bare URL; re-adding the brackets would
      // change the message on a round-trip.
      return label.trim() === href ? href : `[${label}](${href})`;
    }

    case 'p':
      return block(childrenToMarkdown(el));

    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return block(`${'#'.repeat(Number(tag[1]))} ${childrenToMarkdown(el).trim()}`);

    case 'blockquote': {
      const lines = childrenToMarkdown(el).trim().split('\n');
      return block(lines.map((line) => `> ${line}`.trimEnd()).join('\n'));
    }

    case 'hr':
      return block('---');

    case 'ul':
    case 'ol': {
      const ordered = tag === 'ol';
      const items = Array.from(el.children)
        .filter((child) => child.tagName.toLowerCase() === 'li')
        .map((li, index) => {
          const marker = ordered ? `${index + 1}. ` : '- ';
          // A nested block inside an item would otherwise break the list apart.
          const content = childrenToMarkdown(li).trim().replace(/\n+/g, ' ');
          return `${marker}${content}`;
        });
      return block(items.join('\n'));
    }

    case 'li':
      // Reached only for a stray <li>; the list branch handles the normal case.
      return childrenToMarkdown(el);

    default:
      return childrenToMarkdown(el);
  }
}

/**
 * Markdown for everything inside `root`.
 *
 * Blocks pad themselves with blank lines while the tree is walked, and the
 * padding is collapsed once at the end. That is what lets a paragraph followed
 * by a list come out spaced correctly without the walker ever having to know
 * what came before it.
 */
export function toMarkdown(root: Node): string {
  codeBodies.length = 0;
  return childrenToMarkdown(root)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, BLOCK_SEPARATOR)
    // Applied after the collapse, so the author line keeps a single newline
    // while every other block keeps its blank line.
    .replace(new RegExp(`${ATTACHED_BREAK}\\n*`, 'g'), '\n')
    .trim()
    // Last, so nothing above can reach inside a code block. Replacing through a
    // function keeps a `$1` in the code from being read as a group reference.
    .replace(new RegExp(`${CODE_MARK}(\\d+)${CODE_MARK}`, 'g'), (_, slot) => codeBodies[Number(slot)]);
}

/**
 * Portable HTML for the rich flavour.
 *
 * The app's own classes and data attributes are dropped: they point at
 * stylesheets the receiving editor does not have, and `data-external-link`
 * only means something inside Monky. What is left is plain semantic HTML that
 * any editor can render.
 */
export function toPortableHtml(root: Node): string {
  const holder = document.createElement('div');
  holder.appendChild(root.cloneNode(true));

  holder.querySelectorAll(CHROME_SELECTOR).forEach((el) => el.remove());

  // Same joining as the Markdown side: the name and the time are separate
  // spans and would otherwise be pasted as "Fulano14:32".
  holder.querySelectorAll('.chat-author-header').forEach((header) => {
    const parts = Array.from(header.children)
      .map((child) => (child.textContent ?? '').trim())
      .filter(Boolean);
    header.textContent = parts.join(' — ');
  });

  // Syntax highlighting is a wrapper span per token, meaningless without the
  // app's stylesheet. The receiving editor gets the code itself.
  holder.querySelectorAll('pre code').forEach((code) => {
    code.textContent = code.textContent ?? '';
  });

  holder.querySelectorAll('*').forEach((el) => {
    for (const attribute of Array.from(el.attributes)) {
      const keep =
        (el.tagName === 'A' && attribute.name === 'href') ||
        (el.tagName === 'IMG' && (attribute.name === 'src' || attribute.name === 'alt'));
      if (!keep) el.removeAttribute(attribute.name);
    }
  });

  return holder.innerHTML;
}

/**
 * Puts both flavours on the clipboard, falling back to plain text.
 *
 * `ClipboardItem` is the only way to write two flavours outside a copy event.
 * It can be unavailable or refused, and losing the rich flavour is much better
 * than copying nothing at all.
 */
export async function writeRichText(html: string, markdown: string): Promise<boolean> {
  try {
    // An empty rich flavour is worse than none: a message that is only an
    // attachment has no rendered text, and writing an empty text/html would
    // have an editor paste nothing at all.
    if (html && typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([markdown], { type: 'text/plain' }),
        }),
      ]);
      return true;
    }
  } catch (error) {
    console.warn('[clipboard] Rich copy unavailable, falling back to plain text', error);
  }

  try {
    await navigator.clipboard.writeText(markdown);
    return true;
  } catch (error) {
    console.warn('[clipboard] Could not write to the clipboard', error);
    return false;
  }
}
