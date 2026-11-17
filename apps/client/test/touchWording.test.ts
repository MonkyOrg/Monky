import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { getLanguage, setLanguage, t, tTouch } from '../src/renderer/i18n';
import { ptBR } from '../src/renderer/i18n/locales/pt-BR';
import { en } from '../src/renderer/i18n/locales/en';
import { TOUCH_POINTER_QUERY } from '../src/renderer/utils/viewport';

const original = Object.getOwnPropertyDescriptor(globalThis, 'matchMedia');
const language = getLanguage();

function pointer(touch: boolean): void {
  Object.defineProperty(globalThis, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({ matches: touch && query === TOUCH_POINTER_QUERY }),
  });
}

afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'matchMedia', original);
  else Reflect.deleteProperty(globalThis, 'matchMedia');
  setLanguage(language);
});

test('touch screens get the tap wording and keep the placeholders', () => {
  setLanguage('pt-BR');
  pointer(true);
  assert.equal(tTouch('connection.scanHint', { button: 'Procurar' }), 'Toque em "Procurar" para procurar servidores na rede local.');
  pointer(false);
  assert.equal(tTouch('connection.scanHint', { button: 'Procurar' }), t('connection.scanHint', { button: 'Procurar' }));
});

test('without matchMedia the mouse wording stays', () => {
  Reflect.deleteProperty(globalThis, 'matchMedia');
  assert.equal(tTouch('stage.focusMode'), t('stage.focusMode'));
});

test('no touch wording mentions the mouse, in either language', () => {
  for (const catalog of [ptBR, en]) {
    const touch = Object.entries(catalog).filter(([key]) => key.endsWith('Touch'));
    assert.ok(touch.length > 0);
    for (const [key, text] of touch) {
      assert.doesNotMatch(text, /\bcli(que|ck|car|cking)|right-click|botão direito|menu de contexto|context menu|hover|passe o mouse/i, key);
    }
  }
});
