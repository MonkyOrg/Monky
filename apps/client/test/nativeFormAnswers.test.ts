import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeLiveFormResultsSchema, nativeLiveFormSchema } from '@monky/shared';
import { setLanguage, t } from '../src/renderer/i18n';
import {
  answerGroups, answerLabel, answerShares, answeredResponses, resultsCsv,
} from '../src/renderer/views/community/nativeFormAnswers';

const form = (anonymous: boolean) => nativeLiveFormSchema.parse({
  id: 'form', channelId: 'text', creatorUserId: 'owner', expiresAt: 2_000, closedAt: null, createdAt: 1_000, revision: 1,
  responseCount: 3, myResponse: null,
  form: {
    title: 'Survey', anonymous,
    fields: [
      { name: 'name', label: 'Name', type: 'text' },
      { name: 'age', label: 'Age', type: 'integer' },
      { name: 'confirmed', label: 'Confirmed', type: 'boolean' },
      { name: 'team', label: 'Team', type: 'select', choices: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }] },
      { name: 'topics', label: 'Topics', type: 'multi-select', choices: [{ value: 'news', label: 'News' }, { value: 'events', label: 'Events' }] },
      { name: 'rating', label: 'Rating', type: 'rating' },
    ],
  },
});

const responses = nativeLiveFormResultsSchema.parse({
  id: 'form', nextCursor: null,
  responses: [
    { user: { id: 'ana', nickname: 'Ana', avatarUrl: null },
      response: { values: { name: '=1+1', age: 20, confirmed: true, team: 'a', topics: ['news', 'events'], rating: 5 }, createdAt: 1_000, updatedAt: 1_500 } },
    { user: { id: 'bia', nickname: 'Bia "B"', avatarUrl: null },
      response: { values: { name: 'Line one\r\nline two', age: 30, confirmed: false, team: 'a', topics: ['events', 'news'] }, createdAt: 1_000, updatedAt: 1_000 } },
    { user: null, response: { values: { name: '', age: 20, team: 'b', topics: [] } } },
  ],
}).responses;

const field = (name: string) => form(false).form.fields.find(entry => entry.name === name)!;

test('only real answers count: nothing, an empty text and an empty list are no answer', () => {
  assert.deepEqual(answeredResponses(responses, field('name')).map(entry => entry.user?.id ?? null), ['ana', 'bia']);
  assert.equal(answeredResponses(responses, field('topics')).length, 2);
  assert.equal(answeredResponses(responses, field('rating')).length, 1);
});

test('answers read as people see them, in the language of the app', () => {
  setLanguage('en');
  const survey = form(false);
  assert.equal(answerLabel(survey, 'confirmed', true), t('botChat.switchOn'));
  assert.equal(answerLabel(survey, 'confirmed', false), t('botChat.switchOff'));
  assert.equal(answerLabel(survey, 'team', 'b'), 'Beta');
  assert.equal(answerLabel(survey, 'topics', ['events', 'news']), 'Events, News');
  assert.equal(answerLabel(survey, 'rating', 4), t('liveForm.ratingResult', { value: 4 }));
  assert.equal(answerLabel(survey, 'name', ''), t('liveForm.noAnswer'));
  assert.equal(answerLabel(survey, 'topics', []), t('liveForm.noAnswer'));
  setLanguage('pt-BR');
});

test('closed questions split their answers among the choices; free text has no split', () => {
  assert.equal(answerShares(responses, field('name')), null);
  assert.deepEqual(answerShares(responses, field('team'))?.map(({ label, count, share, percentage }) => [label, count, share, percentage]),
    [['Alpha', 2, 66.67, 67], ['Beta', 1, 33.33, 33]]);
  // Every chosen value counts once for its option.
  assert.deepEqual(answerShares(responses, field('topics'))?.map(item => item.count), [2, 2]);
  assert.deepEqual(answerShares(responses, field('confirmed'))?.map(item => item.count), [1, 1]);
  assert.deepEqual(answerShares(responses, field('rating'))?.map(item => item.count), [0, 0, 0, 0, 1]);
  // A number question splits by value, in order, while it has at most ten.
  assert.deepEqual(answerShares(responses, field('age'))?.map(item => [item.label, item.count]), [['20', 2], ['30', 1]]);
  const many = Array.from({ length: 11 }, (_, index) => ({ user: null, response: { values: { age: index } } }));
  assert.equal(answerShares(many, field('age')), null);
});

test('identical answers group together, whatever the order of a multiple choice', () => {
  const groups = answerGroups(form(false), responses, field('topics'));
  assert.deepEqual(groups.map(group => group.responseIndices), [[0, 1], [2]]);
  assert.equal(groups[0].label, 'News, Events');
  assert.deepEqual(answerGroups(form(false), responses, field('age')).map(group => [group.label, group.responseIndices]),
    [['20', [0, 2]], ['30', [1]]]);
});

test('the CSV opens in a spreadsheet without running an answer as a formula', () => {
  setLanguage('en');
  const named = resultsCsv(form(false), responses);
  assert.ok(named.startsWith('\uFEFF'), 'starts with a byte order mark so spreadsheets read UTF-8');
  const rows = named.slice(1).split('\r\n');
  assert.equal(rows.length, 4);
  assert.equal(rows[0], [t('liveForm.csvRespondent'), t('liveForm.csvSubmittedAt'), 'Name', 'Age', 'Confirmed', 'Team', 'Topics', 'Rating']
    .map(cell => `"${cell}"`).join(','));
  assert.ok(rows[1].startsWith(`"Ana","${new Date(1_500).toISOString()}","'=1+1","20"`));
  assert.ok(rows[2].startsWith('"Bia ""B"""'), 'quotes inside a cell are doubled');
  assert.ok(rows[2].includes('"Line one\nline two"'), 'line breaks inside an answer become one kind');
  assert.ok(rows[3].startsWith(`"","","${t('liveForm.noAnswer')}"`), 'an anonymous entry has no respondent or time');
  const anonymous = resultsCsv(form(true), responses).slice(1).split('\r\n');
  assert.equal(anonymous[0], '"Name","Age","Confirmed","Team","Topics","Rating"');
  assert.ok(anonymous[1].startsWith(`"'=1+1","20"`));
  setLanguage('pt-BR');
});
