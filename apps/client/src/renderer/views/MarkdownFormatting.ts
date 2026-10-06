import { StateEffect, StateField, type EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';

export const inlineFormats = { bold: 1, italic: 2, strike: 4 } as const;
export type InlineFormat = keyof typeof inlineFormats;
export const setTypingFormats = StateEffect.define<number | null>();
export const typingFormats = StateField.define<number | null>({
  create: () => null,
  update: (value, transaction) => {
    for (const effect of transaction.effects) if (effect.is(setTypingFormats)) return effect.value;
    if (transaction.isUserEvent('undo') || transaction.isUserEvent('redo')
      || (transaction.selection && !transaction.docChanged && !transaction.selection.eq(transaction.startState.selection))) return null;
    return value;
  },
});

interface FormatSpan { from: number; to: number; start: number; end: number; flag: number }
interface TextRun { text: string; flags: number }

function spans(state: EditorState): FormatSpan[] {
  const result: FormatSpan[] = [];
  syntaxTree(state).iterate({ enter: node => {
    const flag = node.name === 'StrongEmphasis' ? inlineFormats.bold
      : node.name === 'Emphasis' ? inlineFormats.italic : node.name === 'Strikethrough' ? inlineFormats.strike : 0;
    if (!flag) return;
    const open = node.node.firstChild, close = node.node.lastChild;
    if (open && close) result.push({ from: node.from, to: node.to, start: open.to, end: close.from, flag });
  } });
  return result;
}

function contents(state: EditorState, from: number, to: number, formats: FormatSpan[]) {
  const boundaries = new Set([from, to]);
  for (const span of formats) {
    for (const offset of [span.from, span.start, span.end, span.to]) {
      if (offset > from && offset < to) boundaries.add(offset);
    }
  }
  const offsets = [...boundaries].sort((a, b) => a - b);
  const runs: TextRun[] = [];
  for (let index = 1; index < offsets.length; index++) {
    const start = offsets[index - 1], end = offsets[index];
    if (formats.some(span => (start >= span.from && end <= span.start) || (start >= span.end && end <= span.to))) continue;
    const flags = formats.filter(span => start >= span.start && end <= span.end).reduce((flags, span) => flags | span.flag, 0);
    runs.push({ text: state.sliceDoc(start, end), flags });
  }
  return runs;
}

export function selectedFormats(state: EditorState): number {
  const { from, to } = state.selection.main;
  const formats = spans(state);
  if (from === to) return formats.filter(span => from >= span.start && from <= span.end).reduce((flags, span) => flags | span.flag, 0);
  const runs = contents(state, from, to, formats).filter(run => run.text.trim());
  return runs.length ? runs.reduce((flags, run) => flags & run.flags, 7) : 0;
}

function serialize(runs: TextRun[], start: number, end: number) {
  const groups: TextRun[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const previous = groups[groups.length - 1];
    if (previous?.flags === run.flags) previous.text += run.text;
    else groups.push({ ...run });
  }
  let text = '', offset = 0, selectionStart = 0, selectionEnd = 0;
  for (const group of groups) {
    const positions: number[] = [text.length];
    let local = 0;
    const bold = !!(group.flags & inlineFormats.bold), italic = !!(group.flags & inlineFormats.italic);
    const open = (bold ? '**' : '') + (italic ? (bold ? '_' : '*') : '') + (group.flags & inlineFormats.strike ? '~~' : '');
    const close = (group.flags & inlineFormats.strike ? '~~' : '') + (italic ? (bold ? '_' : '*') : '') + (bold ? '**' : '');
    // Keep whitespace outside delimiters so every intermediate keystroke is valid Markdown.
    const lines = group.text.split('\n');
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index], leading = line.match(/^\s*/)?.[0] ?? '';
      const body = line.slice(leading.length).trimEnd();
      const trailing = line.slice(leading.length + body.length);
      const append = (value: string) => {
        for (const character of value.split('')) { text += character; positions[++local] = text.length; }
      };
      append(leading);
      if (body) {
        text += open;
        positions[local] = text.length;
        append(body);
        text += close;
      }
      append(trailing);
      if (index < lines.length - 1) append('\n');
    }
    if (start >= offset && start < offset + group.text.length) selectionStart = positions[start - offset];
    if (end > offset && end <= offset + group.text.length) selectionEnd = positions[end - offset];
    offset += group.text.length;
  }
  if (start === offset) selectionStart = selectionEnd || text.length;
  if (start === end) selectionEnd = selectionStart;
  return { text, selectionStart, selectionEnd };
}

/** Rebalance only touched emphasis runs; source outside the edit stays byte-for-byte intact. */
export function formattingEdit(state: EditorState, from: number, to: number,
  operation: { insert: string; flags: number } | { format: InlineFormat; enabled: boolean }) {
  const formats = spans(state);
  let regionFrom = from, regionTo = to;
  for (const span of formats) {
    const touches = from === to ? from >= span.start && from <= span.end : span.to > from && span.from < to;
    if (touches) { regionFrom = Math.min(regionFrom, span.from); regionTo = Math.max(regionTo, span.to); }
  }
  const before = contents(state, regionFrom, from, formats);
  const after = contents(state, to, regionTo, formats);
  const selected = 'insert' in operation ? [{ text: operation.insert, flags: operation.flags }]
    : contents(state, from, to, formats).map(run => ({
      text: run.text, flags: operation.enabled ? run.flags | inlineFormats[operation.format] : run.flags & ~inlineFormats[operation.format],
    }));
  const start = before.reduce((length, run) => length + run.text.length, 0);
  const end = start + selected.reduce((length, run) => length + run.text.length, 0);
  const result = serialize([...before, ...selected, ...after], start, end);
  return { from: regionFrom, to: regionTo, insert: result.text,
    selectionStart: regionFrom + result.selectionStart, selectionEnd: regionFrom + result.selectionEnd };
}
