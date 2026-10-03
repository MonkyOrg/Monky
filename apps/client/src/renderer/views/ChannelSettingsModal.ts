import {
  MessageType, Permission, CHANNEL_PERMISSIONS, EVERYONE_ROLE_ID, channelOverwrites, channelPrivacy, withChannelPrivacy, channelPermissionTargetKey, resolveChannelPermissions,
  type ChannelCategory, type ChannelSummary, type ChannelPermissionOverwrite, type ChannelAccessRules,
} from '@monky/shared';
import { getActiveNetworkClient } from '../core/NetworkClient';
import { appEvents } from '../core/EventBus';
import { getActiveServerStore } from '../stores/serverStore';
import { isForegroundEvent } from '../core/sessionRouting';
import { t } from '../i18n';
import { escapeHtml } from '../utils/html';
import { enterModal, exitModal, handlesModalKey } from '../utils/modalSurface';
import { animateEnter } from '../utils/surfaceMotion';
import { enableBackdropClose } from '../utils/modal';
import { attachInputEmojiPicker } from '../utils/inputEmojiPicker';
import { showConfirm } from './Dialog';
import { showErrorToast } from './CopyToast';
import { ResourceAudiencePicker } from './ResourceAudiencePicker';
import { getAvatarUrl } from '../utils/avatar';
import { isHexColor } from '../utils/colors';
import { renderChannelCategorySelect, renderChannelBotCommandsField, readChannelBotCommandsField } from './channelFormFields';
import './channelSettings.css';

type Target = { kind: 'channel'; value: ChannelSummary } | { kind: 'category'; value: ChannelCategory };
const permissionNames = [
  [Permission.VIEW_CHANNEL, 'viewChannel'],
  [Permission.READ_MESSAGES, 'readMessages'],
  [Permission.SEND_MESSAGES, 'sendMessages'],
  [Permission.ATTACH_FILES, 'attachFiles'],
  [Permission.SPEAK, 'speak'],
  [Permission.USE_SOUNDBOARD, 'useSoundboard'],
  [Permission.USE_BOT_COMMANDS, 'useBotCommands'],
  [Permission.MANAGE_EVENTS, 'manageEvents'],
  [Permission.EMIT_LIVE_ACTIONS, 'emitLiveActions'],
] as const;
const states = [
  { value: 'deny', icon: 'close', label: 'channelPermissions.deny' },
  { value: 'inherit', icon: 'remove', label: 'channelPermissions.inherit' },
  { value: 'allow', icon: 'check', label: 'channelPermissions.allow' },
] as const;

export class ChannelSettingsModal {
  private closeCurrent: ((immediate?: boolean) => void) | null = null;

  open(target: Target): void {
    this.closeCurrent?.();
    if (this.closeCurrent) return;
    const store = getActiveServerStore();
    const client = getActiveNetworkClient();
    const serverId = store.serverDetails?.id;
    const sessionId = store.currentUser?.sessionId;
    const current = () => target.kind === 'channel' ? store.getChannel(target.value.id)
      : store.serverDetails?.categories?.find(category => category.id === target.value.id);
    const allowed = () => store.hasPermission(Permission.MANAGE_CHANNELS);
    if (!serverId || !allowed() || !current()) return;
    const snapshot = () => JSON.stringify({
      value: current(),
      category: target.kind === 'channel' && target.value.inheritCategoryPermissions !== false
        ? store.serverDetails?.categories?.find(category => category.id === target.value.categoryId) : undefined,
    });
    const initial = snapshot();
    const initialCategories = new Map((store.serverDetails?.categories ?? []).map(category => [category.id, JSON.stringify(category)]));
    const initialRules = target.kind === 'channel'
      ? resolveChannelPermissions(target.value, store.serverDetails?.categories?.find(category => category.id === target.value.categoryId) ?? null)
      : target.value;
    let overwrites = channelOverwrites(initialRules);
    let inherited = target.kind === 'channel' && target.value.inheritCategoryPermissions !== false;
    let privacySnapshot: ChannelAccessRules = { ...initialRules, permissionOverwrites: channelOverwrites(initialRules) };
    const initialOverwrites = JSON.stringify(channelOverwrites(target.value));
    let selectedTarget = EVERYONE_ROLE_ID;
    const audienceValue = () => ({
      visibility: 'private' as const,
      roleIds: overwrites.flatMap(entry => entry.roleId != null ? [entry.roleId] : []),
      userIds: overwrites.flatMap(entry => entry.userId !== undefined ? [entry.userId] : []),
    });
    const picker = new ResourceAudiencePicker(store, 'channel-permission-targets', audienceValue(), 'adaptive', 'permission-targets');
    let pending = false;
    let closed = false;
    let confirming = false;
    const controller = new AbortController();
    const options = { signal: controller.signal };
    const root = document.createElement('div');
    root.className = 'modal-backdrop';
    root.innerHTML = `<section class="modal-card settings-modal-card channel-settings-card" role="dialog" aria-modal="true" aria-labelledby="channel-settings-title">
      <nav class="settings-sidebar" aria-label="${t('channelPermissions.navigation')}">
        <div class="channel-settings-name">${escapeHtml(target.value.name)}</div>
        <button type="button" class="settings-tab-btn active" data-channel-tab="general" aria-current="page">
          <span class="material-symbols-outlined md-18">tune</span>${t('roles.generalTab')}</button>
        <button type="button" class="settings-tab-btn" data-channel-tab="permissions">
          <span class="material-symbols-outlined md-18">lock</span>${t('roles.permissionsTab')}</button>
      </nav>
      <div class="settings-main-container">
        <header class="settings-content-header">
          <h2 id="channel-settings-title">${t(target.kind === 'channel' ? 'channelModal.editTitle' : 'categories.edit')}</h2>
          <button type="button" class="settings-back-btn" data-channel-close aria-label="${t('common.close')}">
            <span class="material-symbols-outlined md-18">close</span><span class="esc-hint">ESC</span></button>
        </header>
        <form id="form-edit-channel" class="channel-settings-form">
          <div class="settings-content-body">
            <section data-channel-panel="general">
              <div class="form-group"><label for="input-channel-name">${t(target.kind === 'channel' ? 'channelModal.nameLabel' : 'categories.name')}</label>
                <div class="input-with-emoji-container">
                  <input id="input-channel-name" required minlength="2" maxlength="50" value="${escapeHtml(target.value.name)}">
                  <button type="button" id="btn-emoji-channel-name" class="btn-input-emoji" aria-label="${t('chat.emojiPickerTitle')}">
                    <span class="material-symbols-outlined md-18">mood</span></button>
                </div></div>
              ${target.kind === 'channel' ? renderChannelCategorySelect(target.value.categoryId ?? null) +
                renderChannelBotCommandsField(target.value.botCommandsEnabled) : ''}
            </section>
            <section data-channel-panel="permissions" hidden>
              <p class="channel-permissions-hint">${t('channelPermissions.explanation')}</p>
              <div class="channel-sync-status" hidden><span data-sync-status role="status"></span>
                <button type="button" class="btn btn-secondary channel-sync-button" data-sync-category hidden>
                  <span class="material-symbols-outlined md-18" aria-hidden="true">sync</span>
                  <span>${t('channelPermissions.resync')}</span>
                </button></div>
              <fieldset class="channel-permission-controls">
                <div class="channel-privacy-row">
                  <div class="channel-privacy-info"><span class="channel-privacy-title">${t(target.kind === 'channel' ? 'channelModal.privateLabel' : 'categories.private')}</span>
                    <span class="channel-privacy-desc">${t('channelPermissions.privateHint')}</span></div>
                  <label class="toggle-switch" aria-label="${t(target.kind === 'channel' ? 'channelModal.privateLabel' : 'categories.private')}">
                    <input type="checkbox" id="input-channel-private"><span class="toggle-slider"></span></label>
                </div>
                <div class="channel-permission-layout">
                  <div class="channel-permission-targets"><div data-targets></div>
                    ${picker.render()}
                  </div>
                  <div data-permission-rules></div>
                </div>
              </fieldset>
            </section>
          </div>
          <footer class="modal-footer">
            <button type="button" class="btn btn-secondary" data-channel-close>${t('common.cancel')}</button>
            <button type="submit" id="btn-save" class="btn btn-primary">${t('channelModal.saveSubmit')}</button>
          </footer>
        </form>
      </div>
    </section>`;
    const name = root.querySelector<HTMLInputElement>('#input-channel-name')!;
    const categorySelect = root.querySelector<HTMLSelectElement>('#input-channel-category');
    const privacy = root.querySelector<HTMLInputElement>('#input-channel-private')!;
    const detachedEmoji = attachInputEmojiPicker(name, root.querySelector<HTMLElement>('#btn-emoji-channel-name')!);
    const isCurrent = () => !closed && isForegroundEvent() &&
      getActiveServerStore() === store && getActiveNetworkClient() === client &&
      client.getStatus() === 'CONNECTED' && store.serverDetails?.id === serverId && store.currentUser?.sessionId === sessionId;
    const category = () => store.serverDetails?.categories?.find(item => item.id === categorySelect?.value);
    const normalizedRules = (rules: ChannelPermissionOverwrite[]) => JSON.stringify(rules
      .filter(rule => rule.allow !== 0 || rule.deny !== 0)
      .map(rule => ({ target: channelPermissionTargetKey(rule), allow: rule.allow, deny: rule.deny }))
      .sort((a, b) => a.target.localeCompare(b.target)));
    const renderRules = () => {
      const targets = [
        { key: EVERYONE_ROLE_ID, name: t('roles.everyone'), icon: '' },
        ...overwrites.filter(entry => entry.roleId !== null).map(entry => {
          const member = entry.userId !== undefined ? store.knownMembers.get(entry.userId) : undefined;
          const role = entry.roleId != null ? store.getRole(entry.roleId) : undefined;
          return {
            key: channelPermissionTargetKey(entry),
            name: member?.nickname ?? role?.name ?? entry.userId ?? entry.roleId ?? '',
            icon: entry.userId !== undefined
              ? `<img class="share-audience-avatar" src="${escapeHtml(getAvatarUrl(member?.avatarUrl))}" alt="">`
              : `<span class="share-audience-role" style="--role-color:${isHexColor(role?.color) ? role.color : 'var(--text-muted)'}" aria-hidden="true"></span>`,
          };
        }),
      ];
      if (!targets.some(item => item.key === selectedTarget)) selectedTarget = EVERYONE_ROLE_ID;
      const selected = overwrites.find(entry => channelPermissionTargetKey(entry) === selectedTarget);
      root.querySelector<HTMLElement>('[data-targets]')!.innerHTML = targets.map(item =>
        `<button type="button" class="channel-permission-target ${item.key === selectedTarget ? 'active' : ''}"
        data-permission-target="${escapeHtml(item.key)}" aria-pressed="${item.key === selectedTarget}">${item.icon}<span>${escapeHtml(item.name)}</span></button>`).join('');
      picker.setValue(audienceValue());
      picker.sync(root);
      const visiblePermissions = permissionNames.filter(([bit]) => (bit & CHANNEL_PERMISSIONS) !== 0 &&
        (target.kind === 'category' || target.value.type === 'VOICE' ||
          ![Permission.SPEAK, Permission.MUTE_MEMBERS, Permission.DEAFEN_MEMBERS, Permission.USE_SOUNDBOARD].includes(bit)));
      root.querySelector<HTMLElement>('[data-permission-rules]')!.innerHTML = `
        <div class="channel-rules-heading"><h3>${escapeHtml(targets.find(item => item.key === selectedTarget)?.name ?? '')}</h3>
          ${selectedTarget === EVERYONE_ROLE_ID ? '' : `<button type="button" class="btn btn-danger" data-remove-rule>${t('channelPermissions.removeRole')}</button>`}</div>
        ${visiblePermissions.map(([bit, key]) => {
          const state = selected && selected.deny & bit ? 'deny' : selected && selected.allow & bit ? 'allow' : 'inherit';
          return `<div class="channel-permission-row"><div><div class="channel-permission-label">${t(`permissions.${key}`)}</div>
            <p>${t(`permissions.${key}Desc`)}</p></div>
            <div class="permission-three-state" role="radiogroup" aria-label="${t(`permissions.${key}`)}">
              ${states.map(option => `<button type="button" role="radio" aria-checked="${state === option.value}" tabindex="${state === option.value ? 0 : -1}"
                class="${state === option.value ? 'selected' : ''}" data-permission-bit="${bit}" data-permission-state="${option.value}"
                title="${t(option.label)}" aria-label="${t(option.label)}"><span class="material-symbols-outlined md-18" aria-hidden="true">${option.icon}</span></button>`).join('')}
            </div></div>`;
        }).join('')}`;
      const visibility = channelPrivacy(overwrites, privacySnapshot);
      privacySnapshot = { ...visibility, permissionOverwrites: overwrites.map(rule => ({ ...rule })) };
      privacy.checked = visibility.isPrivate;
      const parent = category();
      inherited = !!parent && privacySnapshot.isPrivate === parent.isPrivate &&
        normalizedRules(overwrites) === normalizedRules(channelOverwrites(parent));
      root.querySelector<HTMLFieldSetElement>('.channel-permission-controls')!.disabled = pending || confirming;
      root.querySelector<HTMLElement>('.channel-sync-status')!.hidden = !parent;
      root.querySelector<HTMLElement>('[data-sync-status]')!.textContent = t(inherited ? 'channelPermissions.synced' : 'channelPermissions.unsynced');
      const syncButton = root.querySelector<HTMLButtonElement>('[data-sync-category]')!;
      syncButton.hidden = !parent || inherited;
      syncButton.disabled = pending || confirming;
    };
    const close = (immediate = false) => {
      if (closed || (!immediate && (pending || confirming))) return;
      closed = true;
      controller.abort();
      unbind.forEach(off => off());
      detachedEmoji();
      exitModal(root, immediate);
      if (this.closeCurrent === close) this.closeCurrent = null;
    };
    this.closeCurrent = close;
    const refresh = () => {
      if (!isCurrent() || !current() || !allowed()) close(true);
    };
    const unbind = [
      store.bus.on('server.updated', refresh),
      appEvents.on('session.changed', () => { if (getActiveServerStore() !== store) close(true); }),
      appEvents.on('network.disconnected', () => { if (isForegroundEvent()) close(true); }),
    ];
    root.addEventListener('click', event => {
      const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null;
      if (!button || button.matches(':disabled') || !isCurrent()) return;
      if (button.hasAttribute('data-channel-close')) { close(); return; }
      if (button.dataset.channelTab) {
        root.querySelectorAll<HTMLButtonElement>('[data-channel-tab]').forEach(tab => {
          const active = tab === button;
          tab.classList.toggle('active', active);
          if (active) tab.setAttribute('aria-current', 'page'); else tab.removeAttribute('aria-current');
        });
        root.querySelectorAll<HTMLElement>('[data-channel-panel]').forEach(panel => {
          panel.hidden = panel.dataset.channelPanel !== button.dataset.channelTab;
          if (!panel.hidden) animateEnter(panel, 'view');
        });
      } else if (button.hasAttribute('data-sync-category')) {
        synchronizeCategory();
      } else if (button.hasAttribute('data-permission-target')) {
        selectedTarget = button.dataset.permissionTarget!;
        renderRules();
        root.querySelectorAll<HTMLButtonElement>('[data-permission-target]').forEach(targetButton => {
          if (targetButton.dataset.permissionTarget === selectedTarget) targetButton.focus({ preventScroll: true });
        });
      } else if (button.hasAttribute('data-remove-rule') && selectedTarget !== EVERYONE_ROLE_ID) {
        overwrites = overwrites.filter(entry => channelPermissionTargetKey(entry) !== selectedTarget);
        selectedTarget = EVERYONE_ROLE_ID;
        renderRules();
        root.querySelector<HTMLButtonElement>(`[data-permission-target="${EVERYONE_ROLE_ID}"]`)?.focus({ preventScroll: true });
      } else if (button.dataset.permissionBit && button.dataset.permissionState) {
        const bit = Number(button.dataset.permissionBit);
        let entry = overwrites.find(overwrite => channelPermissionTargetKey(overwrite) === selectedTarget);
        if (!entry) { entry = { roleId: null, allow: 0, deny: 0 }; overwrites.push(entry); }
        entry.allow = (entry.allow & ~bit) | (button.dataset.permissionState === 'allow' ? bit : 0);
        entry.deny = (entry.deny & ~bit) | (button.dataset.permissionState === 'deny' ? bit : 0);
        renderRules();
        root.querySelector<HTMLButtonElement>(`[data-permission-bit="${bit}"][data-permission-state="${button.dataset.permissionState}"]`)?.focus({ preventScroll: true });
      }
    }, options);
    privacy.addEventListener('change', () => {
      privacySnapshot.isPrivate = privacy.checked;
      overwrites = withChannelPrivacy(overwrites, privacy.checked, channelPrivacy(overwrites).allowedRoleIds);
      renderRules();
    }, options);
    picker.bind(root.querySelector<HTMLElement>('.settings-content-body')!, controller.signal, () => {
      const value = picker.value();
      if (value.visibility !== 'private' || !isCurrent() || pending || confirming) return;
      const targets: ChannelPermissionOverwrite[] = [
        ...value.roleIds.map(roleId => ({ roleId, allow: 0, deny: 0 })),
        ...value.userIds.map(userId => ({ userId, allow: 0, deny: 0 })),
      ];
      const keys = new Set(targets.map(channelPermissionTargetKey));
      const additions = targets.filter(entry => !overwrites.some(old => channelPermissionTargetKey(old) === channelPermissionTargetKey(entry)));
      overwrites = [...overwrites.filter(entry => entry.roleId === null || keys.has(channelPermissionTargetKey(entry))), ...additions];
      if (additions.length) selectedTarget = channelPermissionTargetKey(additions[0]);
      renderRules();
    });
    const adoptCategory = () => {
      const parent = category();
      if (parent) {
        overwrites = channelOverwrites(parent);
        privacySnapshot = { ...parent, permissionOverwrites: channelOverwrites(parent) };
      }
      renderRules();
    };
    categorySelect?.addEventListener('change', () => {
      if (inherited) adoptCategory();
      else renderRules();
    }, options);
    const synchronizeCategory = () => {
      if (!category() || inherited || pending || confirming) return;
      confirming = true;
      renderRules();
      void showConfirm({
        title: t('categories.inherit'), message: t('channelPermissions.resyncConfirm'),
        confirmLabel: t('channelPermissions.resync'), focusCancel: true, signal: controller.signal,
      }).then(confirmed => {
        confirming = false;
        if (!isCurrent()) return;
        if (confirmed) adoptCategory();
        else renderRules();
      });
    };
    root.addEventListener('keydown', event => {
      if (!handlesModalKey(root, event)) return;
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-permission-state]') : null;
      if (button && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const buttons = [...button.parentElement!.querySelectorAll<HTMLButtonElement>('button')];
        const index = buttons.indexOf(button);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowRight' ? 1 : 2)) % 3;
        buttons[next].click();
      }
      if (event.key === 'Tab') {
        const focusable = [...root.querySelectorAll<HTMLElement>('button, input, select, [tabindex="0"]')]
          .filter(element => !element.matches(':disabled, [tabindex="-1"]') && element.getClientRects().length > 0);
        const first = focusable[0], last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus({ preventScroll: true }); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus({ preventScroll: true }); }
      }
    }, options);
    root.querySelector('form')!.addEventListener('submit', event => {
      event.preventDefault();
      if (!isCurrent() || !allowed() || pending || confirming) return;
      const parent = category();
      if (snapshot() !== initial || parent && initialCategories.get(parent.id) !== JSON.stringify(parent)) {
        showErrorToast(t('channelPermissions.changed')); return;
      }
      if (name.value.trim().length < 2) { showErrorToast(t('channelPermissions.invalidName')); name.focus({ preventScroll: true }); return; }
      const changedRules = {
        ...(JSON.stringify(overwrites) !== initialOverwrites ? { permissionOverwrites: overwrites } : {}),
        ...(privacySnapshot.isPrivate !== target.value.isPrivate ? { isPrivate: privacySnapshot.isPrivate } : {}),
      };
      const payload = target.kind === 'channel'
        ? { channelId: target.value.id, name: name.value.trim(), categoryId: categorySelect?.value || null,
          inheritCategoryPermissions: inherited,
          botCommandsEnabled: readChannelBotCommandsField(root), ...(inherited ? {} : changedRules) }
        : { categoryId: target.value.id, name: name.value.trim(), ...changedRules };
      pending = true;
      root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button, input, select').forEach(control => { control.disabled = true; });
      root.querySelector('.channel-settings-card')!.setAttribute('aria-busy', 'true');
      void client.sendRequest(target.kind === 'channel' ? MessageType.CHANNEL_UPDATE : MessageType.CATEGORY_UPDATE, payload)
        .then(() => { if (isCurrent()) { pending = false; close(); } })
        .catch((error: unknown) => { if (isCurrent()) showErrorToast(error instanceof Error ? error.message : t('channelModal.editError')); })
        .finally(() => {
          pending = false;
          if (!isCurrent()) return;
          root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button, input, select').forEach(control => { control.disabled = false; });
          root.querySelector('.channel-settings-card')!.setAttribute('aria-busy', 'false');
          renderRules();
        });
    }, options);
    document.body.appendChild(root);
    enterModal(root);
    enableBackdropClose(root, () => close());
    renderRules();
    name.focus({ preventScroll: true });
  }

  close(): void { this.closeCurrent?.(); }
}

export const channelSettingsModal = new ChannelSettingsModal();
