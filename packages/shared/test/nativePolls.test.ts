import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NATIVE_POLL_VOTER_PREVIEW_LIMIT,
  legacyNativePoll,
  nativePollCreateSchema,
  nativePollEditSchema,
  nativePollSchema,
  nativePollVoteSchema,
  planNativePollEdit,
  survivingNativePollSelection,
  type NativePoll,
} from '../src/nativePolls.js';

const voter = (index: number) => ({ userId: `user-${index}`, userNickname: `User ${index}`, userAvatarUrl: null });
const poll: NativePoll = {
  id: 'poll', messageId: 'message', channelId: 'channel', creatorUserId: 'owner', question: 'When?',
  allowMultiple: true, imageUrls: [], totalVotes: 1, myVoteOptionIds: ['a'], anonymousVotes: false,
  options: [
    { id: 'a', label: 'Friday', emoji: null, votes: 1, voters: [voter(1)] },
    { id: 'b', label: 'Saturday', emoji: null, votes: 0, voters: [] },
  ],
  allowChange: true, closesAt: null, maxVoters: null, closedAt: null, liveAction: false,
  createdAt: 1, revision: 1, audience: { visibility: 'public' },
};

test('poll voters are an optional preview that older clients never receive', () => {
  assert.equal(nativePollSchema.safeParse(poll).success, true);
  const { anonymousVotes: _anonymousVotes, ...withoutAnonymity } = poll;
  assert.equal(nativePollSchema.safeParse({
    ...withoutAnonymity, options: poll.options.map(({ voters: _voters, ...option }) => option),
  }).success, true, 'servers without poll-voters still parse');
  assert.equal(nativePollSchema.safeParse({
    ...poll,
    options: [{ ...poll.options[0], voters: Array.from({ length: NATIVE_POLL_VOTER_PREVIEW_LIMIT + 1 }, (_, index) => voter(index)) },
      poll.options[1]],
  }).success, false, 'the preview is bounded');

  const legacy = legacyNativePoll(poll);
  assert.equal('anonymousVotes' in legacy, false);
  assert.equal(legacy.options.some(option => 'voters' in option), false);
  assert.deepEqual(legacy.options.map(option => option.votes), [1, 0]);
  assert.equal('voters' in poll.options[0], true, 'the projection does not mutate the shared payload');
});

test('a vote may withdraw every answer and creation may hide voters', () => {
  assert.equal(nativePollVoteSchema.safeParse({ id: 'poll', optionIds: [] }).success, true);
  assert.equal(nativePollVoteSchema.safeParse({ id: 'poll', optionIds: ['a', 'a'] }).success, false);
  assert.equal(nativePollCreateSchema.safeParse({
    channelId: 'channel', question: 'Secret?', durationMinutes: 10, anonymousVotes: true,
    options: [{ label: 'Yes', emoji: null }, { label: 'No', emoji: null }],
  }).success, true);
});

test('poll edits reset only the votes whose meaning changed', () => {
  const current = {
    question: 'When?', allowMultiple: true, anonymousVotes: false,
    options: [{ id: 'a', label: 'Friday' }, { id: 'b', label: 'Saturday' }, { id: 'c', label: 'Sunday' }],
  };
  const next = { question: ' When? ', allowMultiple: true, anonymousVotes: false };
  assert.deepEqual(planNativePollEdit(current, {
    ...next, options: [{ id: 'a', label: 'Friday ' }, { id: 'b', label: 'Saturday night' }, { label: 'Monday' }],
  }), { resetAll: null, relabeledOptionIds: ['b'], removedOptionIds: ['c'], singleAnswer: false },
  'surrounding spaces are not a change and new answers touch nothing');
  assert.equal(planNativePollEdit(current, { ...next, question: 'Which day?', options: current.options }).resetAll, 'question');
  assert.equal(planNativePollEdit({ ...current, anonymousVotes: true }, { ...next, options: current.options }).resetAll, 'anonymity');
  assert.equal(planNativePollEdit(current, { ...next, anonymousVotes: true, options: current.options }).resetAll, null,
    'hiding voters never needs a reset');
  assert.equal(planNativePollEdit(current, { ...next, allowMultiple: false, options: current.options }).singleAnswer, true);

  const edit = {
    id: 'poll', expectedRevision: 3, question: 'When?', allowMultiple: false, anonymousVotes: false, images: ['/avatars/cover.png'],
    maxVoters: null, liveAction: false, audience: { visibility: 'public' as const },
    options: [{ id: 'a', label: 'Friday', emoji: null }, { label: 'Monday', emoji: null }],
  };
  assert.equal(nativePollEditSchema.safeParse(edit).success, true, 'an omitted duration keeps the deadline');
  assert.equal(nativePollEditSchema.safeParse({ ...edit, durationMinutes: null }).success, true);
  assert.equal(nativePollEditSchema.safeParse({
    ...edit, options: [{ id: 'a', label: 'Friday', emoji: null }, { id: 'a', label: 'Monday', emoji: null }],
  }).success, false);
  assert.equal(nativePollEditSchema.safeParse({ ...edit, images: ['https://example.com/x.png'] }).success, false);
});

test('a kept selection drops answers an edit reset or removed', () => {
  const options = [{ id: 'a', label: 'A', emoji: null, votes: 1 }, { id: 'c', label: 'C', emoji: null, votes: 1 }];
  assert.deepEqual(survivingNativePollSelection({ options, allowMultiple: true }, ['a', 'b', 'c']), ['a', 'c']);
  assert.deepEqual(survivingNativePollSelection({ options, allowMultiple: false }, ['a', 'c']), [],
    'a set the server discarded for single-answer polls is not shown');
  assert.deepEqual(survivingNativePollSelection({ options, allowMultiple: false }, ['b', 'c']), ['c']);
  assert.equal(survivingNativePollSelection({ options, allowMultiple: true }, null), null);
});
