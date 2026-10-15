import {
  BOT_STORAGE_LIMITS, MessageType, botDeviceStorageScopeSchema, botStorageInfoSchema, botStorageLevelEventSchema,
  type BotDeviceStorageDecision, type BotDeviceStorageEntry, type BotDeviceStorageScope, type BotStorageInfo,
} from '@monky/shared';
import { appEvents } from '../core/EventBus';
import type { NetworkClient } from '../core/NetworkClient';
import { currentEventOrigin } from '../core/sessionRouting';
import { t } from '../i18n';
import type { ServerStore } from '../stores/serverStore';
import { formatBytes } from '../utils/attachment';
import { botRequestError } from '../utils/botInputs';
import { escapeHtml } from '../utils/html';
import { renderLoadingIndicator } from '../utils/loadingIndicator';
import { storageUsageHtml } from '../utils/storageUsage';
import { showErrorToast, showSuccessToast } from './CopyToast';
import { showConfirm } from './Dialog';

const MIB = 1024 * 1024;
const MIN_MB = BOT_STORAGE_LIMITS.minQuotaBytes / MIB;
const MAX_MB = BOT_STORAGE_LIMITS.maxQuotaBytes / MIB;
const DECISIONS: readonly BotDeviceStorageDecision[] = ['ask', 'always', 'never'];
const DECISION_TEXT = {
  ask: ['botStorage.decisionAsk', 'botStorage.decisionAskHint'],
  always: ['botStorage.decisionAlways', 'botStorage.decisionAlwaysHint'],
  never: ['botStorage.decisionNever', 'botStorage.decisionNeverHint'],
} as const;

export interface BotStorageSettingsContext {
  client: NetworkClient;
  server: ServerStore;
  botId: string;
  botName: () => string;
  canManage: () => boolean;
  isCurrent: () => boolean;
  request: (type: MessageType, payload: unknown) => Promise<unknown>;
}

/** The Storage tab of the bot settings: the bot's space on this server and on this computer. */
export class BotStorageSettings {
  private container: HTMLElement | null = null;
  private info: BotStorageInfo | null = null;
  private device: BotDeviceStorageEntry | null = null;
  private deviceFailed = false;
  private loading = false;
  private failed = false;
  private busy = false;
  private generation = 0;
  private readonly unbind: Array<() => void>;

  constructor(private readonly context: BotStorageSettingsContext) {
    this.unbind = [
      window.api.botStorage.onChanged((scopeId) => {
        if (this.device?.id === scopeId && !this.busy) void this.loadDevice();
      }),
      appEvents.on(`message.${MessageType.BOT_STORAGE_LEVEL}`, (payload: unknown) => {
        const parsed = botStorageLevelEventSchema.safeParse(payload);
        if (!parsed.success || parsed.data.botId !== context.botId || !this.info?.server ||
            currentEventOrigin() !== context.client.sessionKey) return;
        this.info = { ...this.info, server: { ...this.info.server, usage: parsed.data.usage } };
        this.render();
      }),
      // The server part exists only for people who manage bots, so a role change asks again.
      appEvents.on('server.roles_updated', () => {
        const origin = currentEventOrigin();
        if (this.container && !this.loading && !this.busy && (origin === null || origin === context.client.sessionKey)) this.reload();
      }),
    ];
  }

  static supported(server: ServerStore): boolean {
    return server.serverDetails?.protocol?.features.includes('bot-storage') === true;
  }

  get botId(): string { return this.context.botId; }

  mount(container: HTMLElement): void {
    if (this.container !== container) {
      this.container?.removeEventListener('click', this.onClick);
      this.container?.removeEventListener('submit', this.onSubmit);
      this.container = container;
      container.addEventListener('click', this.onClick);
      container.addEventListener('submit', this.onSubmit);
    }
    this.render();
    if (!this.info && !this.loading && !this.failed) void this.load();
  }

  reload(): void {
    this.failed = false;
    void this.load();
  }

  destroy(): void {
    this.generation++;
    for (const remove of this.unbind) remove();
    this.container?.removeEventListener('click', this.onClick);
    this.container?.removeEventListener('submit', this.onSubmit);
    this.container = null;
  }

  private scope(): BotDeviceStorageScope | null {
    const details = this.context.server.serverDetails;
    const parsed = botDeviceStorageScopeSchema.safeParse({
      serverUrl: this.context.client.getCurrentServerUrl(), serverId: details?.id, serverName: details?.name,
      userId: this.context.server.currentUser?.id, botId: this.context.botId, botName: this.context.botName(),
    });
    return parsed.success ? parsed.data : null;
  }

  private async load(): Promise<void> {
    const generation = ++this.generation;
    this.loading = true;
    this.render();
    try {
      const info = botStorageInfoSchema.parse(await this.context.request(MessageType.BOT_STORAGE_INFO_GET, { botId: this.context.botId }));
      if (generation !== this.generation || !this.context.isCurrent()) return;
      if (info.botId !== this.context.botId) throw new Error(t('botSettings.invalidResponse'));
      this.info = info;
      this.failed = false;
      await this.loadDevice();
    } catch (error: unknown) {
      if (generation !== this.generation || !this.context.isCurrent()) return;
      this.failed = true;
      showErrorToast(error instanceof Error && error.message ? botRequestError(error) : t('botStorage.loadFailed'));
    } finally {
      if (generation === this.generation) {
        this.loading = false;
        this.render();
      }
    }
  }

  private async loadDevice(): Promise<void> {
    const scope = this.scope();
    try {
      if (!scope) throw new Error('Incomplete storage scope.');
      const device = await window.api.botStorage.get(scope);
      if (!this.context.isCurrent()) return;
      this.device = device;
      this.deviceFailed = false;
    } catch (error: unknown) {
      console.warn('[Bot storage] Could not read the storage on this computer.', error);
      this.deviceFailed = true;
    }
    this.render();
  }

  private render(): void {
    const container = this.container;
    if (!container?.isConnected) return;
    const focused = document.activeElement instanceof HTMLElement && container.contains(document.activeElement)
      ? document.activeElement : null;
    const focusKey = focused?.id || focused?.dataset.storageDecision || focused?.dataset.storageClear;
    if (!this.info) {
      container.innerHTML = this.loading
        ? `<p class="bot-status" role="status">${renderLoadingIndicator(t('botStorage.loading'))}</p>`
        : `<p class="bot-settings-description">${escapeHtml(t('botStorage.loadFailed'))}</p>`;
      return;
    }
    const { server, device } = this.info;
    const disabled = this.busy ? 'disabled' : '';
    const limit = (scope: 'server' | 'device', bytes: number): string => `
      <form class="bot-storage-limit" data-storage-limit="${scope}" novalidate>
        <label for="bot-storage-${scope}-limit">${escapeHtml(t('botStorage.limit'))}</label>
        <div class="bot-storage-limit-row">
          <input id="bot-storage-${scope}-limit" class="input-field" type="number" inputmode="numeric" step="1"
            min="${MIN_MB}" max="${MAX_MB}" value="${Math.round(bytes / MIB)}" aria-describedby="bot-storage-${scope}-limit-hint" ${disabled}>
          <button type="submit" class="btn btn-secondary" ${disabled}>${escapeHtml(t('botStorage.saveLimit'))}</button>
        </div>
        <p id="bot-storage-${scope}-limit-hint" class="bot-field-description">${escapeHtml(t('botStorage.limitHint', {
          min: formatBytes(BOT_STORAGE_LIMITS.minQuotaBytes), max: formatBytes(BOT_STORAGE_LIMITS.maxQuotaBytes),
          object: formatBytes(BOT_STORAGE_LIMITS.objectBytes),
        }))}</p>
      </form>`;
    const note = (key: Parameters<typeof t>[0]): string => `<p class="bot-settings-description">${escapeHtml(t(key))}</p>`;
    const entry = this.device;
    // Only people who manage bots receive the server part; everyone else sees just their own computer.
    container.innerHTML = `${server ? `
      <section class="bot-storage-section" data-storage-section="server">
        <h3 class="bot-settings-section-title">${escapeHtml(t('botStorage.serverTitle'))}</h3>
        <p class="bot-settings-description">${escapeHtml(t('botStorage.serverDescription'))}</p>
        ${!server.requested ? note('botStorage.serverNotRequested') : !server.granted ? note('botStorage.serverNotGranted') : ''}
        ${storageUsageHtml(server.usage)}
        ${this.context.canManage() ? `${limit('server', server.usage.maxBytes)}
          <button type="button" class="btn btn-danger" data-storage-clear="server" ${this.busy || !server.usage.objectCount ? 'disabled' : ''}>
            ${escapeHtml(t('botStorage.clearServer'))}</button>` : ''}
      </section>` : ''}
      <section class="bot-storage-section" data-storage-section="device">
        <h3 class="bot-settings-section-title">${escapeHtml(t('botStorage.deviceTitle'))}</h3>
        <p class="bot-settings-description">${escapeHtml(t('botStorage.deviceDescription'))}</p>
        ${!device.requested ? note('botStorage.deviceNotRequested') : !device.granted ? note('botStorage.deviceNotGranted') : ''}
        ${this.deviceFailed || !entry ? note('botStorage.deviceUnavailable') : `
          ${storageUsageHtml(entry.usage)}
          <p class="bot-storage-decision-label" id="bot-storage-decision-label">${escapeHtml(t('botStorage.decision'))}</p>
          <div class="input-mode-cards" role="group" aria-labelledby="bot-storage-decision-label">
            ${DECISIONS.map((decision) => `<button type="button" class="voice-mode-card input-mode-card"
              data-storage-decision="${decision}" aria-pressed="${entry.decision === decision}" ${disabled}>
              <span class="input-mode-card-title">${escapeHtml(t(DECISION_TEXT[decision][0]))}</span>
              <span class="input-mode-card-description">${escapeHtml(t(DECISION_TEXT[decision][1]))}</span>
            </button>`).join('')}
          </div>
          ${limit('device', entry.usage.maxBytes)}
          <button type="button" class="btn btn-danger" data-storage-clear="device" ${this.busy || !entry.usage.objectCount ? 'disabled' : ''}>
            ${escapeHtml(t('botStorage.clearDevice'))}</button>`}
      </section>`;
    if (!focusKey) return;
    const restored = container.querySelector<HTMLElement>(`#${CSS.escape(focusKey)}, [data-storage-decision="${CSS.escape(focusKey)}"], [data-storage-clear="${CSS.escape(focusKey)}"]`);
    (restored && !restored.matches(':disabled') ? restored : container.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled)'))
      ?.focus({ preventScroll: true });
  }

  private onClick = (event: MouseEvent): void => {
    if (!(event.target instanceof Element) || this.busy || !this.context.isCurrent()) return;
    const decision = event.target.closest<HTMLElement>('[data-storage-decision]')?.dataset.storageDecision;
    const chosen = DECISIONS.find((value) => value === decision);
    if (chosen) {
      if (chosen !== this.device?.decision) void this.setDecision(chosen);
      return;
    }
    const clear = event.target.closest<HTMLElement>('[data-storage-clear]')?.dataset.storageClear;
    if (clear === 'server' || clear === 'device') void this.clear(clear);
  };

  private onSubmit = (event: SubmitEvent): void => {
    if (!(event.target instanceof HTMLFormElement)) return;
    const scope = event.target.dataset.storageLimit;
    if (scope !== 'server' && scope !== 'device') return;
    event.preventDefault();
    event.stopPropagation();
    const input = event.target.querySelector<HTMLInputElement>('input');
    const value = Number(input?.value);
    if (!input || this.busy) return;
    if (!Number.isInteger(value) || value < MIN_MB || value > MAX_MB) {
      input.setAttribute('aria-invalid', 'true');
      input.focus();
      showErrorToast(t('botStorage.limitInvalid', { min: MIN_MB, max: MAX_MB }));
      return;
    }
    input.removeAttribute('aria-invalid');
    void this.saveLimit(scope, value * MIB);
  };

  private async run(action: () => Promise<string | null>, failure: 'server' | 'device'): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.render();
    try {
      const message = await action();
      if (message && this.context.isCurrent()) showSuccessToast(message);
    } catch (error: unknown) {
      if (!this.context.isCurrent()) return;
      showErrorToast(failure === 'server' && error instanceof Error && error.message ? botRequestError(error) : t('botStorage.saveFailed'));
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private saveLimit(scope: 'server' | 'device', bytes: number): Promise<void> {
    return this.run(async () => {
      if (scope === 'server') {
        const info = botStorageInfoSchema.parse(await this.context.request(MessageType.BOT_STORAGE_LIMIT_UPDATE, {
          botId: this.context.botId, maxBytes: bytes,
        }));
        if (info.botId !== this.context.botId) throw new Error(t('botSettings.invalidResponse'));
        this.info = info;
      } else {
        const storage = this.scope();
        if (!storage) throw new Error('Incomplete storage scope.');
        this.device = await window.api.botStorage.setQuota(storage, bytes);
      }
      return t('botStorage.limitSaved');
    }, scope);
  }

  private setDecision(decision: BotDeviceStorageDecision): Promise<void> {
    return this.run(async () => {
      const storage = this.scope();
      if (!storage) throw new Error('Incomplete storage scope.');
      this.device = await window.api.botStorage.setDecision(storage, decision);
      return t('botStorage.decisionSaved');
    }, 'device');
  }

  private async clear(scope: 'server' | 'device'): Promise<void> {
    const usage = scope === 'server' ? this.info?.server?.usage : this.device?.usage;
    if (!usage) return;
    const confirmed = await showConfirm({
      title: t(scope === 'server' ? 'botStorage.clearServerTitle' : 'botStorage.clearDeviceTitle'),
      message: t(scope === 'server' ? 'botStorage.clearServerConfirm' : 'botStorage.clearDeviceConfirm', {
        bot: this.context.botName(), size: formatBytes(usage.usedBytes),
      }),
      confirmLabel: t('botStorage.clear'),
      variant: 'danger',
      focusCancel: true,
    });
    if (!confirmed || !this.context.isCurrent()) return;
    await this.run(async () => {
      if (scope === 'server') {
        const info = botStorageInfoSchema.parse(await this.context.request(MessageType.BOT_STORAGE_CLEAR, { botId: this.context.botId }));
        if (info.botId !== this.context.botId) throw new Error(t('botSettings.invalidResponse'));
        this.info = info;
        return t('botStorage.serverCleared');
      }
      const entry = this.device;
      if (!entry) return null;
      await window.api.botStorage.clear(entry.id);
      const storage = this.scope();
      if (storage) this.device = await window.api.botStorage.get(storage);
      return t('botStorage.deviceCleared');
    }, scope);
  }
}
