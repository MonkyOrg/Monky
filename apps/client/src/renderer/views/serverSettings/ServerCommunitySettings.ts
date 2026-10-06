import { MessageType, Permission } from '@monky/shared';
import type { CommunityFeed } from '../../core/CommunityFeed';
import type { ServerSettingsContext } from './ServerSettingsContext';
import { t } from '../../i18n';
import { escapeHtml } from '../../utils/html';
import { pickAndCropImage } from '../ImageCropModal';
import '../../styles/community.css';

export class ServerCommunitySettings {
  constructor(private readonly feed: CommunityFeed) {}

  renderEventsHtml(): string {
    const snapshot = this.feed.snapshot;
    return `<fieldset class="server-settings-fieldset" data-server-permission="${Permission.MANAGE_SERVER}">
      <section data-settings-section="server-events" data-settings-label="${escapeHtml(t('community.events'))}"
        style="display: flex; align-items: center; justify-content: space-between; gap: 12px; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 14px; margin-bottom: 16px;">
        <div style="min-width: 0;">
          <label for="community-events-enabled" style="display: block; font-size: 13px; font-weight: 600; color: var(--text-primary); margin-bottom: 2px;">${t('community.enabled')}</label>
          <p style="font-size: 11px; color: var(--text-muted); margin: 0;">${t('community.enabledHint')}</p>
        </div>
        <label class="toggle-switch"><input id="community-events-enabled" type="checkbox" role="switch"
          ${snapshot?.settings.eventsEnabled ? 'checked' : ''} ${!snapshot || !this.feed.server.hasPermission(Permission.MANAGE_SERVER) ? 'disabled' : ''}>
          <span class="toggle-slider"></span></label>
      </section>
    </fieldset>`;
  }

  renderBannerHtml(): string {
    const snapshot = this.feed.snapshot;
    return `<div class="form-group" data-settings-section="server-banner" data-settings-label="${escapeHtml(t('community.banner'))}" style="margin: 16px 0 0;">
        <label for="community-choose-banner">${t('community.banner')}</label>
        <img id="community-server-banner" class="community-cover" alt="${escapeHtml(t('community.banner'))}"
          ${snapshot?.settings.bannerUrl ? `src="${escapeHtml(this.feed.client.getHttpBaseUrl() + snapshot.settings.bannerUrl)}"` : 'hidden'}>
        <div class="community-actions">
          <button id="community-choose-banner" class="btn btn-secondary" type="button" data-community-setting="image" ${this.feed.server.hasPermission(Permission.MANAGE_SERVER) ? '' : 'disabled'}>${t('community.chooseImage')}</button>
          <button class="btn btn-secondary" type="button" data-community-setting="remove" ${this.feed.server.hasPermission(Permission.MANAGE_SERVER) && snapshot?.settings.bannerUrl ? '' : 'disabled'}>${t('community.removeImage')}</button>
        </div>
      </div>`;
  }

  attach(root: HTMLElement, context: ServerSettingsContext): () => void {
    const abort = new AbortController();
    const toggle = root.querySelector<HTMLInputElement>('#community-events-enabled');
    toggle?.addEventListener('change', () => {
      const enabled = toggle.checked;
      void context.operations.run('community-events', t('community.eventsAndLiveActions'), Permission.MANAGE_SERVER, async () => {
        await context.request(MessageType.COMMUNITY_UPDATE_SETTINGS, { eventsEnabled: enabled }, Permission.MANAGE_SERVER);
      }).then(() => { if (!abort.signal.aborted) sync(); });
    }, { signal: abort.signal });
    root.addEventListener('click', (event) => {
      const action = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-community-setting]')?.dataset.communitySetting : undefined;
      if (action !== 'image' && action !== 'remove') return;
      const button = event.target instanceof Element
        ? event.target.closest<HTMLElement>('[data-community-setting]')
        : null;
      void context.operations.run('community-banner', t('community.banner'), Permission.MANAGE_SERVER, async () => {
        const image = action === 'image' && button ? await pickAndCropImage(button, 'banner') : null;
        if (action === 'image' && image === null) return;
        context.assertAllowed(Permission.MANAGE_SERVER);
        await context.request(MessageType.COMMUNITY_UPDATE_SETTINGS, { bannerBase64: image }, Permission.MANAGE_SERVER);
      }).then(() => { if (!abort.signal.aborted) sync(); });
    }, { signal: abort.signal });
    const sync = () => this.refreshState(root, context);
    const unsubscribe = this.feed.subscribe(sync);
    sync();
    return () => { abort.abort(); unsubscribe(); };
  }

  refreshState(root: HTMLElement, context: ServerSettingsContext): void {
    const toggle = root.querySelector<HTMLInputElement>('#community-events-enabled');
    if (toggle) {
      toggle.checked = this.feed.snapshot?.settings.eventsEnabled ?? false;
      toggle.disabled = context.operations.pendingCount > 0 || !this.feed.snapshot || !context.store.hasPermission(Permission.MANAGE_SERVER);
    }
    const image = root.querySelector<HTMLImageElement>('#community-server-banner');
    if (image) {
      const url = this.feed.snapshot?.settings.bannerUrl;
      image.hidden = !url;
      if (url) image.src = this.feed.client.getHttpBaseUrl() + url;
      else image.removeAttribute('src');
    }
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-community-setting]')) {
      button.disabled = context.operations.pendingCount > 0 || !context.store.hasPermission(Permission.MANAGE_SERVER) ||
        (button.dataset.communitySetting === 'remove' && !this.feed.snapshot?.settings.bannerUrl);
    }
  }
}
