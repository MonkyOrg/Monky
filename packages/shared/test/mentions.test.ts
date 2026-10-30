import assert from 'node:assert/strict';
import test from 'node:test';
import { MentionMatcher, hasEveryoneMention } from '../src/mentions.js';

const names = (matcher: MentionMatcher, text: string) => matcher.find(text).map(mention => mention.name);

test('a nickname that starts another one is not mentioned by the longer one', () => {
  const matcher = new MentionMatcher(['Lu', 'Lucas', 'Luana']);
  assert.deepEqual(names(matcher, '@Lucas e @Luana, cadê a @Lu?'), ['Lucas', 'Luana', 'Lu']);
  assert.equal(matcher.mentions('@Lucas', 'Lu'), false);
  assert.equal(matcher.mentions('@Lucas', 'Lucas'), true);
  // Even when "Lucas" is unknown, "@Lucas" never reaches "Lu".
  assert.deepEqual(names(new MentionMatcher(['Lu']), '@Lucas @Lu2 @Lu_x @Lu-x @Luã'), []);
});

test('the longest known name wins, mentions never overlap and fall back to a shorter name', () => {
  const matcher = new MentionMatcher(['Ana', 'Ana Paula', 'a@b', 'b']);
  assert.deepEqual(names(matcher, '@Ana Paula, oi'), ['Ana Paula']);
  assert.deepEqual(names(matcher, '@Ana e @Ana Paula'), ['Ana', 'Ana Paula']);
  assert.deepEqual(names(matcher, '@Ana Paulada'), ['Ana']);
  assert.deepEqual(names(matcher, '@a@b'), ['a@b']);
  assert.deepEqual(matcher.find('oi @Ana Paula!'), [{ index: 3, length: 10, name: 'Ana Paula', everyone: false }]);
});

test('a mention starts after a space, bracket, quote or emphasis and never inside an address or a word', () => {
  const matcher = new MentionMatcher(['Lu', 'mail']);
  for (const text of ['@Lu', 'oi @Lu', '(@Lu)', '[@Lu]', '"@Lu"', "'@Lu'", '“@Lu”', '**@Lu**', '*@Lu*', '~~@Lu~~',
    '> @Lu', '>@Lu', 'oi\n@Lu', 'oi\u00a0@Lu', '<@Lu>']) {
    assert.deepEqual(names(matcher, text), ['Lu'], text);
  }
  for (const text of ['x@Lu', 'ana@mail.com', 'site.com/@Lu', 'a=@Lu', '1@Lu', 'é@Lu', '😀@Lu', 'oi,@Lu', '\\@Lu']) {
    assert.deepEqual(names(matcher, text), [], text);
  }
});

test('a mention ends at punctuation, spaces or emoji, ignoring letter case', () => {
  const matcher = new MentionMatcher(['Lucas', 'Ângela 🐒', '$ara', 'a.b']);
  for (const text of ['@Lucas.', '@Lucas!', '@Lucas?', '@Lucas,', '@Lucas;', '@Lucas:', "@Lucas's", '@Lucas)', '@Lucas**',
    '@lucas', '@LUCAS 😀', '@Lucas😀', '@Lucas/Ana']) {
    assert.deepEqual(names(matcher, text), ['Lucas'], text);
  }
  assert.deepEqual(names(matcher, 'oi @ângela 🐒!'), ['Ângela 🐒']);
  assert.deepEqual(names(matcher, '@$ara e @a.b, mas não @aXb'), ['$ara', 'a.b']);
});

test('code spans and blocks never mention anyone, as the chat draws them as code', () => {
  const matcher = new MentionMatcher(['Lu'], { everyone: true });
  for (const text of ['`@Lu`', 'use `@todos` para chamar todos', '```\n@Lu\n```', '```ts\nconst a = "@todos";\n```',
    '```@Lu```', 'a ```x\n@Lu``` b']) {
    assert.deepEqual(names(matcher, text), [], text);
  }
  assert.deepEqual(names(matcher, '@Lu `codigo` @todos'), ['Lu', 'todos']);
  assert.deepEqual(names(matcher, '`a` @Lu `b`'), ['Lu']);
  assert.deepEqual(names(matcher, '```\ncode\n```\n@Lu'), ['Lu']);
});

test('@todos and @everyone follow the same rule and only when the server allows them', () => {
  const allowed = new MentionMatcher(['Todos', 'todos os dias'], { everyone: true });
  for (const text of ['@todos', '@everyone', '@TODOS!', '**@todos**', '(@everyone)']) {
    assert.deepEqual(allowed.find(text).map(mention => mention.everyone), [true], text);
  }
  for (const text of ['contato@todos.com.br', '@todosaqui', '@todos-aqui', 'x@everyone']) {
    assert.deepEqual(allowed.find(text).filter(mention => mention.everyone), [], text);
  }
  assert.equal(allowed.mentions('bom dia @todos', 'Ana'), true);
  // A longer nickname still wins over the token.
  assert.deepEqual(allowed.find('@todos os dias'), [{ index: 0, length: 14, name: 'todos os dias', everyone: false }]);
  const refused = new MentionMatcher(['Todos']);
  assert.deepEqual(refused.find('@todos'), [{ index: 0, length: 6, name: 'Todos', everyone: false }]);
  assert.equal(refused.mentions('@everyone', 'Ana'), false);
  assert.equal(hasEveryoneMention('bom dia @todos'), true);
  assert.equal(hasEveryoneMention('**@everyone**'), true);
  assert.equal(hasEveryoneMention('contato@todos.com.br'), false);
  assert.equal(hasEveryoneMention('`@todos`'), false);
});

test('names are trimmed, blanks ignored and unknown names never match', () => {
  const matcher = new MentionMatcher(['  Lucas  ', '', '   ']);
  assert.deepEqual(names(matcher, '@Lucas'), ['Lucas']);
  assert.equal(matcher.mentions('@Lucas', ' lucas '), true);
  assert.equal(matcher.mentions('@Lucas', 'Ana'), false);
  assert.equal(matcher.mentions('@Lucas', ''), false);
  assert.deepEqual(new MentionMatcher([]).find('@Lucas'), []);
});

test('emphasis may open right before the @, as Markdown draws it, but never glues a mention to a word', () => {
  const matcher = new MentionMatcher(['Lu']);
  for (const text of ['_@Lu_', '__@Lu__', '*@Lu*', '***@Lu***', '~~@Lu~~', '(**@Lu**)', '> _@Lu_', 'oi _@lu_!', '@Lu_.']) {
    assert.deepEqual(names(matcher, text), ['Lu'], text);
  }
  for (const text of ['ana_@lu.com', 'a*@Lu', 'x~~@Lu', '2__@Lu', '@Lu_x', '_@Lu__init__']) {
    assert.deepEqual(names(matcher, text), [], text);
  }
  assert.deepEqual(names(new MentionMatcher(['Lu', 'Lu_']), '_@Lu__'), ['Lu_'], 'A name ending in _ still wins as the longest');
});

test('an @ inside a web address or a Markdown link destination mentions nobody, the link text still does', () => {
  const matcher = new MentionMatcher(['Lucas'], { everyone: true });
  for (const text of ['https://x.com/(@Lucas)', '[perfil](https://exemplo.com/(@Lucas)/x)', "www.site.com/'@Lucas",
    'HTTP://X.COM/"@todos"', '[a](https://x.com/(@todos))']) {
    assert.deepEqual(names(matcher, text), [], text);
  }
  assert.deepEqual(names(matcher, '[@Lucas](https://monky.chat)'), ['Lucas']);
  assert.deepEqual(names(matcher, '@Lucas https://x.com/(@Lucas) (@Lucas)'), ['Lucas', 'Lucas']);
  assert.deepEqual(names(matcher, 'https://x.com\n(@Lucas)'), ['Lucas']);
});

test('the chat may swap NUL for U+FFFD before drawing without changing what is mentioned', () => {
  const matcher = new MentionMatcher(['Lu']);
  for (const text of ['@Lu\u0000x', '\u0000@Lu', 'x\u0000@Lu', '`@Lu\u0000`', 'https://a.com/\u0000(@Lu)']) {
    assert.deepEqual(matcher.find(text), matcher.find(text.replaceAll('\u0000', '\uFFFD')), JSON.stringify(text));
  }
});

test('finding mentions does not grow with the number of members', () => {
  const members = Array.from({ length: 500 }, (_, index) => `Member ${index}`);
  const messages = Array.from({ length: 250 }, (_, index) =>
    `Oi @Member ${index % 500}, viu o que o @Member ${(index * 7) % 500} disse? ${'texto '.repeat(40)}`);
  const started = performance.now();
  const matcher = new MentionMatcher(members, { everyone: true });
  let found = 0;
  for (const message of messages) found += matcher.find(message).length;
  const elapsed = performance.now() - started;
  assert.equal(found, 500);
  assert.ok(elapsed < 500, `250 messages × 500 members took ${elapsed.toFixed(1)} ms`);
});
