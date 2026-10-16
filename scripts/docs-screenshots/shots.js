/**
 * The screenshots, in the order they are taken. Each `take` starts from the
 * main view of the demo server and leaves it there; shots that depend on an
 * earlier one (the bot review installs GuiaBot) come after it. Elements are
 * found by id or by their icon name, never by translated text, so the same
 * steps work in both languages.
 */
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function openTextChannel(scene, key = 'text') {
  const { page, context } = scene;
  await page.click(`[data-channel-id="${context.channels[key].id}"][data-channel-type="TEXT"]`);
  await page.waitFor('#chat-message-input');
}

async function openServerSettings(page, tab) {
  await page.click('#server-dropdown-toggle');
  await page.click('#btn-server-settings');
  await page.click(`.server-settings-modal-card [data-tab="${tab}"]`);
  await delay(400);
}

async function openUserSettings(page, tab) {
  await page.click('#bar-btn-settings');
  await page.click(`.settings-modal-card [data-tab="${tab}"]`);
  await delay(400);
}

async function closeModals(page) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const open = await page.eval(`!!document.querySelector('.modal-backdrop, .modal-overlay, .server-settings-modal-card')`);
    if (!open) return;
    await page.escape();
    await delay(350);
  }
}

/** Marks the element found by `finder` (a JS expression) so it can be clicked like any other. */
async function tag(page, finder, name) {
  const found = await page.eval(`(() => {
    const element = ${finder};
    if (!element) return false;
    element.setAttribute('data-shot', ${JSON.stringify(name)});
    return true;
  })()`);
  if (!found) throw new Error(`Nothing found for ${name}`);
  return `[data-shot="${name}"]`;
}

async function openCommunityList(scene, icon) {
  await openTextChannel(scene);
  await scene.page.click(await tag(scene.page,
    `[...document.querySelectorAll('.community-sidebar-link')].find(link => link.textContent.trim().startsWith('${icon}'))`,
    `community-${icon}`));
  await delay(600);
}

async function joinVoice(scene) {
  const { page, context } = scene;
  if (await page.eval(`!!document.querySelector('#stage-participants-area')`)) return;
  await page.click(`[data-channel-id="${context.channels.voice.id}"]`);
  await page.waitFor('#stage-participants-area');
  await delay(1200);
}

/** The game strip only exists on Windows with Steam open; it is not what these shots document. */
async function hideGameSuggestion(page) {
  await openUserSettings(page, 'account');
  if (await page.eval(`document.querySelector('#toggle-game-share-suggestion')?.checked === true`)) {
    await page.click(await tag(page, `document.querySelector('#toggle-game-share-suggestion').closest('label')`, 'game-suggestion'));
  }
  await closeModals(page);
}

async function runCommand(scene, name) {
  const { page } = scene;
  await page.click('#chat-message-input');
  await page.type('/');
  await page.click(`.command-row[data-command-name="${name}"]`);
  await page.key('Enter', 'Enter', 13);
}

export const shots = [
  {
    name: 'bots-vincular',
    async take(scene, file) {
      const { page, bot } = scene;
      await openServerSettings(page, 'bots');
      await page.fill('#bot-manifest-url', bot.manifestUrl);
      await page.capture(file);
    },
  },
  {
    name: 'bots-permissoes',
    async take(scene, file) {
      const { page, bot } = scene;
      if (!await page.eval(`!!document.querySelector('#bot-manifest-url')`)) {
        await openServerSettings(page, 'bots');
        await page.fill('#bot-manifest-url', bot.manifestUrl);
      }
      await page.click('#btn-install-bot');
      await page.waitFor('#bot-install-all', { visible: false });
      await page.capture(file);
      // Approving everything it asked for is what the rest of the shots need.
      await page.click(await tag(page, `document.querySelector('#bot-install-all').closest('label')`, 'approve-all'));
      await page.click(await tag(page, `(() => {
        let scope = document.querySelector('#bot-install-all');
        while (scope && !scope.querySelector('.btn-primary')) scope = scope.parentElement;
        return scope?.querySelector('.btn-primary');
      })()`, 'confirm-bot'));
      await page.waitUntil(`[...document.querySelectorAll('.server-settings-modal-card *')].some(item => item.textContent.trim() === 'GuiaBot')`,
        'GuiaBot in the linked bots list', 20_000);
      await closeModals(page);
    },
  },
  {
    name: 'administrar-servidor',
    async take(scene, file) {
      await openServerSettings(scene.page, 'general');
      await scene.page.capture(file);
      await closeModals(scene.page);
    },
  },
  {
    name: 'cargos',
    async take(scene, file) {
      await openServerSettings(scene.page, 'roles');
      await scene.page.capture(file);
      await closeModals(scene.page);
    },
  },
  {
    name: 'conversa',
    async take(scene, file) {
      await openTextChannel(scene);
      await scene.page.capture(file);
    },
  },
  {
    name: 'eventos',
    async take(scene, file) {
      await openCommunityList(scene, 'event');
      await scene.page.capture(file);
      await closeModals(scene.page);
    },
  },
  {
    name: 'acoes-ao-vivo',
    async take(scene, file) {
      await openCommunityList(scene, 'bolt');
      await scene.page.capture(file);
      await closeModals(scene.page);
    },
  },
  {
    name: 'inicio',
    async take(scene, file) {
      const { page, password } = scene;
      await page.click('#server-rail-home');
      await delay(500);
      await page.click('#server-rail-add');
      await page.click('#add-server-option-join');
      // Shown, never submitted: the form's own default port reads better than a random one.
      await page.fill('#add-server-host', '192.168.0.10');
      await page.fill('#add-server-port', '3000');
      await page.fill('#add-server-password', password);
      await page.capture(file);
      await closeModals(page);
    },
  },
  {
    name: 'criar-servidor',
    async take(scene, file) {
      const { page, text } = scene;
      await page.click('#server-rail-home');
      await delay(500);
      await page.click('#server-rail-add');
      await page.click('#add-server-option-create');
      await delay(500);
      await page.fill('#add-server-name', text.server);
      await page.fill('#add-server-text-channel', text.text);
      await page.fill('#add-server-voice-channel', text.voice);
      // The guide is about the voice mode choice; the card scrolls, so bring that part into view.
      await page.eval(`(() => {
        const form = document.querySelector('#add-server-create-form');
        let scroller = form;
        while (scroller && scroller.scrollHeight <= scroller.clientHeight) scroller = scroller.parentElement;
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
      })()`);
      await delay(300);
      await page.capture(file);
      await closeModals(page);
      await page.click('.server-rail-avatar');
      await page.waitFor('#chat-message-input');
    },
  },
  {
    name: 'configuracoes-voz',
    async take(scene, file) {
      await openUserSettings(scene.page, 'voice_video');
      await scene.page.capture(file);
      await closeModals(scene.page);
    },
  },
  {
    name: 'ferramentas',
    async take(scene, file) {
      await openUserSettings(scene.page, 'local_tools');
      await scene.page.capture(file);
      await closeModals(scene.page);
    },
  },
  // From here on Marina is in the voice room, unmuted, as in the bot guides.
  {
    name: 'comandos',
    async take(scene, file) {
      const { page, text } = scene;
      await hideGameSuggestion(page);
      await joinVoice(scene);
      if (await page.eval(`document.querySelector('#bar-btn-mic')?.classList.contains('danger-active')`)) await page.click('#bar-btn-mic');
      await openTextChannel(scene, 'planning');
      await page.click('#chat-message-input');
      await page.type(text.planningMessage);
      await page.key('Enter', 'Enter', 13);
      await delay(600);
      await page.type('/');
      await page.waitFor('.command-row');
      await page.capture(file, { keepFocus: true });
      await page.key('Backspace', 'Backspace', 8);
      await page.escape();
    },
  },
  {
    name: 'formulario',
    async take(scene, file) {
      const { page } = scene;
      await openTextChannel(scene, 'planning');
      await runCommand(scene, 'plan');
      await page.waitFor('.bot-cancel-interaction');
      await delay(500);
      await page.capture(file);
      await page.click('.bot-cancel-interaction');
      await delay(500);
    },
  },
  {
    name: 'miniapp',
    async take(scene, file) {
      const { page } = scene;
      await openTextChannel(scene, 'planning');
      await runCommand(scene, 'panel');
      await page.click('.bot-screen-invitation .screenshare-notice-btn');
      // The miniapp consent dialog: the person agrees once per screen.
      await page.click(await tag(page, `(() => {
        const buttons = [...document.querySelectorAll('.modal-card .btn-primary')].filter(button => button.offsetParent);
        return buttons[buttons.length - 1];
      })()`, 'open-miniapp'));
      await page.waitFor('.bot-screen-frame');
      await delay(1500);
      await page.capture(file);
    },
  },
];
