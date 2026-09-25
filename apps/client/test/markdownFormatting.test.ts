import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { Strikethrough } from '@lezer/markdown';
import { formattingEdit, inlineFormats, selectedFormats } from '../src/renderer/views/MarkdownFormatting';

function state(doc: string, from: number, to = from) {
  return EditorState.create({ doc, selection: { anchor: from, head: to }, extensions: [markdown({ extensions: [Strikethrough] })] });
}

test('typing styles serialize balanced Markdown and retain a content caret, including whitespace and lines', () => {
  for (const sample of [
    { doc: '', from: 0, insert: 'hello', flags: 1, expected: '**hello**', caret: 7 },
    { doc: '**hello**', from: 7, insert: ' ', flags: 1, expected: '**hello** ', caret: 10 },
    { doc: '**hello** ', from: 10, insert: 'world', flags: 1, expected: '**hello** **world**', caret: 17 },
    { doc: '**hello**', from: 7, insert: 'plain', flags: 0, expected: '**hello**plain', caret: 14 },
    { doc: '**hello**', from: 7, insert: '\n', flags: 1, expected: '**hello**\n', caret: 10 },
    { doc: '', from: 0, insert: 'both', flags: 3, expected: '**_both_**', caret: 7 },
    { doc: '', from: 0, insert: ' one \n two ', flags: 4, expected: ' ~~one~~ \n ~~two~~ ', caret: 19 },
  ]) {
    const initial = state(sample.doc, sample.from);
    const edit = formattingEdit(initial, sample.from, sample.from, { insert: sample.insert, flags: sample.flags });
    const updated = initial.update({ changes: edit }).state;
    assert.equal(updated.doc.toString(), sample.expected);
    assert.equal(edit.selectionEnd, sample.caret, sample.expected);
  }
});

test('selection toggles retain text and other styles, including partial runs', () => {
  for (const sample of [
    { doc: 'text', from: 0, to: 4, enabled: true, expected: '**text**' },
    { doc: '**text**', from: 0, to: 8, enabled: false, expected: 'text' },
    { doc: '**before middle after**', from: 9, to: 15, enabled: false, expected: '**before** middle **after**' },
    { doc: '*italic*', from: 1, to: 7, enabled: true, expected: '**_italic_**' },
    { doc: '**_both_**', from: 3, to: 7, enabled: false, expected: '*both*' },
  ]) {
    const initial = state(sample.doc, sample.from, sample.to);
    const edit = formattingEdit(initial, sample.from, sample.to, { format: 'bold', enabled: sample.enabled });
    assert.equal(initial.update({ changes: edit }).newDoc.toString(), sample.expected);
  }
  assert.equal(selectedFormats(state('**_both_**', 3, 7)), inlineFormats.bold | inlineFormats.italic);
});
