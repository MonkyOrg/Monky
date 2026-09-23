module.exports = { runCustomSoundsSmoke };

async function runCustomSoundsSmoke(base64) {
  const [{ SoundEffectManager, soundEffects, SOUND_EFFECT_TYPES, getSoundLabels }, { settingsStore },
    { NotificationsTab }, language] = await Promise.all([
    import('/core/SoundEffects.ts'), import('/stores/settingsStore.ts'),
    import('/views/settings/tabs/NotificationsTab.ts'), import('/i18n/index.ts'),
  ]);
  let checks = 0;
  const check = (value, message) => { if (!value) throw new Error(message); checks++; };
  const until = async (probe, message) => {
    const deadline = Date.now() + 5000;
    while (!probe()) {
      if (Date.now() > deadline) throw new Error(message);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  const source = `data:audio/wav;base64,${base64}`;
  const previous = { sounds: settingsStore.customSounds, ptt: settingsStore.pttSoundCue, chat: settingsStore.chatMessageSoundEnabled };
  const pick = window.api.selectSoundFile;
  const root = document.getElementById('fixture');
  const tab = new NotificationsTab();
  let manager;
  const synthetic = [];
  try {
    settingsStore.customSounds = Object.fromEntries(SOUND_EFFECT_TYPES.map(key => [key, source]));
    settingsStore.save();
    manager = new SoundEffectManager();
    manager.playTone = rising => synthetic.push(rising ? 'screen_share_start' : 'screen_share_stop');
    manager.playChatCue = () => synthetic.push('chat_message');
    manager.playPttCue = active => synthetic.push(active ? 'ptt_press' : 'ptt_release');
    manager.playReconnectCue = () => synthetic.push('reconnecting');
    check(SOUND_EFFECT_TYPES.length === 12 && Object.keys(getSoundLabels()).length === 12,
      'One complete catalogue covers all built-in, chat, screen-share, PTT and reconnection cues');
    for (const key of SOUND_EFFECT_TYPES) {
      const audio = manager.audioMap[key];
      check(audio instanceof HTMLAudioElement && audio.src === source, `${key} loads its saved custom audio after restart`);
      manager.play(key);
      await until(() => !audio.paused && audio.currentTime > 0, `${key} did not play the actual authored audio`);
      check(synthetic.length === 0, `${key} never bypasses the chosen file with a synthesized cue`);
      manager.stopCachedSound(key);
    }
    settingsStore.pttSoundCue = false;
    manager.playPttTone(true);
    await new Promise(resolve => setTimeout(resolve, 30));
    check(manager.audioMap.ptt_press.paused, 'Disabled PTT cues stay disabled after choosing a custom sound');
    settingsStore.pttSoundCue = true;
    manager.playPttTone(false);
    await until(() => !manager.audioMap.ptt_release.paused, 'The PTT release event did not use its custom file');
    manager.stopCachedSound('ptt_release');
    manager.startReconnectingLoop();
    await until(() => !manager.audioMap.reconnecting.paused, 'The reconnection loop did not use its custom file');
    const timer = manager.reconnectLoopTimer;
    manager.startReconnectingLoop();
    check(manager.reconnectLoopTimer === timer, 'Reconnection still owns one repeating timer');
    manager.stopReconnectingLoop();
    check(manager.audioMap.reconnecting.paused && manager.audioMap.reconnecting.currentTime === 0 && manager.reconnectLoopTimer === null,
      'Recovering a connection stops custom audio and its repeating timer');

    for (const key of ['screen_share_start', 'screen_share_stop', 'chat_message', 'ptt_press', 'ptt_release', 'reconnecting']) {
      const old = manager.audioMap[key];
      manager.reloadSound(key);
      check(old.paused && old.getAttribute('src') === '' && !manager.audioMap[key], `${key} reset releases the old media element`);
      manager.play(key);
      check(synthetic.at(-1) === key, `${key} reset restores its original synthesized cue`);
    }
    manager.reloadSound('chat_message', source);
    const delayed = manager.audioMap.chat_message;
    const applySink = manager.applySink;
    const completions = [];
    manager.applySink = () => new Promise(resolve => completions.push(resolve));
    manager.play('chat_message');
    manager.reloadSound('chat_message');
    completions.forEach(resolve => resolve());
    await new Promise(resolve => setTimeout(resolve, 30));
    check(delayed.paused && !manager.audioMap.chat_message, 'A late output-device operation cannot restart a reset custom cue');
    manager.applySink = applySink;

    for (const locale of ['en', 'pt-BR']) {
      tab.cleanup();
      language.setLanguage(locale);
      settingsStore.customSounds = {};
      settingsStore.chatMessageSoundEnabled = false;
      settingsStore.save();
      soundEffects.loadAll();
      root.innerHTML = tab.renderHtml();
      tab.attachEvents(root);
      check(root.querySelectorAll('.btn-sound-change').length === SOUND_EFFECT_TYPES.length, 'The customization page includes every catalogue entry');
      check(root.textContent.includes(locale === 'en' ? 'Chat message notification' : 'Notificação de mensagem no chat'),
        'Chat notification audio is present with a localized label');
      check(root.querySelector('label[for="checkbox-chat-sound"]').textContent.includes(
        locale === 'en' ? 'Play a sound for incoming messages' : 'Tocar som ao receber mensagens'),
      'The related notification toggle follows the app language');
      window.api.selectSoundFile = async () => source;
      root.querySelector('.btn-sound-change[data-sound-key="chat_message"]').click();
      await until(() => settingsStore.customSounds.chat_message === source, 'Choosing chat notification audio did not persist');
      check(!settingsStore.chatMessageSoundEnabled, 'Customizing a cue does not enable muted chat notifications');
      const customized = soundEffects.audioMap.chat_message;
      root.querySelector('.btn-sound-preview[data-sound-key="chat_message"]').click();
      await until(() => !customized.paused, 'The new chat notification preview did not play');
      root.querySelector('.btn-sound-reset[data-sound-key="chat_message"]').click();
      check(!settingsStore.customSounds.chat_message && !soundEffects.audioMap.chat_message && customized.paused,
        'Resetting from the UI restores the default and stops the old file');
      for (const key of ['ptt_press', 'reconnecting', 'screen_share_start']) {
        root.querySelector(`.btn-sound-change[data-sound-key="${key}"]`).click();
        await until(() => settingsStore.customSounds[key] === source, `${key} selection did not finish`);
      }
      root.querySelector('#btn-reset-all-sounds').click();
      check(Object.keys(settingsStore.customSounds).length === 0 &&
        ['ptt_press', 'reconnecting', 'screen_share_start'].every(key => !soundEffects.audioMap[key]),
      'Reset all clears cached synthesized overrides as well as stored preferences');
    }
    let finishPicker;
    window.api.selectSoundFile = () => new Promise(resolve => { finishPicker = resolve; });
    root.querySelector('.btn-sound-change[data-sound-key="chat_message"]').click();
    tab.cleanup();
    finishPicker(source);
    await new Promise(resolve => setTimeout(resolve, 30));
    check(!settingsStore.customSounds.chat_message, 'Closing settings cancels a late native picker result');
  } finally {
    tab.cleanup();
    manager?.stopReconnectingLoop();
    if (manager) {
      for (const key of SOUND_EFFECT_TYPES) {
        manager.stopCachedSound(key);
        if (manager.audioMap[key]) manager.audioMap[key].src = '';
      }
      if (manager.toneCtx && manager.toneCtx.state !== 'closed') await manager.toneCtx.close();
    }
    window.api.selectSoundFile = pick;
    settingsStore.customSounds = previous.sounds;
    settingsStore.pttSoundCue = previous.ptt;
    settingsStore.chatMessageSoundEnabled = previous.chat;
    settingsStore.save();
    soundEffects.loadAll();
    root.replaceChildren();
  }
  return checks;
}
