import { Annotation, Compartment, EditorSelection, EditorState, StateEffect, StateField, Transaction, type Range } from '@codemirror/state';
import { Decoration, EditorView, keymap, placeholder, WidgetType, type DecorationSet } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, insertNewlineAndIndent, isolateHistory } from '@codemirror/commands';
import { markdown, markdownKeymap } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import { Strikethrough } from '@lezer/markdown';
import { markdownMessageClipboard, setMessageClipboardData, writeMessageClipboard } from '../utils/messageClipboard';
import { findAutomaticLinks } from '../utils/markdown';
import { bindCodeComposer, renderCodeComposer, type CodeComposerValue } from './CodeComposer';
import { showAlert } from './Dialog';
import { t } from '../i18n';
import { formattingEdit, inlineFormats, selectedFormats, setTypingFormats, typingFormats, type InlineFormat } from './MarkdownFormatting';
import '../styles/markdownInput.css';

const focused = StateEffect.define<boolean>();
const formattedInput = Annotation.define<boolean>();
const inlineLink = /^\[((?:\\.|[^\]\\])*)\]\((https?:\/\/[^\s)]+)\)$/;
export interface MarkdownLink { from: number; to: number; label: string; url: string }
class BulletMarker extends WidgetType {
  toDOM(): HTMLElement {
    const marker = document.createElement('span');
    marker.className = 'md-editor-bullet';
    marker.textContent = '\u2022';
    marker.setAttribute('aria-hidden', 'true');
    return marker;
  }
}
const codeEditors = new WeakMap<HTMLElement, {
  widget: CodeEditor;
  controller: ReturnType<typeof bindCodeComposer>;
  view: EditorView;
}>();

class CodeEditor extends WidgetType {
  constructor(readonly from: number, readonly to: number, readonly contentFrom: number,
    readonly value: CodeComposerValue, readonly closed: boolean, readonly disabled: boolean) { super(); }
  override eq(other: CodeEditor): boolean {
    return this.from === other.from && this.to === other.to && this.value.code === other.value.code
      && this.value.language === other.value.language && this.closed === other.closed && this.disabled === other.disabled;
  }
  override get estimatedHeight(): number { return Math.min(240, this.value.code.split('\n').length * 20 + 16) + 34; }
  toDOM(view: EditorView): HTMLElement {
    const element = document.createElement('fieldset');
    element.className = 'chat-composer-block chat-composer-block-code md-editor-code-widget';
    element.innerHTML = renderCodeComposer(this.value, `<button type="button" class="chat-block-remove" data-remove
      aria-label="${t('chat.removeBlock')}" title="${t('chat.removeBlock')}"><span class="material-symbols-outlined md-16" aria-hidden="true">close</span></button>`);
    element.disabled = this.disabled;
    const state = { widget: this, view, controller: bindCodeComposer(element, this.value, value => {
      const widget = state.widget;
      if (widget.disabled) return;
      const code = value.code.replace(/```/g, '`\u200b``');
      const insert = '```' + (value.language === 'plaintext' ? '' : value.language) + '\n'
        + code + (widget.closed ? '\n```' : '');
      const host = view.dom.closest('monky-markdown-input');
      if (host instanceof MarkdownInput && host.maxLength >= 0
        && view.state.doc.length - (widget.to - widget.from) + insert.length > host.maxLength) {
        state.controller.update(widget.value);
        void showAlert({ message: t('chat.messageTooLong', { max: host.maxLength }), variant: 'danger' });
        return;
      }
      view.dispatch({ changes: { from: widget.from, to: widget.to, insert },
        annotations: [formattedInput.of(true), Transaction.userEvent.of('input.code')] });
    }, () => view.requestMeasure()) };
    codeEditors.set(element, state);
    element.querySelector('[data-remove]')?.addEventListener('click', () => {
      const widget = state.widget;
      if (!widget.disabled) view.dispatch({ changes: { from: widget.from, to: widget.to, insert: '' },
        annotations: [formattedInput.of(true), isolateHistory.of('full'), Transaction.userEvent.of('delete.code')] });
    });
    queueMicrotask(() => { if (element.isConnected) state.controller.update(state.widget.value); });
    this.attributes(element);
    return element;
  }
  private attributes(element: HTMLElement): void {
    element.dataset.codeFrom = String(this.contentFrom);
    element.dataset.codeTo = String(this.contentFrom + this.value.code.length);
    element.dataset.blockFrom = String(this.from);
    element.dataset.blockTo = String(this.to);
  }
  override updateDOM(element: HTMLElement): boolean {
    const state = codeEditors.get(element);
    if (!state) return false;
    state.widget = this;
    (element as HTMLFieldSetElement).disabled = this.disabled;
    state.controller.update(this.value);
    this.attributes(element);
    return true;
  }
  override destroy(element: HTMLElement): void {
    const state = codeEditors.get(element);
    const hadFocus = element.contains(document.activeElement);
    state?.controller.destroy();
    codeEditors.delete(element);
    if (hadFocus && state) queueMicrotask(() => {
      const host = state.view.dom.closest('monky-markdown-input');
      if (host instanceof MarkdownInput && host.isConnected && document.activeElement === document.body) host.focus();
    });
  }
  override ignoreEvent(): boolean { return true; }
}
const focusState = StateField.define({
  create: () => false,
  update: (value, transaction) => transaction.effects.find(effect => effect.is(focused))?.value ?? value,
});

function previewDecorations(state: EditorState): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  const active = (from: number, to: number) => state.field(focusState)
    && state.selection.ranges.some(range => range.from <= to && range.to >= from);
  const mark = (from: number, to: number, className: string, tagName?: string) => {
    if (to > from) decorations.push(Decoration.mark({ class: className, tagName }).range(from, to));
  };
  const marker = (from: number, to: number, reveal: boolean) => {
    if (to <= from) return;
    decorations.push((reveal
      ? Decoration.mark({ class: 'md-editor-syntax', attributes: { 'aria-hidden': 'true' } })
      : Decoration.replace({})).range(from, to));
  };
  const line = (from: number, className: string, attributes?: Record<string, string>) =>
    decorations.push(Decoration.line({ class: className, attributes }).range(state.doc.lineAt(from).from));
  const link = (from: number, to: number, label: string, url: string) => {
    decorations.push(Decoration.mark({ class: 'md-editor-link', attributes: {
      'data-md-link-from': String(from), 'data-md-link-to': String(to),
      'data-md-link-label': label, 'data-md-link-url': url,
    } }).range(from, to));
  };
  for (const automatic of findAutomaticLinks(state.doc.toString(), syntaxTree(state))) {
    link(automatic.from, automatic.to, state.sliceDoc(automatic.from, automatic.to), automatic.url);
  }
  syntaxTree(state).iterate({
    enter: node => {
      const reveal = active(node.from, node.to);
      if (/^ATXHeading[1-6]$/.test(node.name)) {
        line(node.from, `md-editor-heading md-editor-h${node.name.slice(-1)}`);
        const prefix = state.sliceDoc(node.from, node.to).match(/^#{1,6}\s*/)?.[0];
        if (prefix) marker(node.from, node.from + prefix.length, reveal);
      } else if (['StrongEmphasis', 'Emphasis', 'Strikethrough', 'InlineCode'].includes(node.name)) {
        const tag = node.name === 'StrongEmphasis' ? 'strong' : node.name === 'Emphasis' ? 'em'
          : node.name === 'Strikethrough' ? 'del' : 'code';
        mark(node.from, node.to, `md-editor-${tag}`, tag);
        for (let child = node.node.firstChild; child; child = child.nextSibling) {
          if (child.name.endsWith('Mark')) marker(child.from, child.to, reveal);
        }
      } else if (node.name === 'Link') {
        const text = state.sliceDoc(node.from, node.to);
        const match = text.match(inlineLink);
        if (match) {
          link(node.from, node.to, match[1], match[2]);
          marker(node.from, node.from + 1, reveal);
          marker(node.from + 1 + match[1].length, node.to, reveal);
          for (const escape of match[1].matchAll(/\\[\\[\]]/g)) marker(node.from + 1 + escape.index, node.from + 2 + escape.index, reveal);
        }
      } else if (node.name === 'Escape') {
        marker(node.from, node.from + 1, false);
      } else if (node.name === 'Blockquote') {
        const first = state.doc.lineAt(node.from).number;
        const last = state.doc.lineAt(node.to).number;
        for (let number = first; number <= last; number++) {
          const current = state.doc.line(number);
          line(current.from, 'md-editor-quote');
          const prefix = current.text.match(/^\s*>\s?/);
          if (prefix) marker(current.from, current.from + prefix[0].length, active(current.from, current.to));
        }
      } else if (node.name === 'ListItem') {
        line(node.from, 'md-editor-list-item');
        const current = state.doc.lineAt(node.from);
        const prefix = current.text.slice(node.from - current.from).match(/^(?:\d+[.)]|[-*+])\s+/);
        if (prefix && /^[-*+]/.test(prefix[0])) {
          decorations.push(Decoration.replace({ widget: new BulletMarker() }).range(node.from, node.from + 1));
        } else if (prefix) mark(node.from, node.from + prefix[0].length, 'md-editor-list-marker');
      } else if (node.name === 'HorizontalRule') {
        line(node.from, 'md-editor-separator');
        marker(node.from, node.to, reveal);
      } else if (node.name === 'FencedCode') {
        const first = state.doc.lineAt(node.from);
        const closing = node.node.lastChild;
        const closed = closing?.name === 'CodeMark' && closing.from > node.from;
        const language = node.node.getChild('CodeInfo');
        const tag = language ? state.sliceDoc(language.from, language.to) : '';
        const contentFrom = Math.min(first.to + 1, node.to);
        const contentTo = closed ? Math.max(contentFrom, state.doc.lineAt(closing.from).from - 1) : node.to;
        decorations.push(Decoration.replace({ block: true,
          widget: new CodeEditor(node.from, node.to, contentFrom,
            { language: tag || 'plaintext', code: state.sliceDoc(contentFrom, contentTo) },
            !!closed, state.readOnly || !state.facet(EditorView.editable)),
        }).range(node.from, node.to));
        return false;
      }
    },
  });
  // A heading marker already responds visually before its first space is typed.
  for (const range of state.selection.ranges) {
    const current = state.doc.lineAt(range.head);
    if (/^#{1,6}$/.test(current.text)) mark(current.from, current.to, 'md-editor-syntax');
  }
  return Decoration.set(decorations, true);
}

const preview = StateField.define<DecorationSet>({
  create: previewDecorations,
  update: (_value, transaction) => previewDecorations(transaction.state),
  provide: field => EditorView.decorations.from(field),
});

function selectedClipboard(view: EditorView) {
  const { from, to } = view.state.selection.main;
  let before = '', after = '';
  syntaxTree(view.state).iterate({
    from, to,
    enter: node => {
      if (['StrongEmphasis', 'Emphasis', 'Strikethrough', 'InlineCode'].includes(node.name)) {
        const open = node.node.firstChild, close = node.node.lastChild;
        if (!open || !close) return;
        if (from >= open.to && from < close.from) before += view.state.sliceDoc(open.from, open.to);
        if (to <= close.from && to > open.to) after = view.state.sliceDoc(close.from, close.to) + after;
      } else if (/^ATXHeading[1-6]$/.test(node.name)) {
        const prefix = view.state.sliceDoc(node.from, node.to).match(/^#{1,6}\s+/)?.[0];
        if (prefix && from >= node.from + prefix.length && from < node.to) before += prefix;
      } else if (node.name === 'Link') {
        const match = view.state.sliceDoc(node.from, node.to).match(inlineLink);
        if (match) {
          const start = node.from + 1, end = start + match[1].length;
          if (from >= start && from < end) before += '[';
          if (to > start && to <= end) after = `](${match[2]})` + after;
        }
      } else if (node.name === 'FencedCode') {
        const code = node.node.getChild('CodeText');
        const language = node.node.getChild('CodeInfo');
        if (code && from >= code.from && to <= code.to) {
          before += '```' + (language ? view.state.sliceDoc(language.from, language.to) : '') + '\n';
          after = '\n```' + after;
        }
        return false;
      }
    },
  });
  return markdownMessageClipboard(before + view.state.sliceDoc(from, to) + after);
}

/** Markdown is the document model; decorations never rewrite the user's text. */
export class MarkdownInput extends HTMLElement {
  static observedAttributes = ['placeholder', 'readonly', 'disabled', 'aria-label', 'aria-describedby',
    'aria-expanded', 'aria-controls', 'aria-autocomplete', 'aria-activedescendant', 'role'];
  private editor: EditorView | null = null;
  private documentValue = '';
  private anchor = 0;
  private head = 0;
  private silent = false;
  private composition: { from: number; flags: number } | null = null;
  private placeholderSize: ResizeObserver | null = null;
  private readonly configuration = new Compartment();

  constructor() {
    super();
    this.addEventListener('input', event => {
      if (event.target !== this) event.stopImmediatePropagation();
    });
    this.addEventListener('mousedown', event => { if (event.target === this) this.focus(); });
  }

  connectedCallback(): void {
    if (this.editor) return;
    this.editor = new EditorView({
      parent: this,
      state: this.createState(),
    });
    this.placeholderSize = new ResizeObserver(() => this.refresh());
    this.placeholderSize.observe(this.editor.contentDOM);
    this.refresh();
  }

  disconnectedCallback(): void {
    this.destroy();
  }

  destroy(): void {
    this.placeholderSize?.disconnect();
    this.placeholderSize = null;
    this.composition = null;
    this.documentValue = this.value;
    this.anchor = this.selectionStart;
    this.head = this.selectionEnd;
    this.editor?.destroy();
    this.editor = null;
  }

  attributeChangedCallback(): void {
    this.editor?.dispatch({ effects: this.configuration.reconfigure(this.editorAttributes()) });
    this.refresh();
  }

  private editorAttributes() {
    const attributes: Record<string, string> = { 'aria-multiline': 'true', 'aria-readonly': String(this.readOnly) };
    for (const name of MarkdownInput.observedAttributes.filter(name => name.startsWith('aria-') || name === 'role')) {
      const value = this.getAttribute(name);
      if (value !== null) attributes[name] = value;
    }
    return [EditorState.readOnly.of(this.readOnly || this.disabled), EditorView.editable.of(!this.disabled),
      EditorView.contentAttributes.of(attributes), placeholder(this.placeholder)];
  }

  private createState(): EditorState {
    return EditorState.create({
      doc: this.documentValue,
      selection: EditorSelection.single(Math.min(this.anchor, this.documentValue.length), Math.min(this.head, this.documentValue.length)),
      extensions: [
        markdown({ extensions: [Strikethrough] }), history(), EditorView.lineWrapping,
        focusState, typingFormats, preview,
        this.configuration.of(this.editorAttributes()),
        EditorView.focusChangeEffect.of((_state, value) => focused.of(value)),
        EditorState.changeFilter.of(transaction => !transaction.docChanged || this.maxLength < 0
          || transaction.newDoc.length <= this.maxLength || transaction.newDoc.length < transaction.startState.doc.length),
        EditorState.transactionFilter.of(transaction => {
          const flags = transaction.startState.field(typingFormats);
          if (flags === null || this.composition || transaction.annotation(formattedInput)
            || (!transaction.isUserEvent('input') && !transaction.isUserEvent('delete'))
            || transaction.isUserEvent('input.paste') || !transaction.docChanged) return transaction;
          const changes: { from: number; to: number; text: string }[] = [];
          transaction.changes.iterChanges((from, to, _newFrom, _newTo, text) => changes.push({ from, to, text: text.toString() }));
          if (changes.length !== 1) return transaction;
          const change = changes[0];
          const edit = formattingEdit(transaction.startState, change.from, change.to, { insert: change.text, flags });
          const length = transaction.startState.doc.length - (edit.to - edit.from) + edit.insert.length;
          if (this.maxLength >= 0 && length > this.maxLength && length >= transaction.startState.doc.length) return [];
          return { changes: edit, selection: EditorSelection.cursor(edit.selectionEnd),
            effects: setTypingFormats.of(flags), scrollIntoView: true,
            annotations: [formattedInput.of(true), Transaction.userEvent.of(transaction.annotation(Transaction.userEvent) ?? 'input.type')] };
        }),
        keymap.of([
          ...markdownKeymap,
          ...markdownKeymap.map(binding => binding.key === 'Enter' ? { ...binding, key: 'Shift-Enter' } : binding),
          { key: 'Shift-Enter', run: insertNewlineAndIndent },
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        EditorView.domEventHandlers({
          focus: () => { this.dispatchEvent(new FocusEvent('focus')); return false; },
          blur: () => { this.dispatchEvent(new FocusEvent('blur')); return false; },
          compositionstart: (_event, view) => {
            const flags = view.state.field(typingFormats);
            this.composition = flags === null ? null : { from: view.state.selection.main.from, flags };
            return false;
          },
          compositionend: (_event, view) => {
            const composition = this.composition;
            queueMicrotask(() => {
              this.composition = null;
              if (this.editor === view && this.isConnected) {
                if (composition && !this.readOnly && !this.disabled) {
                  const to = view.state.selection.main.to;
                  const edit = formattingEdit(view.state, composition.from, to, {
                    insert: view.state.sliceDoc(composition.from, to), flags: composition.flags,
                  });
                  if (this.maxLength < 0 || view.state.doc.length - (edit.to - edit.from) + edit.insert.length <= this.maxLength) {
                    view.dispatch({ changes: edit, selection: EditorSelection.cursor(edit.selectionEnd),
                      effects: setTypingFormats.of(composition.flags),
                      annotations: [formattedInput.of(true), Transaction.userEvent.of('input.type.compose')] });
                  } else void showAlert({ message: t('chat.messageTooLong', { max: this.maxLength }), variant: 'danger' });
                }
                this.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText' }));
              }
            });
            return false;
          },
          copy: (event, view) => {
            if (!event.clipboardData || view.state.selection.main.empty) return false;
            event.preventDefault();
            setMessageClipboardData(event.clipboardData, selectedClipboard(view));
            return true;
          },
          keydown: (event, view) => {
            if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 'c'
              || view.state.selection.main.empty) return false;
            event.preventDefault();
            void writeMessageClipboard(selectedClipboard(view), event.shiftKey ? 'plain' : 'formatted').catch(error => {
              console.warn('[MarkdownInput] Clipboard copy failed:', error);
              void showAlert({ message: t('chat.copyFailed'), variant: 'danger' });
            });
            return true;
          },
        }),
        EditorView.updateListener.of(update => {
          if (update.docChanged || update.selectionSet || update.transactions.some(transaction => transaction.effects.some(effect => effect.is(setTypingFormats)))) {
            queueMicrotask(() => { if (this.editor === update.view && this.isConnected) this.dispatchEvent(new Event('format-change', { bubbles: true })); });
          }
          if (!update.docChanged || this.silent) return;
          const composing = update.view.composing;
          const inputType = update.transactions.some(transaction => transaction.isUserEvent('undo')) ? 'historyUndo'
            : update.transactions.some(transaction => transaction.isUserEvent('redo')) ? 'historyRedo' : 'insertText';
          queueMicrotask(() => {
            if (this.editor === update.view && this.isConnected) {
              this.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: composing, inputType }));
            }
          });
        }),
      ],
    });
  }

  get value(): string { return this.editor?.state.doc.toString() ?? this.documentValue; }
  set value(value: string) {
    if (value === this.value) return;
    this.documentValue = value;
    this.composition = null;
    this.anchor = this.head = value.length;
    this.silent = true;
    try {
      this.editor?.setState(this.createState());
      this.editor?.dispatch({ effects: focused.of(this.hasFocus) });
    } finally { this.silent = false; }
  }
  private codeSelection(): { input: HTMLTextAreaElement; from: number } | null {
    const input = document.activeElement;
    const block = input instanceof HTMLTextAreaElement && this.contains(input) ? input.closest<HTMLElement>('.md-editor-code-widget') : null;
    return block && input instanceof HTMLTextAreaElement ? { input, from: Number(block.dataset.codeFrom) } : null;
  }
  get selectionStart(): number { const code = this.codeSelection(); return code ? code.from + code.input.selectionStart : this.editor?.state.selection.main.from ?? this.anchor; }
  get selectionEnd(): number { const code = this.codeSelection(); return code ? code.from + code.input.selectionEnd : this.editor?.state.selection.main.to ?? this.head; }
  get hasFocus(): boolean { return this.contains(document.activeElement); }
  linkAt(target: Element): MarkdownLink | null {
    const element = target.closest<HTMLElement>('[data-md-link-from]');
    if (!element || !this.contains(element)) return null;
    return { from: Number(element.dataset.mdLinkFrom), to: Number(element.dataset.mdLinkTo),
      label: element.dataset.mdLinkLabel ?? '', url: element.dataset.mdLinkUrl ?? '' };
  }
  get activeFormats(): number { return this.editor ? this.editor.state.field(typingFormats) ?? selectedFormats(this.editor.state) : 0; }
  toggleFormat(format: InlineFormat): void {
    if (!this.editor || this.readOnly || this.disabled) return;
    const { state } = this.editor;
    const flags = this.activeFormats ^ inlineFormats[format];
    const { from, to } = state.selection.main;
    if (from === to) this.editor.dispatch({ effects: setTypingFormats.of(flags), annotations: isolateHistory.of('full') });
    else {
      const edit = formattingEdit(state, from, to, { format, enabled: !!(flags & inlineFormats[format]) });
      if (this.maxLength >= 0 && state.doc.length - (edit.to - edit.from) + edit.insert.length > this.maxLength) {
        void showAlert({ message: t('chat.messageTooLong', { max: this.maxLength }), variant: 'danger' });
        return;
      }
      this.editor.dispatch({ changes: edit, selection: EditorSelection.range(edit.selectionStart, edit.selectionEnd),
        effects: setTypingFormats.of(flags),
        annotations: [formattedInput.of(true), isolateHistory.of('full'), Transaction.userEvent.of('input.format')] });
    }
    this.focus();
  }
  get readOnly(): boolean { return this.hasAttribute('readonly'); }
  set readOnly(value: boolean) { this.toggleAttribute('readonly', value); }
  get disabled(): boolean { return this.hasAttribute('disabled'); }
  set disabled(value: boolean) { this.toggleAttribute('disabled', value); }
  get placeholder(): string { return this.getAttribute('placeholder') ?? ''; }
  set placeholder(value: string) { this.setAttribute('placeholder', value); }
  get maxLength(): number { return this.hasAttribute('maxlength') ? Number(this.getAttribute('maxlength')) : -1; }
  set maxLength(value: number) { this.setAttribute('maxlength', String(value)); }

  override focus(options?: FocusOptions): void {
    const start = this.selectionStart, end = this.selectionEnd;
    const code = [...this.querySelectorAll<HTMLElement>('.md-editor-code-widget')].find(element =>
      start === end ? end >= Number(element.dataset.blockFrom) && end <= Number(element.dataset.blockTo)
        : start >= Number(element.dataset.codeFrom) && end <= Number(element.dataset.codeTo));
    if (code) {
      const input = code.querySelector('textarea')!;
      input.focus(options);
      const position = (offset: number) => Math.max(0, Math.min(input.value.length, offset - Number(code.dataset.codeFrom)));
      input.setSelectionRange(position(start), position(end));
    } else this.editor?.focus();
  }
  override blur(): void {
    if (this.hasFocus && document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }
  refresh(): void {
    this.editor?.requestMeasure({
      read: view => view.contentDOM.querySelector('.cm-placeholder')?.getBoundingClientRect().height ?? 0,
      write: (height, view) => {
        const value = `${height}px`;
        if (view.contentDOM.style.getPropertyValue('--md-placeholder-height') !== value) {
          view.contentDOM.style.setProperty('--md-placeholder-height', value);
        }
      },
    });
  }
  select(): void { this.setSelectionRange(0, this.value.length); }
  setSelectionRange(start: number, end: number, direction?: string): void {
    start = Math.max(0, Math.min(start, this.value.length));
    end = Math.max(start, Math.min(end, this.value.length));
    this.anchor = direction === 'backward' ? end : start;
    this.head = direction === 'backward' ? start : end;
    this.editor?.dispatch({ selection: EditorSelection.single(this.anchor, this.head) });
    if (this.hasFocus) {
      const block = [...this.querySelectorAll<HTMLElement>('.md-editor-code-widget')].find(element =>
        start >= Number(element.dataset.codeFrom) && end <= Number(element.dataset.codeTo));
      if (block) {
        const input = block.querySelector('textarea')!;
        input.focus();
        input.setSelectionRange(start - Number(block.dataset.codeFrom), end - Number(block.dataset.codeFrom), direction === 'backward' ? 'backward' : 'forward');
      } else this.editor?.focus();
    }
  }
  setRangeText(text: string, start = this.selectionStart, end = this.selectionEnd, mode: SelectionMode = 'preserve'): void {
    this.replace(text, start, end, mode, false);
  }
  insertText(text: string, start = this.selectionStart, end = this.selectionEnd, mode: SelectionMode = 'end'): void {
    if (!this.readOnly && !this.disabled) this.replace(text, start, end, mode, true);
  }
  private replace(text: string, start: number, end: number, mode: SelectionMode, notify: boolean): void {
    if (!this.editor) return;
    this.silent = !notify;
    try {
      this.editor.dispatch({
        changes: { from: start, to: end, insert: text },
        selection: mode === 'preserve' ? undefined : EditorSelection.single(
          mode === 'end' ? start + text.length : start, mode === 'start' ? start : start + text.length),
        userEvent: 'input',
        effects: setTypingFormats.of(null),
        annotations: [formattedInput.of(true), isolateHistory.of('full')],
        scrollIntoView: true,
      });
    } finally { this.silent = false; }
  }
}

customElements.define('monky-markdown-input', MarkdownInput);
