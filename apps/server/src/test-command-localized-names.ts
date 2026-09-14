import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getCommandPresentation } from '@monky/shared';
import { CommandRegistry } from './application/services/CommandRegistry';

const play = {
  name: 'play', description: 'Play a track',
  localizations: { 'pt-BR': { name: 'tocar', aliases: ['musica'] } },
};

test('localized registration collisions fail before replacing a bot catalog, in either order', () => {
  const registry = new CommandRegistry();
  registry.register('music', 'Music', [play]);
  const original = registry.listAll();
  for (const other of [
    { name: 'tocar', description: 'Canonical shadow' },
    { name: 'stop', description: 'Alias shadow', localizations: { en: { aliases: ['play'] } } },
    { name: 'stop', description: 'Name collision', localizations: { 'pt-BR': { name: 'tocar' } } },
    { name: 'stop', description: 'Alias collision', localizations: { 'pt-BR': { aliases: ['musica'] } } },
  ]) {
    for (const commands of [[play, other], [other, play]]) {
      assert.throws(() => registry.register('music', 'Replacement', commands), /ambiguous/);
      assert.deepEqual(registry.listAll(), original);
    }
  }
});

test('execution remains canonical and collisions across bots stay available for client disambiguation', () => {
  const registry = new CommandRegistry();
  registry.register('first', 'First', [play]);
  registry.register('second', 'Second', [play]);
  assert.equal(registry.findByName('play').length, 2);
  for (const botId of ['first', 'second']) {
    const command = registry.find(botId, 'play');
    assert.ok(command);
    assert.equal(command.botId, botId);
    assert.deepEqual(getCommandPresentation(command, 'pt-BR'), {
      canonicalName: 'play', displayName: 'tocar', inputNames: ['play', 'tocar', 'musica'],
    });
    assert.equal(registry.find(botId, 'tocar'), undefined);
    assert.equal(registry.find(botId, 'musica'), undefined);
  }
  registry.register('first', 'First', [{ ...play, localizations: { en: { name: 'listen' } } }]);
  assert.equal(getCommandPresentation(registry.find('first', 'play')!, 'en').displayName, 'listen');
  assert.equal(getCommandPresentation(registry.find('second', 'play')!, 'pt-BR').displayName, 'tocar');
});
