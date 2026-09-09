import { appEvents } from '../core/EventBus';
import { audioDeviceError, populateAudioDeviceSelect, selectAudioDevice, selectedAudioDevice } from '../core/AudioDeviceService';
import { bindMicrophoneLevelMeter } from '../core/MicrophoneLevelMeter';
import { t } from '../i18n';
import { settingsModal } from './SettingsModal';

let nextId = 0;

export function bindAudioDevicePopovers(root: HTMLElement): () => void {
  const unbind: Array<() => void> = [];
  let closePanel: ((restoreFocus?: boolean) => void) | null = null;

  for (const trigger of root.querySelectorAll<HTMLButtonElement>('button[data-audio-device]')) {
    const kind = trigger.dataset.audioDevice;
    if (kind !== 'input' && kind !== 'output') continue;
    const id = `audio-device-popover-${++nextId}`;
    const label = t(kind === 'input' ? 'audioDevices.selectInput' : 'audioDevices.selectOutput');
    trigger.type = 'button';
    trigger.classList.add('audio-device-trigger');
    trigger.setAttribute('aria-label', label);
    trigger.title = label;
    trigger.setAttribute('aria-haspopup', 'dialog');
    trigger.setAttribute('aria-controls', id);
    trigger.setAttribute('aria-expanded', 'false');

    const toggle = () => {
      if (trigger.getAttribute('aria-expanded') === 'true') {
        closePanel?.(true);
        return;
      }
      closePanel?.();
      const panel = document.createElement('section');
      panel.id = id;
      panel.className = 'audio-device-popover';
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', label);
      const deviceRow = document.createElement('button');
      deviceRow.type = 'button';
      deviceRow.className = 'audio-device-current';
      deviceRow.setAttribute('aria-haspopup', 'listbox');
      deviceRow.setAttribute('aria-expanded', 'false');
      deviceRow.setAttribute('aria-controls', `${id}-options`);
      deviceRow.innerHTML = '<span class="audio-device-current-text"><strong></strong><span class="audio-device-current-value"></span></span><span class="material-symbols-outlined md-18" aria-hidden="true">chevron_right</span>';
      deviceRow.querySelector('strong')!.textContent = t(kind === 'input' ? 'audioDevices.inputDevice' : 'audioDevices.outputDevice');
      const currentValue = deviceRow.querySelector<HTMLElement>('.audio-device-current-value')!;
      currentValue.textContent = t(kind === 'input' ? 'settings.loadingMics' : 'settings.loadingOutputs');

      // Preserve the shared device-selection model without opening a native picker.
      const select = document.createElement('select');
      select.hidden = true;
      select.tabIndex = -1;
      select.disabled = true;
      const options = document.createElement('div');
      options.id = `${id}-options`;
      options.className = 'audio-device-options';
      options.setAttribute('role', 'listbox');
      options.setAttribute('aria-label', deviceRow.querySelector('strong')!.textContent ?? label);
      options.hidden = true;
      const status = document.createElement('div');
      status.className = 'audio-device-status';
      status.setAttribute('role', 'status');
      panel.append(deviceRow, select);

      let meter: HTMLElement | null = null;
      if (kind === 'input') {
        const level = document.createElement('div');
        level.className = 'audio-device-level';
        const heading = document.createElement('strong');
        heading.textContent = t('audioDevices.inputLevel');
        meter = document.createElement('div');
        meter.className = 'vad-meter';
        meter.setAttribute('aria-label', t('audioDevices.inputLevel'));
        meter.innerHTML = '<div class="vad-meter-fill"></div>';
        level.append(heading, meter);
        panel.append(level);
      }
      panel.append(status);
      const configure = document.createElement('button');
      configure.type = 'button';
      configure.className = 'audio-device-settings';
      configure.innerHTML = '<span class="material-symbols-outlined md-18" aria-hidden="true">settings</span><span></span>';
      configure.lastElementChild!.textContent = t('audioDevices.voiceSettings');
      panel.append(configure);
      document.body.append(panel, options);
      trigger.setAttribute('aria-expanded', 'true');

      let closed = false;
      let loading = 0;
      let busy = false;
      let deviceStatus = '';
      let previewStatus = '';
      let selectionStatus = '';
      let submenuTimer: ReturnType<typeof setTimeout> | null = null;
      let search = '';
      let lastSearch = 0;
      const abort = new AbortController();
      const showStatus = () => { status.textContent = selectionStatus || previewStatus || deviceStatus; };
      const optionButtons = () => Array.from(options.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      const position = () => {
        if (!trigger.isConnected) { close(); return; }
        const rect = trigger.getBoundingClientRect();
        panel.style.maxHeight = `${Math.max(0, rect.top - 16)}px`;
        panel.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - panel.offsetWidth - 8))}px`;
        panel.style.top = `${Math.max(8, rect.top - panel.offsetHeight - 8)}px`;
        if (!options.hidden) {
          options.style.maxHeight = `${Math.min(360, innerHeight - 16)}px`;
          const row = deviceRow.getBoundingClientRect();
          const right = row.right + 6;
          const left = right + options.offsetWidth <= innerWidth - 8 ? right : row.left - options.offsetWidth - 6;
          options.style.left = `${Math.max(8, Math.min(left, innerWidth - options.offsetWidth - 8))}px`;
          options.style.top = `${Math.max(8, Math.min(row.top, innerHeight - options.offsetHeight - 8))}px`;
        }
      };
      const clearSubmenuTimer = () => {
        if (submenuTimer !== null) clearTimeout(submenuTimer);
        submenuTimer = null;
      };
      const hideOptions = (restoreFocus = false) => {
        clearSubmenuTimer();
        options.hidden = true;
        deviceRow.setAttribute('aria-expanded', 'false');
        if (restoreFocus) deviceRow.focus();
      };
      const openOptions = (focus = false) => {
        clearSubmenuTimer();
        if (select.disabled) return;
        options.hidden = false;
        deviceRow.setAttribute('aria-expanded', 'true');
        position();
        if (focus) {
          const buttons = optionButtons();
          const selected = buttons.find((button) => button.getAttribute('aria-selected') === 'true') ?? buttons[0];
          selected?.focus();
          selected?.scrollIntoView({ block: 'nearest' });
        }
      };
      const deferHideOptions = (event: MouseEvent) => {
        if (event.relatedTarget instanceof Node && (options.contains(event.relatedTarget) || deviceRow.contains(event.relatedTarget))) return;
        clearSubmenuTimer();
        submenuTimer = setTimeout(() => {
          if (!options.contains(document.activeElement)) hideOptions();
        }, 180);
      };
      const refresh = async () => {
        const version = ++loading;
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          if (closed || version !== loading) return;
          deviceStatus = populateAudioDeviceSelect(select, kind, devices);
          select.disabled = busy;
          deviceRow.disabled = busy;
          const focused = options.contains(document.activeElement) && document.activeElement instanceof HTMLElement
            ? document.activeElement.dataset.deviceId : undefined;
          const selectedLabel = select.selectedOptions[0]?.textContent ?? t('audioDevices.systemDefault');
          const system = devices.find((device) => device.kind === (kind === 'input' ? 'audioinput' : 'audiooutput') && device.deviceId === 'default');
          currentValue.textContent = !select.value && system?.label ? `${selectedLabel} (${system.label})` : selectedLabel;
          currentValue.title = currentValue.textContent;
          options.replaceChildren(...Array.from(select.options, (option) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'audio-device-option';
            button.dataset.deviceId = option.value;
            button.tabIndex = -1;
            button.disabled = option.disabled || busy;
            button.setAttribute('role', 'option');
            button.setAttribute('aria-selected', String(option.selected));
            const text = document.createElement('span');
            text.textContent = option.textContent;
            const check = document.createElement('span');
            check.className = 'material-symbols-outlined md-16';
            check.setAttribute('aria-hidden', 'true');
            check.textContent = option.selected ? 'check' : '';
            button.append(text, check);
            return button;
          }));
          if (focused !== undefined) optionButtons().find((button) => button.dataset.deviceId === focused)?.focus();
          showStatus();
          position();
        } catch (error) {
          if (closed || version !== loading) return;
          deviceStatus = audioDeviceError(error);
          select.disabled = deviceRow.disabled = true;
          hideOptions();
          showStatus();
          position();
        }
      };
      const change = async () => {
        if (busy) return;
        busy = true;
        select.disabled = deviceRow.disabled = true;
        hideOptions();
        selectionStatus = '';
        showStatus();
        try {
          await selectAudioDevice(kind, select.value, abort.signal);
        } catch (error) {
          if (!closed) {
            selectionStatus = audioDeviceError(error);
            select.value = selectedAudioDevice(kind) === 'default' ? '' : selectedAudioDevice(kind);
          }
        } finally {
          busy = false;
          if (!closed) {
            await refresh();
            if (document.activeElement === document.body || document.activeElement === options) deviceRow.focus();
          }
        }
      };
      const choose = (event: MouseEvent) => {
        const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button[data-device-id]') : null;
        if (!button || button.disabled) return;
        select.value = button.dataset.deviceId ?? '';
        deviceRow.focus();
        void change();
      };
      const contains = (target: Node) => panel.contains(target) || options.contains(target) || trigger.contains(target);
      const outside = (event: PointerEvent | FocusEvent) => {
        if (event.target instanceof Node && !contains(event.target)) close();
      };
      const keydown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          if (!options.hidden) hideOptions(true);
          else close(true);
          return;
        }
        if (document.activeElement === deviceRow && ['ArrowRight', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
          event.preventDefault();
          openOptions(true);
          return;
        }
        if (options.hidden || !options.contains(document.activeElement)) return;
        if (event.key === 'ArrowLeft') {
          event.preventDefault();
          hideOptions(true);
          return;
        }
        const buttons = optionButtons();
        const index = buttons.findIndex((button) => button === document.activeElement);
        let next: HTMLButtonElement | undefined;
        if (event.key === 'ArrowDown') next = buttons[(index + 1) % buttons.length];
        else if (event.key === 'ArrowUp') next = buttons[(index + buttons.length - 1) % buttons.length];
        else if (event.key === 'Home') next = buttons[0];
        else if (event.key === 'End') next = buttons[buttons.length - 1];
        else if (event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) {
          search = performance.now() - lastSearch < 600 ? search + event.key : event.key;
          lastSearch = performance.now();
          next = buttons.find((button) => button.textContent?.trim().toLocaleLowerCase().startsWith(search.toLocaleLowerCase()));
        }
        if (next) {
          event.preventDefault();
          next.focus();
          next.scrollIntoView({ block: 'nearest' });
        }
      };
      const offSettings = appEvents.on('settings.updated', () => { void refresh(); });
      const offConnection = appEvents.on('network.disconnected', () => close());
      const offChannel = appEvents.on('voice.channel_changed', (channel: string | null) => { if (!channel) close(); });
      const offMeter = meter ? bindMicrophoneLevelMeter(meter, (error) => {
        if (closed) return;
        previewStatus = error ? audioDeviceError(error) : '';
        showStatus();
        void refresh();
      }) : () => {};
      const observer = new MutationObserver(() => { if (!trigger.isConnected || !panel.isConnected) close(); });
      observer.observe(document.body, { childList: true, subtree: true });
      function close(restoreFocus = false): void {
        if (closed) return;
        closed = true;
        abort.abort();
        clearSubmenuTimer();
        offMeter();
        offSettings();
        offConnection();
        offChannel();
        observer.disconnect();
        navigator.mediaDevices?.removeEventListener('devicechange', onDevices);
        document.removeEventListener('pointerdown', outside, true);
        document.removeEventListener('focusin', outside);
        document.removeEventListener('keydown', keydown, true);
        window.removeEventListener('resize', position);
        window.removeEventListener('scroll', position, true);
        select.removeEventListener('change', change);
        panel.remove();
        options.remove();
        trigger.setAttribute('aria-expanded', 'false');
        if (closePanel === close) closePanel = null;
        if (restoreFocus && trigger.isConnected) trigger.focus();
      }
      const onDevices = () => { void refresh(); };
      closePanel = close;
      deviceRow.addEventListener('mouseenter', () => openOptions());
      deviceRow.addEventListener('mouseleave', deferHideOptions);
      deviceRow.addEventListener('click', () => openOptions(true));
      options.addEventListener('mouseenter', clearSubmenuTimer);
      options.addEventListener('mouseleave', deferHideOptions);
      options.addEventListener('click', choose);
      configure.addEventListener('click', () => {
        close();
        void settingsModal.open('voice_video');
      });
      navigator.mediaDevices?.addEventListener('devicechange', onDevices);
      document.addEventListener('pointerdown', outside, true);
      document.addEventListener('focusin', outside);
      document.addEventListener('keydown', keydown, true);
      window.addEventListener('resize', position);
      window.addEventListener('scroll', position, true);
      select.addEventListener('change', change);
      position();
      deviceRow.focus();
      void refresh();
    };
    trigger.addEventListener('click', toggle);
    unbind.push(() => trigger.removeEventListener('click', toggle));
  }
  return () => {
    closePanel?.();
    unbind.forEach((off) => off());
  };
}
