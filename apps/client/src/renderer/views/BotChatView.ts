import {
  LIMITS,
  MessageType,
  Permission,
  getCommandPresentation,
  localizeCommand,
  botSettingsListResponseSchema,
  commandAutocompleteCancelSchema,
  commandAutocompleteResultSchema,
  type BotFormValues,
  type CommandFinishedPayload,
  type CommandInvokedPayload,
  type CommandInvokePayload,
  type CommandSubmitPayload,
  type CommandAutocompletePayload,
  type CommandAutocompleteResultPayload,
  type CommandAudioPreviewPayload,
  type CommandPresentation,
  type SlashCommand,
} from '@monky/shared';
import { v4 as uuidv4 } from 'uuid';
import { appEvents } from '../core/EventBus';
import { type NetworkClient } from '../core/NetworkClient';
import { getActiveChatStore, type BotInvocation, type ChatStore, type CommandDraft } from '../stores/chatStore';
import { type ServerStore } from '../stores/serverStore';
import { t, type TranslationKey } from '../i18n';
import { escapeHtml } from '../utils/html';
import { renderLoadingIndicator } from '../utils/loadingIndicator';
import { getAvatarUrl } from '../utils/avatar';
import {
  botInputError,
  botRequestError,
  commandInputFields,
  commandValuesFromInputs,
  autocompleteCommandOptions,
  formValuesFromInputs,
  visibleCommandFields,
  visibleCommandValues,
  type BotInputField,
} from '../utils/botInputs';
import { applyBotFieldAction, readBotFieldChange, renderBotFields, type BotFieldContext } from './botFields';
import {
  commandParameterChoices, commandParameterHint, commandParameterLabel, commandParameterError, renderCompactCommand,
  renderParameterChoices, renderParameterChoiceItems,
  type ParameterChoice,
} from './commandComposer';
import { CommandAutocomplete, type AutocompleteState } from '../utils/commandAutocomplete';
import { settingsStore } from '../stores/settingsStore';
import { localSoundDownloads } from '../core/LocalSoundDownloadService';
import { soundDownloadText } from '../utils/soundDownloadText';
import { audioPreviewService } from '../core/AudioPreviewService';
import { choicesHaveAudio, commandPreviewVolumeScope, renderAudioPreviewVolume } from '../utils/selectionChoices';
import { localExecutionFor, type LocalExecutionController, type PreparedLocalCapability } from '../core/LocalExecutionController';
import { commandLocalCapabilities, commandLocalIdentity, localFailure, observeWithSignal } from '../core/localExecutionSupport';
import { botPreferenceScopeFor, botUserSettingsPayload } from '../utils/botSettingsContext';
import { botLocaleFor } from '../utils/botLocale';
import { botSettingsMenuItem } from './BotSettingsModal';
import { contextMenu } from './ContextMenu';
import { currentEventOrigin } from '../core/sessionRouting';
import { commandVoiceContextKey, commandVoiceError } from '../utils/botVoice';
import { translateProtocolError } from '../i18n/protocolErrors';

const FINISH_KEYS: Record<Exclude<BotInvocation['status'], 'active'>, TranslationKey> = {
  completed: 'botChat.completed',
  cancelled: 'botChat.cancelled',
  expired: 'botChat.expired',
  bot_disconnected: 'botChat.botDisconnected',
  caller_disconnected: 'botChat.callerDisconnected',
  failed: 'botChat.failed',
};

export function renderBotIdentity(name: string, avatarUrl?: string | null): string {
  return `<div class="bot-chat-identity">
    <img class="chat-author-avatar" src="${escapeHtml(getAvatarUrl(avatarUrl))}" alt="" data-fallback="avatar">
    <span class="chat-author-name">${escapeHtml(name)}</span>
    <span class="member-badge-bot">${t('botChat.badge')}</span>
    <span class="bot-private-cue"><span class="material-symbols-outlined md-14" aria-hidden="true">lock</span>${t('botChat.private')}</span>
  </div>`;
}

export function renderBotInvocation(
  invocation: BotInvocation, canSend = true, serverId?: string, voiceError?: string, presentation?: CommandPresentation,
): string {
  const visibleForms = invocation.forms.filter((state) => state.status !== 'submitted');
  // The attributed reply already represents a completed text-only command.
  if (invocation.status === 'completed' && visibleForms.length === 0 && invocation.hasResponse && !invocation.soundDownload) return '';
  const active = invocation.status === 'active';
  const volumeScope = commandPreviewVolumeScope(serverId, invocation.botId, invocation.commandName);
  const forms = visibleForms.map((state) => {
    const editable = active && !invocation.cancelPending && state.status === 'editing' && canSend && !voiceError;
    const buttonsOnly = state.form.fields.length === 1 &&
      state.form.fields[0].type === 'select' && state.form.fields[0].presentation === 'buttons';
    return `<form class="bot-inline-form" data-interaction-id="${escapeHtml(state.interactionId)}" aria-busy="${state.status === 'submitting'}" novalidate>
      <h3>${escapeHtml(state.form.title)}</h3>
      ${state.form.description ? `<p class="bot-field-description">${escapeHtml(state.form.description)}</p>` : ''}
      ${renderBotFields(state.form.fields, state.values, { prefix: `${invocation.invocationId}-${state.interactionId}`, disabled: !editable, volumeScope })}
      <p class="bot-error" role="alert" ${state.error ? '' : 'hidden'}>${escapeHtml(state.error)}</p>
      ${state.status === 'submitted' ? `<p class="bot-status">${t('botChat.submitted')}</p>` :
        state.status === 'closed' || !active ? `<p class="bot-status">${t('botChat.stepClosed')}</p>` :
          buttonsOnly ? state.status === 'submitting'
            ? `<p class="bot-status" role="status">${renderLoadingIndicator(t('botChat.submitting'))}</p>` : ''
            : `<button type="submit" class="btn btn-primary" ${!editable ? 'disabled' : ''} ${state.status === 'submitting' ? 'data-loading="1" aria-busy="true"' : ''}>
            ${escapeHtml(state.status === 'submitting' ? t('botChat.submitting') : state.form.submitLabel ?? t('botChat.submit'))}
          </button>`}
    </form>`;
  }).join('');
  const download = invocation.soundDownload;
  const downloadConfirming = download?.phase === 'confirming' && !download.result;
  const waiting = active && !download && !invocation.forms.some((form) => form.status === 'editing' || form.status === 'submitting');
  const downloadMessage = downloadConfirming ? t('botChat.downloadConfirmationPending')
    : download?.result ? soundDownloadText(download.result)
      : download ? t('botChat.downloadProgress', {
        received: Math.round(download.receivedBytes / 1024),
        total: download.totalBytes ? `${Math.round(download.totalBytes / 1024)} KiB` : t('botChat.downloadUnknownSize'),
      }) : '';
  return `<section class="bot-interaction-card" data-invocation-id="${escapeHtml(invocation.invocationId)}"
    data-bot-id="${escapeHtml(invocation.botId)}" data-command-name="${escapeHtml(invocation.commandName)}">
    ${renderBotIdentity(invocation.botName, invocation.botAvatarUrl)}
    ${invocation.commandName ? `<div class="bot-command-name">/${escapeHtml(presentation?.displayName ?? invocation.commandName)}</div>` : ''}
    ${forms}
    ${voiceError && active ? `<p class="bot-command-voice-error" role="status">${escapeHtml(voiceError)}</p>` : ''}
    ${download ? `<div class="bot-sound-download">
      <strong>${escapeHtml(download.title)}</strong><small>${escapeHtml(download.fileName)}</small>
      ${!download.result && !downloadConfirming ? `<progress ${download.totalBytes ? `value="${download.receivedBytes}" max="${download.totalBytes}"` : ''}></progress>` : ''}
      <p class="bot-status" role="status" aria-busy="${!download.result}">${download.result
        ? escapeHtml(downloadMessage) : renderLoadingIndicator(downloadMessage)}</p>
    </div>` : ''}
    ${waiting ? `<p class="bot-status" role="status" aria-busy="true">${renderLoadingIndicator(t('botChat.waiting'))}</p>` : ''}
    ${invocation.status !== 'active' && !download ? `<p class="bot-status" role="status">${t(FINISH_KEYS[invocation.status])}</p>` : ''}
    <p class="bot-error" role="alert" ${invocation.error ? '' : 'hidden'}>${escapeHtml(invocation.error)}</p>
    ${active ? `<button type="button" class="btn btn-secondary bot-cancel-interaction" data-bot-action="cancel-invocation"
      ${invocation.cancelPending ? 'disabled data-loading="1" aria-busy="true"' : ''}>${t(invocation.cancelPending ? 'botChat.cancelling' : 'botChat.cancelInvocation')}</button>` : ''}
  </section>`;
}

interface FieldBinding {
  fields: BotInputField[];
  values: BotFormValues;
  context: BotFieldContext;
  save: (values: BotFormValues) => void;
}

type ParameterMenu =
  | { kind: 'optional'; activeIndex: number }
  | { kind: 'choices' | 'autocomplete'; fieldName: string; activeIndex: number };

interface AutocompleteRequest {
  requestId: string;
  connectionId: string;
  payload: CommandAutocompletePayload;
  resources: Set<string>;
  cancel: () => void;
}

/**
 * DOM listeners belong to this channel view; drafts and forms belong to its
 * captured session. A late acknowledgement never writes through active proxies.
 */
export class BotChatView {
  private unbind: Array<() => void> = [];
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private parameterMenu: ParameterMenu | null = null;
  private menuChoices: ParameterChoice[] = [];
  private focusedParameter: string | null = null;
  private suppressChoiceFocus = false;
  private autocomplete: CommandAutocomplete;
  private autocompleteField: string | null = null;
  private autocompleteRequests = new Map<string, AutocompleteRequest>();
  private autocompleteState: AutocompleteState | null = null;
  private autocompletePaged = false;
  private composing = false;
  private deferredRender = false;
  private submitGesture = false;
  private settingsRevisions = new Map<string, string>();
  private voiceEpoch = 0;
  private voiceDraft: CommandDraft | null = null;
  private voiceContextRevision = 0;
  private invocationVoiceContexts = new Map<string, string>();
  private localPreparation: {
    draft: CommandDraft; connectionId: string; voiceContext: string; metadata: string; owner: AbortController;
  } | null = null;
  private preparingCommand: CommandDraft | null = null;
  private commandPreparationId: string | null = null;

  constructor(
    private store: ChatStore,
    private client: NetworkClient,
    private server: ServerStore,
    private channelId: string,
    private composer: HTMLElement,
    private feed: HTMLElement,
    private onComposerChanged: () => void,
    private onInvocationChanged: (invocation: BotInvocation) => void
  ) {
    this.autocomplete = new CommandAutocomplete(client, (query, signal, page, cursor) => this.prepareAutocompleteQuery(query, signal, page, cursor),
      (state) => this.renderAutocomplete(state));
    composer.addEventListener('scroll', this.onAutocompleteScroll, { capture: true, passive: true });
    this.unbind.push(() => composer.removeEventListener('scroll', this.onAutocompleteScroll, true));
    if (server.serverDetails && server.currentUser) {
      store.setCommandUsageScope({ serverId: server.serverDetails.id, callerId: server.currentUser.id });
    }
    for (const root of [composer, feed]) {
      root.addEventListener('input', this.onInput);
      root.addEventListener('change', this.onInput);
      root.addEventListener('click', this.onClick);
      root.addEventListener('contextmenu', this.onContextMenu);
      root.addEventListener('submit', this.onSubmit);
      root.addEventListener('keydown', this.onKeyDown);
      root.addEventListener('focusin', this.onFocus);
      root.addEventListener('focusout', this.onBlur);
      root.addEventListener('compositionstart', this.onCompositionStart);
      root.addEventListener('compositionend', this.onCompositionEnd);
      this.unbind.push(audioPreviewService.bind(root, root === composer
        ? (resourceId, requestId, signal) => this.previewAutocomplete(resourceId, requestId, signal) : undefined,
      (controls) => this.previewVoiceError(controls),
      root === composer ? (reference, requestId, signal) => localExecutionFor(this.client).resolvePreview(reference, requestId, signal) : undefined));
      this.unbind.push(() => {
        root.removeEventListener('input', this.onInput);
        root.removeEventListener('change', this.onInput);
        root.removeEventListener('click', this.onClick);
        root.removeEventListener('contextmenu', this.onContextMenu);
        root.removeEventListener('submit', this.onSubmit);
        root.removeEventListener('keydown', this.onKeyDown);
        root.removeEventListener('focusin', this.onFocus);
        root.removeEventListener('focusout', this.onBlur);
        root.removeEventListener('compositionstart', this.onCompositionStart);
        root.removeEventListener('compositionend', this.onCompositionEnd);
      });
    }
    const closeOutsideMenu = (event: PointerEvent) => {
      if (event.target instanceof Node && !this.composer.contains(event.target)) this.closeParameterMenu();
    };
    document.addEventListener('pointerdown', closeOutsideMenu);
    this.unbind.push(() => document.removeEventListener('pointerdown', closeOutsideMenu));
    this.unbind.push(
      appEvents.on('chat.command_draft_updated', ({ channelId }: { channelId: string }) => {
        if (this.isCurrent() && channelId === this.channelId) this.renderComposer();
      }),
      appEvents.on('chat.bot_interaction_updated', (event: { channelId: string; invocationId: string }) => {
        if (!this.isCurrent() || event.channelId !== this.channelId) return;
        const invocation = this.store.getInvocation(event.invocationId);
        if (invocation) this.onInvocationChanged(invocation);
        audioPreviewService.prune(this.feed);
        this.scheduleExpiry();
      }),
      appEvents.on('server.roles_updated', () => this.refreshPermissions()),
      appEvents.on('network.status', () => {
        if (this.isCurrent() && this.client.getStatus() !== 'CONNECTED') {
          this.cancelLocalPreparation();
          this.closeParameterMenu();
          this.renderComposer();
        }
      }),
      appEvents.on('localExecution.permission_revoked', ({ sessionKey, botId }: { sessionKey: string; botId: string }) => {
        if (!this.isCurrent() || sessionKey !== this.client.sessionKey ||
          this.store.getCommandDraft(this.channelId)?.command.botId !== botId) return;
        this.cancelLocalPreparation();
        this.closeParameterMenu();
        this.renderComposer();
      }),
      appEvents.on('message.COMMAND_AUTOCOMPLETE_CANCEL', (payload: unknown) => {
        const origin = currentEventOrigin();
        if (!this.isCurrent() || (origin !== null && origin !== this.client.sessionKey)) return;
        const parsed = commandAutocompleteCancelSchema.safeParse(payload);
        const request = parsed.success ? this.autocompleteRequests.get(parsed.data.requestId) : undefined;
        if (request) {
          if (this.autocompletePaged) this.expireAutocompleteRequest(request);
          else this.closeParameterMenu();
        }
      }),
      appEvents.on('server.updated', () => this.refreshPermissions()),
      appEvents.on('server.members_updated', () => this.refreshMembers()),
      appEvents.on('user.updated', () => this.refreshMembers()),
      appEvents.on('voice.channel_changed', () => this.refreshVoiceEligibility()),
      appEvents.on('participants.updated', () => this.refreshVoiceEligibility()),
      appEvents.on('session.voice_context_updated', () => this.refreshVoiceEligibility()),
      appEvents.on('bot.preferences_updated', ({ scope, customChanged }: { scope: string; customChanged: boolean }) => {
        const draft = this.store.getCommandDraft(this.channelId);
        if (!customChanged || !this.isCurrent() || !draft ||
            scope !== botPreferenceScopeFor(this.client, this.server, draft.command.botId)) return;
        this.invalidateAutocomplete();
        this.renderComposer();
      }),
      appEvents.on('i18n.language_changed', () => {
        if (!this.isCurrent()) return;
        this.invalidateAutocomplete();
        this.renderComposer();
      }),
      appEvents.on('message.BOT_SETTINGS_LIST_RESPONSE', (payload: unknown) => {
        const origin = currentEventOrigin();
        if (!this.isCurrent() || (origin !== null && origin !== this.client.sessionKey)) return;
        const parsed = botSettingsListResponseSchema.safeParse(payload);
        if (!parsed.success) { console.warn('[Bot settings] Invalid settings catalog.'); return; }
        const next = new Map(parsed.data.bots.map((bot) => [bot.botId, `${bot.schemaRevision}:${bot.revision}`]));
        const botId = this.store.getCommandDraft(this.channelId)?.command.botId;
        const changed = botId !== undefined && this.settingsRevisions.get(botId) !== next.get(botId);
        this.settingsRevisions = next;
        if (changed) this.invalidateAutocomplete();
      })
    );
    this.store.expireInvocations();
    this.renderComposer();
    this.scheduleExpiry();
  }

  private isCurrent(): boolean {
    return !this.destroyed && getActiveChatStore() === this.store;
  }

  private localizedCommand(command: SlashCommand): SlashCommand {
    return localizeCommand(command, botLocaleFor(this.client, this.server, command.botId));
  }

  private invalidateAutocomplete(): void {
    const field = this.autocompleteField;
    this.closeParameterMenu();
    if (field) this.openAutocomplete(field);
  }

  private onContextMenu = (event: MouseEvent): void => {
    if (!this.isCurrent() || !(event.target instanceof Element) ||
        !event.target.closest('.bot-chat-identity .chat-author-avatar, .bot-chat-identity .chat-author-name')) return;
    const card = event.target.closest<HTMLElement>('[data-invocation-id]');
    const invocation = this.store.getInvocation(card?.dataset.invocationId ?? '');
    if (!invocation || invocation.channelId !== this.channelId) return;
    event.preventDefault();
    contextMenu.open(event.clientX, event.clientY, [botSettingsMenuItem(invocation.botId, this.client, this.server)]);
  };

  private canSend(): boolean {
    const channel = this.server.serverDetails?.channels.find((candidate) => candidate.id === this.channelId);
    return channel?.type === 'TEXT' && channel.botCommandsEnabled &&
      this.server.hasPermission(Permission.USE_BOT_COMMANDS) &&
      this.server.hasPermission(Permission.SEND_MESSAGES) && this.client.getStatus() === 'CONNECTED';
  }

  private voiceError(command: Pick<SlashCommand, 'botId' | 'voiceRequirement'>): string | undefined {
    const code = commandVoiceError(command, this.client, this.server);
    return code ? translateProtocolError(code) : undefined;
  }

  private cancelLocalPreparation(): void {
    this.localPreparation?.owner.abort();
    this.localPreparation = null;
    this.preparingCommand = null;
    this.commandPreparationId = null;
  }

  private localMetadataKey(command: SlashCommand): string {
    return JSON.stringify([
      command.botId, command.name, command.botPublicKey, command.localCapabilities,
      command.options, command.voiceRequirement, command.downloadsSound,
    ]);
  }

  private async prepareLocalCommand(draft: CommandDraft, signal?: AbortSignal): Promise<PreparedLocalCapability[]> {
    const capabilities = commandLocalCapabilities(draft.command);
    if (!capabilities.length) return [];
    if (!this.isCurrent() || this.store.getCommandDraft(this.channelId) !== draft || !this.canSend() ||
      this.voiceError(draft.command) || !this.store.isCommandAvailable(draft.command)) {
      throw new DOMException('Command context changed', 'AbortError');
    }
    const connectionId = this.client.getConnectionId();
    const voiceContext = commandVoiceContextKey(draft.command, this.client, this.server);
    const metadata = this.localMetadataKey(draft.command);
    if (this.localPreparation && (this.localPreparation.draft !== draft || this.localPreparation.connectionId !== connectionId ||
      this.localPreparation.voiceContext !== voiceContext || this.localPreparation.metadata !== metadata)) this.cancelLocalPreparation();
    if (!this.localPreparation) {
      this.localPreparation = { draft, connectionId, voiceContext, metadata, owner: new AbortController() };
    }
    const context = this.localPreparation;
    const controller = localExecutionFor(this.client);
    const bot = commandLocalIdentity(draft.command);
    const preparation = Promise.all(capabilities.map((capability) => controller.prepare(bot, capability, context.owner.signal)));
    const grants = await (signal ? observeWithSignal(preparation, signal) : preparation);
    if (context.owner.signal.aborted || this.localPreparation !== context || !this.isCurrent() ||
      this.client.getConnectionId() !== connectionId || this.store.getCommandDraft(this.channelId) !== draft ||
      this.localMetadataKey(draft.command) !== metadata || !this.store.isCommandAvailable(draft.command) ||
      !this.canSend() || this.voiceError(draft.command)) throw new DOMException('Command context changed', 'AbortError');
    return grants;
  }

  private previewVoiceError(controls: HTMLElement): string | undefined {
    const command = this.composer.contains(controls) ? this.store.getCommandDraft(this.channelId)?.command
      : this.store.getInvocation(controls.closest<HTMLElement>('[data-invocation-id]')?.dataset.invocationId ?? '');
    return command ? this.voiceError(command) : undefined;
  }

  private refreshVoiceEligibility(): void {
    if (!this.isCurrent()) return;
    const draft = this.store.getCommandDraft(this.channelId);
    if (draft?.command.voiceRequirement &&
        this.store.setCommandVoiceContext(this.channelId, commandVoiceContextKey(draft.command, this.client, this.server))) {
      this.closeParameterMenu();
      if (draft.pending) this.store.setCommandPending(this.channelId, draft, false, this.voiceError(draft.command) ?? t('botChat.voiceContextChanged'));
      else this.renderComposer();
    }
    const invocations = this.store.getInvocations(this.channelId);
    const liveIds = new Set(invocations.map((invocation) => invocation.invocationId));
    for (const id of this.invocationVoiceContexts.keys()) if (!liveIds.has(id)) this.invocationVoiceContexts.delete(id);
    for (const invocation of invocations) {
      if (!invocation.voiceRequirement) continue;
      const context = commandVoiceContextKey(invocation, this.client, this.server);
      if (this.invocationVoiceContexts.get(invocation.invocationId) === context) continue;
      this.invocationVoiceContexts.set(invocation.invocationId, context);
      const card = [...this.feed.querySelectorAll<HTMLElement>('[data-invocation-id]')]
        .find((element) => element.dataset.invocationId === invocation.invocationId);
      if (card) audioPreviewService.release(card);
      this.onInvocationChanged(invocation);
    }
  }

  public renderComposer(): void {
    const currentDraft = this.store.getCommandDraft(this.channelId);
    if (this.localPreparation && (!currentDraft || this.localPreparation.draft !== currentDraft || !this.isCurrent() ||
      !this.canSend() || this.localPreparation.connectionId !== this.client.getConnectionId() ||
      this.localPreparation.metadata !== this.localMetadataKey(currentDraft.command) ||
      this.localPreparation.voiceContext !== commandVoiceContextKey(currentDraft.command, this.client, this.server))) {
      this.cancelLocalPreparation();
    }
    if (currentDraft?.command.voiceRequirement) {
      this.store.setCommandVoiceContext(this.channelId, commandVoiceContextKey(currentDraft.command, this.client, this.server));
      if (this.voiceDraft !== currentDraft || this.voiceContextRevision !== currentDraft.voiceContextRevision) {
        this.voiceEpoch++;
        this.voiceDraft = currentDraft;
        this.voiceContextRevision = currentDraft.voiceContextRevision ?? 0;
        this.closeParameterMenu();
      }
    }
    if (this.composing) { this.deferredRender = true; return; }
    this.deferredRender = false;
    const active = document.activeElement;
    const focused = active instanceof HTMLElement && this.composer.contains(active) ? active : null;
    const focusId = focused?.id;
    const focusAction = focused?.dataset.botAction;
    const removeParameter = focused?.dataset.removeParameter;
    const focusedMenu = !!focused?.closest('#bot-parameter-options');
    const menu = this.parameterMenu ? { ...this.parameterMenu } : null;
    const activeChoice = menu ? this.menuChoices[menu.activeIndex]?.value : undefined;
    const selection = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement
      ? {
        start: focused.selectionStart, end: focused.selectionEnd, direction: focused.selectionDirection,
        scrollTop: focused.scrollTop, scrollLeft: focused.scrollLeft,
      } : undefined;
    this.closeParameterMenu();
    const draft = this.store.getCommandDraft(this.channelId);
    this.composer.hidden = !draft;
    if (!draft) {
      this.composer.innerHTML = '';
      this.onComposerChanged();
      return;
    }
    const available = this.store.isCommandAvailable(draft.command);
    this.composer.innerHTML = renderCompactCommand(
      draft, this.channelId,
      this.server.getHumanMembersInDisplayOrder(), this.canSend(), available, this.voiceError(draft.command),
      botLocaleFor(this.client, this.server, draft.command.botId),
      this.preparingCommand === draft,
    );
    this.onComposerChanged();
    if (menu?.kind === 'autocomplete') this.openAutocomplete(menu.fieldName);
    else if (menu) this.openParameterMenu(menu, activeChoice);
    if (focused) {
      const next = focusedMenu
        ? this.composer.querySelector<HTMLElement>('[data-parameter-option][aria-selected="true"]')
        : [...this.composer.querySelectorAll<HTMLElement>('[id], [data-bot-action], [data-remove-parameter]')].find((element) =>
          (focusId && element.id === focusId) || (focusAction && element.dataset.botAction === focusAction) ||
          (removeParameter && element.dataset.removeParameter === removeParameter));
      this.suppressChoiceFocus = true;
      next?.focus({ preventScroll: true });
      this.suppressChoiceFocus = false;
      if (selection && selection.start !== null && selection.end !== null &&
          (next instanceof HTMLInputElement || next instanceof HTMLTextAreaElement) && next.type !== 'checkbox') {
        next.setSelectionRange(selection.start, selection.end, selection.direction ?? 'none');
        next.scrollTop = selection.scrollTop;
        next.scrollLeft = selection.scrollLeft;
      }
    }
    this.updateParameterHint();
  }

  public async activateCommand(userGesture = false, autoInvoke = true): Promise<void> {
    const draft = this.store.getCommandDraft(this.channelId);
    if (!draft || draft.pending || this.preparingCommand === draft || !this.isCurrent()) return;
    const command = draft.command;
    const connectionId = this.client.getConnectionId();
    const voiceEpoch = this.voiceEpoch;
    const metadata = this.localMetadataKey(command);
    const preparationId = uuidv4();
    const current = () => this.isCurrent() && this.store.getCommandDraft(this.channelId) === draft &&
      this.client.getConnectionId() === connectionId && this.voiceEpoch === voiceEpoch &&
      this.localMetadataKey(draft.command) === metadata;
    try {
      if (commandLocalCapabilities(command).length) {
        this.preparingCommand = draft;
        this.commandPreparationId = preparationId;
        this.renderComposer();
        await this.prepareLocalCommand(draft);
        if (this.preparingCommand !== draft || this.commandPreparationId !== preparationId || !current()) return;
      }
    } catch (error) {
      if ((this.commandPreparationId === preparationId || this.commandPreparationId === null) && current()) {
        this.store.setCommandPending(this.channelId, draft, false, t(`localExecution.failure.${localFailure(error)}`));
      }
      return;
    } finally {
      if (this.commandPreparationId === preparationId) {
        this.preparingCommand = null;
        this.commandPreparationId = null;
        if (this.isCurrent() && this.store.getCommandDraft(this.channelId) === draft) this.renderComposer();
      }
    }
    if (!current()) return;
    if (!command.options?.length && autoInvoke && !draft.error) await this.invoke(userGesture);
    else this.focusComposer();
  }

  public focusComposer(): void {
    const first = this.composer.querySelector<HTMLElement>('[data-bot-input]:not(:disabled)');
    const name = first?.closest<HTMLElement>('[data-field-name]')?.dataset.fieldName;
    if (name) this.focusParameter(name);
    else this.composer.querySelector<HTMLElement>('button[type="submit"]:not(:disabled)')?.focus();
  }

  private refreshPermissions(): void {
    if (!this.isCurrent()) return;
    this.refreshVoiceEligibility();
    this.renderComposer();
    for (const invocation of this.store.getInvocations(this.channelId)) this.onInvocationChanged(invocation);
    audioPreviewService.prune(this.feed);
  }

  private refreshMembers(): void {
    if (this.isCurrent() && this.store.getCommandDraft(this.channelId)?.command.options?.some((field) => field.type === 'user')) {
      this.renderComposer();
    }
  }

  private fieldBinding(target: HTMLElement): FieldBinding | undefined {
    if (this.composer.contains(target)) {
      const draft = this.store.getCommandDraft(this.channelId);
      if (!draft) return;
      return {
        fields: visibleCommandFields(this.localizedCommand(draft.command), draft.visibleOptionalNames),
        values: draft.values,
        context: { prefix: `command-${this.channelId}`, disabled: draft.pending || this.preparingCommand === draft || !this.canSend(), members: this.server.getHumanMembersInDisplayOrder() },
        save: (values) => this.store.setCommandValues(this.channelId, values),
      };
    }
    const invocation = this.store.getInvocation(target.closest<HTMLElement>('[data-invocation-id]')?.dataset.invocationId ?? '');
    const interactionId = target.closest<HTMLElement>('[data-interaction-id]')?.dataset.interactionId;
    const form = invocation?.forms.find((state) => state.interactionId === interactionId);
    if (!invocation || invocation.channelId !== this.channelId || !form) return;
    return {
      fields: form.form.fields,
      values: form.values,
      context: {
        prefix: `${invocation.invocationId}-${form.interactionId}`,
        disabled: !this.canSend() || !!this.voiceError(invocation) || invocation.status !== 'active' || invocation.cancelPending || form.status !== 'editing',
        volumeScope: commandPreviewVolumeScope(this.server.serverDetails?.id, invocation.botId, invocation.commandName),
      },
      save: (values) => this.store.setFormValues(invocation.invocationId, form.interactionId, values),
    };
  }

  private onFocus = (event: FocusEvent): void => {
    if (!(event.target instanceof HTMLElement) || !this.isCurrent()) return;
    if (!this.composer.contains(event.target)) {
      this.closeParameterMenu();
      this.updateParameterHint();
      return;
    }
    const name = event.target.closest<HTMLElement>('[data-field-name]')?.dataset.fieldName;
    if (name) {
      this.focusedParameter = name;
      if (event.target.dataset.botChoice && !this.suppressChoiceFocus) {
        this.openParameterMenu({ kind: 'choices', fieldName: name, activeIndex: 0 });
      } else if (event.target.dataset.botAutocomplete && !this.suppressChoiceFocus) {
        this.openAutocomplete(name);
      } else if (!event.target.dataset.botChoice && !event.target.dataset.botAutocomplete) this.closeParameterMenu();
    } else if (!event.target.closest('#bot-parameter-options') && event.target.dataset.botAction !== 'optional-parameters') {
      this.closeParameterMenu();
    }
    this.updateParameterHint();
  };

  private onBlur = (event: FocusEvent): void => {
    if (!(event.target instanceof HTMLElement) || !this.composer.contains(event.target) || !this.isCurrent()) return;
    const field = event.target.closest<HTMLElement>('[data-field-name]');
    if (field?.dataset.fieldName && !(event.relatedTarget instanceof Node && field.contains(event.relatedTarget))) {
      this.store.touchCommandField(this.channelId, field.dataset.fieldName);
      this.updateParameterValidation();
    }
    queueMicrotask(() => { if (!this.destroyed && this.isCurrent()) this.updateParameterHint(); });
  };

  private updateParameterHint(): void {
    const draft = this.store.getCommandDraft(this.channelId);
    if (!draft) return;
    const command = this.localizedCommand(draft.command);
    const fields = visibleCommandFields(command, draft.visibleOptionalNames);
    const field = fields.find((entry) => entry.name === this.focusedParameter) ?? fields[0];
    this.focusedParameter = field?.name ?? null;
    const label = this.composer.querySelector<HTMLElement>('[data-parameter-hint-name]');
    const description = this.composer.querySelector<HTMLElement>('[data-parameter-hint-description]');
    if (label) label.textContent = field ? commandParameterLabel(command, field.name) :
      `/${getCommandPresentation(command, botLocaleFor(this.client, this.server, command.botId)).displayName}`;
    if (description) {
      description.textContent = field ? commandParameterHint(field) : command.description;
      description.title = description.textContent;
    }
    const active = document.activeElement;
    const activeName = active instanceof HTMLElement && this.composer.contains(active)
      ? active.closest<HTMLElement>('[data-field-name]')?.dataset.fieldName ??
        (active.closest('[data-parameter-option]') && this.parameterMenu?.kind !== 'optional' ? this.parameterMenu?.fieldName : undefined)
      : undefined;
    this.composer.querySelectorAll<HTMLElement>('[data-field-name]').forEach((element) => {
      element.classList.toggle('focused', element.dataset.fieldName === activeName);
    });
  }

  private updateParameterValidation(): void {
    const draft = this.store.getCommandDraft(this.channelId);
    if (!draft) return;
    const members = this.server.getHumanMembersInDisplayOrder();
    for (const field of visibleCommandFields(this.localizedCommand(draft.command), draft.visibleOptionalNames)) {
      const element = [...this.composer.querySelectorAll<HTMLElement>('[data-field-name]')]
        .find((entry) => entry.dataset.fieldName === field.name);
      if (!element) continue;
      const error = commandParameterError(draft, field, members);
      element.classList.toggle('invalid', !!error);
      if (error) element.setAttribute('title', error);
      else element.removeAttribute('title');
      const input = element.querySelector<HTMLElement>('[data-bot-input]');
      if (error) input?.setAttribute('aria-invalid', 'true');
      else input?.removeAttribute('aria-invalid');
    }
  }

  private updateCommandSubmitState(): void {
    const draft = this.store.getCommandDraft(this.channelId);
    const button = this.composer.querySelector<HTMLButtonElement>('.bot-command-run');
    if (!draft || !button) return;
    const canExecute = commandValuesFromInputs(
      draft.command,
      visibleCommandValues(draft.command, draft.values, draft.visibleOptionalNames),
      this.server.getHumanMembersInDisplayOrder(),
      draft.autocomplete,
      draft.visibleOptionalNames
    ).success;
    const voiceError = this.voiceError(draft.command);
    button.disabled = draft.pending || this.preparingCommand === draft || !this.canSend() || !this.store.isCommandAvailable(draft.command) || !canExecute || !!voiceError;
    const notice = this.composer.querySelector<HTMLElement>('.bot-command-voice-error');
    if (notice) { notice.textContent = voiceError ?? ''; notice.hidden = !voiceError; }
  }

  private updateArgumentMeasure(input: HTMLInputElement | HTMLTextAreaElement): void {
    const measure = input.closest('.bot-argument-size')?.querySelector<HTMLElement>('[data-argument-measure-value]');
    if (measure) measure.textContent = input.value;
  }

  private parameterChoices(): ParameterChoice[] {
    const draft = this.store.getCommandDraft(this.channelId);
    const menu = this.parameterMenu;
    if (!draft || !menu) return [];
    const command = this.localizedCommand(draft.command);
    if (menu.kind === 'optional') return (command.options ?? [])
      .filter((option) => !option.required && !draft.visibleOptionalNames.includes(option.name))
      .map((option) => ({ value: option.name, label: option.label ?? option.name, description: option.description }));
    const field = commandInputFields(command).find((entry) => entry.name === menu.fieldName);
    return field ? commandParameterChoices(field, this.server.getHumanMembersInDisplayOrder()) : [];
  }

  private parameterMenuTrigger(): HTMLElement | null {
    const menu = this.parameterMenu;
    if (menu?.kind === 'optional') return this.composer.querySelector('[data-bot-action="optional-parameters"]');
    if (menu?.kind === 'choices') return [...this.composer.querySelectorAll<HTMLElement>('[data-bot-choice]')]
      .find((element) => element.dataset.botChoice === menu.fieldName) ?? null;
    if (menu?.kind === 'autocomplete') return [...this.composer.querySelectorAll<HTMLElement>('[data-bot-autocomplete]')]
      .find((element) => element.dataset.botAutocomplete === menu.fieldName) ?? null;
    return null;
  }

  private openParameterMenu(menu: ParameterMenu, activeValue?: string): void {
    const draft = this.store.getCommandDraft(this.channelId);
    if (!draft || draft.pending || !this.canSend()) return;
    this.closeParameterMenu();
    this.parameterMenu = menu;
    const trigger = this.parameterMenuTrigger();
    const choices = this.parameterChoices();
    if (!trigger || choices.length === 0) {
      this.closeParameterMenu();
      return;
    }
    this.menuChoices = choices;
    if (activeValue !== undefined) {
      menu.activeIndex = Math.max(0, choices.findIndex((choice) => choice.value === activeValue));
    } else if (menu.kind === 'choices') {
      menu.activeIndex = Math.max(0, choices.findIndex((choice) => choice.value === draft.values[menu.fieldName]));
    }
    const element = this.composer.querySelector<HTMLElement>('#bot-parameter-options');
    if (!element) return;
    element.hidden = false;
    element.innerHTML = renderParameterChoices(choices, menu.activeIndex,
      menu.kind === 'optional' ? t('botChat.addParameters') : t('botChat.parameterChoices', {
        name: commandParameterLabel(this.localizedCommand(draft.command), menu.fieldName),
      }),
      this.parameterChoiceScope(menu.kind === 'optional' ? 'optional' : menu.fieldName),
      commandPreviewVolumeScope(this.server.serverDetails?.id, draft.command.botId, draft.command.name));
    element.style.left = '';
    trigger?.setAttribute('aria-expanded', 'true');
    trigger?.setAttribute('aria-controls', 'bot-parameter-options');
    element.querySelectorAll<HTMLElement>('[data-parameter-option]').forEach((option) => {
      option.addEventListener('mouseenter', () => this.setParameterMenuActive(Number(option.dataset.parameterOption), false));
    });
    this.setParameterMenuActive(menu.activeIndex);
  }

  private setParameterMenuActive(index: number, scroll = true): void {
    if (!this.parameterMenu || index < 0 || index >= this.menuChoices.length) return;
    this.parameterMenu.activeIndex = index;
    this.composer.querySelectorAll<HTMLElement>('[data-parameter-option]').forEach((option) => {
      const active = Number(option.dataset.parameterOption) === index;
      option.classList.toggle('active', active);
      option.setAttribute('aria-selected', String(active));
      option.tabIndex = active ? 0 : -1;
      if (active && scroll) option.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    this.parameterMenuTrigger()?.setAttribute('aria-activedescendant', `bot-parameter-option-${index}`);
  }

  private parameterChoiceScope(fieldName: string): string {
    const command = this.store.getCommandDraft(this.channelId)?.command;
    return JSON.stringify([this.server.serverDetails?.id, command?.botId, command?.name, fieldName]);
  }

  private closeParameterMenu(restoreFocus = false): void {
    const trigger = this.parameterMenuTrigger();
    this.autocomplete.close();
    this.autocompleteField = null;
    this.autocompleteState = null;
    this.autocompletePaged = false;
    this.parameterMenu = null;
    this.menuChoices = [];
    audioPreviewService.release(this.composer);
    const element = this.composer.querySelector<HTMLElement>('#bot-parameter-options');
    if (element) { element.hidden = true; element.innerHTML = ''; }
    trigger?.setAttribute('aria-expanded', 'false');
    trigger?.removeAttribute('aria-controls');
    trigger?.removeAttribute('aria-activedescendant');
    if (restoreFocus) {
      this.suppressChoiceFocus = true;
      trigger?.focus();
      this.suppressChoiceFocus = false;
    }
  }

  private focusParameter(name: string, offerChoices = true): void {
    const field = [...this.composer.querySelectorAll<HTMLElement>('[data-field-name]')]
      .find((element) => element.dataset.fieldName === name);
    const input = field?.querySelector<HTMLElement>('[data-bot-input]');
    this.focusedParameter = name;
    this.suppressChoiceFocus = true;
    input?.focus();
    this.suppressChoiceFocus = false;
    this.updateParameterHint();
    if (offerChoices && input?.dataset.botChoice) {
      this.openParameterMenu({ kind: 'choices', fieldName: name, activeIndex: 0 });
    } else if (offerChoices && input?.dataset.botAutocomplete) this.openAutocomplete(name);
  }

  private selectParameterMenuOption(index: number, userGesture = false): void {
    const menu = this.parameterMenu;
    const choice = this.menuChoices[index];
    const draft = this.store.getCommandDraft(this.channelId);
    if (!menu || !choice || !draft || draft.pending) return;
    if (menu.kind === 'autocomplete' && this.voiceError(draft.command)) {
      this.closeParameterMenu();
      this.refreshVoiceEligibility();
      return;
    }
    this.closeParameterMenu();
    if (menu.kind === 'optional') {
      if (this.store.setCommandOptionVisible(this.channelId, choice.value, true)) this.focusParameter(choice.value);
    } else {
      if (menu.kind === 'autocomplete') this.store.selectCommandChoice(this.channelId, menu.fieldName, choice);
      else this.store.setCommandValues(this.channelId, { ...draft.values, [menu.fieldName]: choice.value });
      this.renderComposer();
      this.focusParameter(menu.fieldName, false);
      const hasOptionalParameters = (draft.command.options ?? []).some((option) => !option.required);
      if (menu.kind === 'autocomplete' && !hasOptionalParameters && commandValuesFromInputs(draft.command,
        visibleCommandValues(draft.command, draft.values, draft.visibleOptionalNames),
        this.server.getHumanMembersInDisplayOrder(), draft.autocomplete, draft.visibleOptionalNames).success) void this.invoke(userGesture);
    }
  }

  private handleParameterArrowRight(event: KeyboardEvent): boolean {
    if (event.key !== 'ArrowRight' || this.parameterMenu || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey ||
        !(event.target instanceof HTMLElement) || !this.composer.contains(event.target)) return false;
    const fieldRoot = event.target.closest<HTMLElement>('[data-field-name]');
    if (!fieldRoot) return false;
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
      if (event.target instanceof HTMLInputElement && event.target.type === 'range') return false;
      if (event.target.type !== 'checkbox' && (event.target.selectionStart === null || event.target.selectionEnd === null ||
          event.target.selectionStart !== event.target.selectionEnd || event.target.selectionEnd !== event.target.value.length)) return false;
    } else if (!(event.target instanceof HTMLButtonElement)) return false;
    const draft = this.store.getCommandDraft(this.channelId);
    if (!draft || draft.pending) return false;
    const fields = visibleCommandFields(draft.command, draft.visibleOptionalNames);
    const index = fields.findIndex((field) => field.name === fieldRoot.dataset.fieldName);
    if (index < 0) return false;
    const next = fields[index + 1];
    if (next) {
      event.preventDefault();
      this.focusParameter(next.name);
      return true;
    }
    const optionalCount = (draft.command.options ?? []).filter((option) =>
      !option.required && !draft.visibleOptionalNames.includes(option.name)).length;
    if (optionalCount > 0) {
      const trigger = this.composer.querySelector<HTMLElement>('[data-bot-action="optional-parameters"]');
      event.preventDefault();
      this.suppressChoiceFocus = true;
      trigger?.focus();
      this.suppressChoiceFocus = false;
      this.openParameterMenu({ kind: 'optional', activeIndex: 0 });
      return true;
    }
    return false;
  }

  private handleParameterMenuKey(event: KeyboardEvent): boolean {
    if (!(event.target instanceof HTMLElement)) return false;
    if (audioPreviewService.ownsEventTarget(event.target)) return false;
    if (event.target.closest('[data-bot-action="autocomplete-load-more"]') && event.key !== 'Escape') return false;
    const menu = this.parameterMenu;
    if (menu) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const choices = this.menuChoices;
        if (event.key === 'ArrowDown' && menu.kind === 'autocomplete' && this.autocompleteState?.hasMore &&
            menu.activeIndex >= choices.length - 1) {
          this.autocomplete.loadMore();
          return true;
        }
        if (choices.length) this.setParameterMenuActive((menu.activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length);
        return true;
      }
      if (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey)) {
        event.preventDefault();
        if (this.menuChoices[menu.activeIndex]) this.selectParameterMenuOption(menu.activeIndex, event.isTrusted);
        else if (event.key === 'Enter' && menu.kind === 'autocomplete') {
          const submit = this.composer.querySelector<HTMLButtonElement>('.bot-command-run');
          if (submit && !submit.disabled) {
            this.closeParameterMenu();
            void this.invoke(event.isTrusted);
          }
        }
        return true;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.closeParameterMenu(true);
        return true;
      }
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (event.target.dataset.botAutocomplete) {
        event.preventDefault();
        this.openAutocomplete(event.target.dataset.botAutocomplete);
        return true;
      }
      const fieldName = event.target.dataset.botChoice;
      if (fieldName || event.target.dataset.botAction === 'optional-parameters') {
        event.preventDefault();
        this.openParameterMenu(fieldName
          ? { kind: 'choices', fieldName, activeIndex: 0 } : { kind: 'optional', activeIndex: 0 });
        return true;
      }
    }
    return false;
  }

  private openAutocomplete(name: string): void {
    const draft = this.store.getCommandDraft(this.channelId);
    if (!draft || draft.pending || this.preparingCommand === draft || !this.canSend() || this.voiceError(draft.command) || !this.store.isCommandAvailable(draft.command) ||
        !draft.command.options?.some((option) => option.name === name && option.autocomplete)) return;
    if (this.autocompleteField !== name) {
      this.closeParameterMenu();
      this.autocompleteField = name;
    }
    this.autocomplete.setQuery(draft.autocomplete[name]?.query ?? '');
    if (!draft.autocomplete[name]?.query) this.renderAutocomplete({ status: 'idle', query: '', choices: [] });
  }

  private async prepareAutocompleteQuery(
    query: string, signal: AbortSignal, page: number, cursor?: string,
  ): Promise<() => Promise<CommandAutocompleteResultPayload>> {
    const draft = this.store.getCommandDraft(this.channelId);
    const optionName = this.autocompleteField;
    if (signal.aborted || !draft || !optionName || draft.pending || !this.isCurrent() || !this.canSend() || this.voiceError(draft.command)) {
      throw new DOMException('Autocomplete closed', 'AbortError');
    }
    const connectionId = this.client.getConnectionId();
    let grant: PreparedLocalCapability | undefined;
    const payload: CommandAutocompletePayload = {
      botId: draft.command.botId, commandName: draft.command.name, channelId: this.channelId, optionName, query,
      ...(page > 0 ? { page } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
      options: autocompleteCommandOptions(draft.command, optionName,
        visibleCommandValues(draft.command, draft.values, draft.visibleOptionalNames),
        this.server.getHumanMembersInDisplayOrder(), draft.autocomplete),
      locale: botLocaleFor(this.client, this.server, draft.command.botId),
      ...botUserSettingsPayload(this.client, this.server, draft.command.botId),
    };
    if (commandLocalCapabilities(draft.command).length) {
      [grant] = await this.prepareLocalCommand(draft, signal);
      if (signal.aborted || draft.pending || this.autocompleteField !== optionName ||
        this.client.getConnectionId() !== connectionId || draft.autocomplete[optionName]?.query !== query) {
        throw new DOMException('Autocomplete changed during preparation', 'AbortError');
      }
    }
    return async () => {
      if (signal.aborted || !this.isCurrent() || !this.canSend() || this.voiceError(draft.command) ||
        draft.pending || this.store.getCommandDraft(this.channelId) !== draft || !this.store.isCommandAvailable(draft.command) ||
        this.autocompleteField !== optionName || this.client.getConnectionId() !== connectionId ||
        draft.autocomplete[optionName]?.query !== query) {
        throw new DOMException('Autocomplete changed before dispatch', 'AbortError');
      }
      const requestId = uuidv4();
      const local = grant ? localExecutionFor(this.client) : undefined;
      if (local && grant) {
        payload.localPreparation = local.registerRequest('autocomplete', requestId, grant, {
          channelId: this.channelId, commandName: draft.command.name, signal,
        });
      }
      const response = this.client.sendRequest<CommandAutocompleteResultPayload>(
        MessageType.COMMAND_AUTOCOMPLETE, payload, requestId, LIMITS.BOT_AUTOCOMPLETE_TIMEOUT_MS
      );
      const cancel = () => {
        signal.removeEventListener('abort', cancel);
        if (!this.autocompleteRequests.delete(requestId)) return;
        local?.releaseRequest(requestId);
        this.client.cancelRequest(requestId);
        if (this.client.getStatus() === 'CONNECTED' && this.client.getConnectionId() === connectionId) {
          this.client.send(MessageType.COMMAND_AUTOCOMPLETE_CANCEL, { requestId });
        }
      };
      const active: AutocompleteRequest = { requestId, connectionId, payload, resources: new Set(), cancel };
      this.autocompleteRequests.set(requestId, active);
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      try {
        // The signal also owns the returned choices, until a new query or close.
        const result = await response;
        if (signal.aborted || this.voiceError(draft.command)) throw new DOMException('Voice context changed', 'AbortError');
        const parsed = commandAutocompleteResultSchema.safeParse(result);
        if (parsed.success && parsed.data.status === 'ok') {
          for (const choice of parsed.data.choices) {
            if (choice.audio && 'resourceId' in choice.audio) active.resources.add(choice.audio.resourceId);
          }
        }
        if (!active.resources.size) cancel();
        return result;
      } catch (error) {
        signal.removeEventListener('abort', cancel);
        if (!signal.aborted) cancel();
        throw error;
      }
    };
  }

  private expireAutocompleteRequest(request: AutocompleteRequest): void {
    this.composer.querySelectorAll<HTMLElement>('[data-audio-resource-id]').forEach((controls) => {
      if (request.resources.has(controls.dataset.audioResourceId ?? '')) audioPreviewService.release(controls);
    });
    request.cancel();
  }

  private async previewAutocomplete(resourceId: string, requestId: string, signal: AbortSignal): Promise<unknown> {
    const active = [...this.autocompleteRequests.values()].find((request) => request.resources.has(resourceId));
    const draft = this.store.getCommandDraft(this.channelId);
    if (signal.aborted || !active || !draft || !this.isCurrent() || !this.canSend() || this.voiceError(draft.command) || draft.pending ||
        !this.store.isCommandAvailable(draft.command) || this.client.getConnectionId() !== active.connectionId ||
        this.parameterMenu?.kind !== 'autocomplete' || this.autocompleteField !== active.payload.optionName ||
        draft.command.botId !== active.payload.botId || draft.command.name !== active.payload.commandName ||
        draft.autocomplete[active.payload.optionName]?.query !== active.payload.query ||
        !this.menuChoices.some((choice) => choice.audio && 'resourceId' in choice.audio && choice.audio.resourceId === resourceId)) {
      return { status: 'failed', reason: 'expired' };
    }
    const payload: CommandAudioPreviewPayload = {
      botId: active.payload.botId, commandName: active.payload.commandName, channelId: this.channelId,
      optionName: active.payload.optionName, autocompleteRequestId: active.requestId, resourceId,
    };
    const [grant] = await this.prepareLocalCommand(draft, signal);
    if (signal.aborted || this.autocompleteRequests.get(active.requestId) !== active || this.client.getConnectionId() !== active.connectionId ||
      this.store.getCommandDraft(this.channelId) !== draft || !this.isCurrent() || this.voiceError(draft.command)) {
      return { status: 'failed', reason: 'expired' };
    }
    const local = grant ? localExecutionFor(this.client) : undefined;
    if (local && grant) payload.localPreparation = local.registerRequest('audio-preview', requestId, grant, {
      channelId: this.channelId, commandName: draft.command.name, signal,
    });
    const cancel = () => {
      local?.releaseRequest(requestId);
      this.client.cancelRequest(requestId);
      if (this.client.getStatus() === 'CONNECTED' && this.client.getConnectionId() === active.connectionId) {
        this.client.send(MessageType.COMMAND_AUDIO_PREVIEW_CANCEL, { requestId });
      }
    };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    try {
      return await this.client.sendRequest<unknown>(
        MessageType.COMMAND_AUDIO_PREVIEW, payload, requestId, LIMITS.BOT_AUDIO_PREVIEW_TIMEOUT_MS + 1000
      );
    } catch (error) {
      if (!signal.aborted) cancel();
      throw error;
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }

  private renderAutocomplete(state: AutocompleteState): void {
    const fieldName = this.autocompleteField;
    const draft = this.store.getCommandDraft(this.channelId);
    if (!fieldName || !draft || !this.isCurrent() || this.composing || draft.pending || this.voiceError(draft.command) ||
        (draft.autocomplete[fieldName]?.query ?? '') !== state.query) return;
    const previousCount = this.menuChoices.length;
    const continuing = this.autocompleteState?.query === state.query &&
      state.choices.length >= previousCount && this.menuChoices.every((choice, index) => choice === state.choices[index]) &&
      !!this.composer.querySelector('#bot-parameter-options .bot-choice-list');
    const activeIndex = continuing && previousCount > 0 && this.parameterMenu
      ? this.parameterMenu.activeIndex : state.choices.length ? 0 : -1;
    if (this.autocompleteState?.query !== state.query) this.autocompletePaged = false;
    this.autocompleteState = state;
    this.autocompletePaged ||= state.hasMore === true;
    this.parameterMenu = { kind: 'autocomplete', fieldName, activeIndex };
    this.menuChoices = state.choices;
    const trigger = this.parameterMenuTrigger();
    const menu = this.composer.querySelector<HTMLElement>('#bot-parameter-options');
    if (!trigger || !menu) return;
    if (!continuing) audioPreviewService.release(this.composer);
    const keys = {
      idle: 'botChat.autocompleteHint', loading: 'botChat.autocompleteLoading',
      preparing: 'localExecution.preparing',
      empty: 'botChat.autocompleteEmpty', failed: 'botChat.autocompleteError', ready: 'botChat.parameterChoices',
    } as const;
    const busy = state.status === 'loading' || state.status === 'preparing';
    const message = state.status === 'failed' && state.error ? state.error : t(keys[state.status]);
    menu.hidden = false;
    const label = t('botChat.parameterChoices', { name: commandParameterLabel(this.localizedCommand(draft.command), fieldName) });
    const volumeScope = commandPreviewVolumeScope(this.server.serverDetails?.id, draft.command.botId, draft.command.name);
    if (continuing) {
      const list = menu.querySelector<HTMLElement>('.bot-choice-list');
      if (list && state.choices.length > previousCount) {
        const scrollTop = list.scrollTop;
        list.insertAdjacentHTML('beforeend', renderParameterChoiceItems(
          state.choices.slice(previousCount), activeIndex, label, this.parameterChoiceScope(fieldName), volumeScope, previousCount));
        list.scrollTop = scrollTop;
      }
      if (choicesHaveAudio(state.choices) && !menu.querySelector('[data-audio-preview-volume-control]')) {
        menu.querySelector('.bot-choice-panel-header')?.insertAdjacentHTML('beforeend', renderAudioPreviewVolume(volumeScope));
      }
    } else {
      // Empty nonterminal pages still need a stable list and continuation control.
      menu.innerHTML = state.choices.length || this.autocompletePaged
        ? renderParameterChoices(state.choices, activeIndex, label, this.parameterChoiceScope(fieldName), volumeScope)
        : `<p class="bot-autocomplete-status" role="status" aria-live="polite">${busy
          ? renderLoadingIndicator(message) : escapeHtml(message)}</p>`;
    }
    this.renderAutocompletePagination(menu, state);
    menu.setAttribute('aria-busy', String(busy || !!state.loadingMore));
    menu.style.left = '';
    trigger.setAttribute('aria-expanded', 'true');
    trigger.setAttribute('aria-controls', 'bot-parameter-options');
    if (!continuing) trigger.removeAttribute('aria-activedescendant');
    [...menu.querySelectorAll<HTMLElement>('[data-parameter-option]')].slice(continuing ? previousCount : 0).forEach((option) => {
      // Appending rows can fire mouseenter beneath a stationary pointer.
      option.addEventListener('mousemove', (event) => {
        if (event.movementX || event.movementY) this.setParameterMenuActive(Number(option.dataset.parameterOption), false);
      });
    });
    if (state.choices.length && (!continuing || previousCount === 0)) this.setParameterMenuActive(activeIndex);
  }

  private renderAutocompletePagination(menu: HTMLElement, state: AutocompleteState): void {
    let footer = menu.querySelector<HTMLElement>('[data-autocomplete-pagination]');
    if (!this.autocompletePaged) { footer?.remove(); return; }
    if (!footer) {
      footer = document.createElement('div');
      footer.className = 'bot-autocomplete-pagination';
      footer.dataset.autocompletePagination = '';
      const status = document.createElement('span');
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-secondary btn-sm';
      button.dataset.botAction = 'autocomplete-load-more';
      footer.append(status, button);
      menu.append(footer);
    }
    const status = footer.querySelector('span');
    const button = footer.querySelector('button');
    if (status) {
      const text = state.loadMoreFailed ? state.error ?? t('botChat.autocompleteMoreError')
        : t(state.loadingMore ? 'botChat.autocompleteLoadingMore'
          : state.hasMore ? 'botChat.autocompleteMoreHint' : 'botChat.autocompleteEnd');
      status.innerHTML = state.loadingMore ? renderLoadingIndicator(text) : escapeHtml(text);
    }
    if (button) {
      if (!state.hasMore && document.activeElement === button) this.parameterMenuTrigger()?.focus();
      button.hidden = !state.hasMore;
      button.setAttribute('aria-disabled', String(!!state.loadingMore));
      button.textContent = t(state.loadMoreFailed ? 'botChat.autocompleteRetry' : 'botChat.autocompleteLoadMore');
    }
  }

  private onAutocompleteScroll = (event: Event): void => {
    const state = this.autocompleteState;
    const list = event.target;
    if (!this.isCurrent() || this.parameterMenu?.kind !== 'autocomplete' || !state?.hasMore ||
        state.loadingMore || state.loadMoreFailed || !(list instanceof HTMLElement) ||
        !list.matches('#bot-parameter-options .bot-choice-list') || list.scrollTop <= 0) return;
    if (list.scrollHeight - list.scrollTop - list.clientHeight <= 64) this.autocomplete.loadMore();
  };

  private onCompositionStart = (event: CompositionEvent): void => {
    if (!(event.target instanceof HTMLElement) || !this.composer.contains(event.target)) return;
    this.composing = true;
    this.closeParameterMenu();
  };

  private onCompositionEnd = (event: CompositionEvent): void => {
    if (!(event.target instanceof HTMLElement) || !this.composer.contains(event.target)) return;
    this.composing = false;
    const name = event.target.dataset.botAutocomplete;
    if (name && event.target instanceof HTMLInputElement) this.store.setCommandQuery(this.channelId, name, event.target.value);
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) this.updateArgumentMeasure(event.target);
    this.updateParameterValidation();
    this.updateCommandSubmitState();
    if (this.deferredRender) this.renderComposer();
    if (name) this.openAutocomplete(name);
  };

  private onInput = (event: Event): void => {
    if (!(event.target instanceof HTMLElement) || !this.isCurrent()) return;
    if (audioPreviewService.ownsEventTarget(event.target)) return;
    const binding = this.fieldBinding(event.target);
    if (!binding || binding.context.disabled) return;
    if (event.target instanceof HTMLInputElement && event.target.dataset.botAutocomplete) {
      // Edits arrive via input; replacing this field can emit a stale change on blur.
      if (event.type === 'change') return;
      const name = event.target.dataset.botAutocomplete;
      if (event instanceof InputEvent && event.isComposing) {
        this.composing = true;
        this.closeParameterMenu();
      }
      this.store.setCommandQuery(this.channelId, name, event.target.value);
      this.updateArgumentMeasure(event.target);
      this.updateParameterValidation();
      const error = event.target.closest('form')?.querySelector<HTMLElement>('.bot-error');
      if (error) { error.textContent = ''; error.hidden = true; }
      this.updateCommandSubmitState();
      if (!this.composing) this.openAutocomplete(name);
      return;
    }
    const values = readBotFieldChange(event.target, binding.fields, binding.values);
    if (!values) return;
    binding.save(values);
    if (this.composer.contains(event.target)) {
      this.updateCommandSubmitState();
      this.updateParameterValidation();
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) this.updateArgumentMeasure(event.target);
    } else event.target.removeAttribute('aria-invalid');
    const error = event.target.closest('form')?.querySelector<HTMLElement>('.bot-error');
    if (error) { error.textContent = ''; error.hidden = true; }
  };

  private onClick = (event: Event): void => {
    if (!(event.target instanceof HTMLElement) || !this.isCurrent()) return;
    if (event.defaultPrevented || audioPreviewService.ownsEventTarget(event.target)) return;
    const parameterOption = event.target.closest<HTMLElement>('[data-parameter-option]');
    if (parameterOption && this.composer.contains(parameterOption)) {
      event.preventDefault();
      this.selectParameterMenuOption(Number(parameterOption.dataset.parameterOption), event.isTrusted);
      return;
    }
    const customSelect = event.target.closest<HTMLElement>('[data-bot-select-value]');
    if (customSelect && !(customSelect instanceof HTMLButtonElement)) {
      event.preventDefault();
      this.chooseBotSelectValue(customSelect);
      return;
    }
    const button = event.target.closest<HTMLButtonElement>('button');
    if (!button || button.disabled) return;
    if (button.type === 'submit' && this.composer.contains(button)) {
      this.submitGesture = event.isTrusted;
      queueMicrotask(() => { this.submitGesture = false; });
    }
    if (button.dataset.botChoice) {
      this.openParameterMenu({ kind: 'choices', fieldName: button.dataset.botChoice, activeIndex: 0 });
    } else if (button.dataset.removeParameter) {
      this.store.setCommandOptionVisible(this.channelId, button.dataset.removeParameter, false);
      this.focusComposer();
    } else if (button.dataset.botAction === 'optional-parameters') {
      if (this.parameterMenu?.kind === 'optional') this.closeParameterMenu();
      else this.openParameterMenu({ kind: 'optional', activeIndex: 0 });
    } else if (button.dataset.botAction === 'autocomplete-load-more') {
      this.autocomplete.loadMore();
    } else if (button.dataset.botSelectValue !== undefined) {
      this.chooseBotSelectValue(button);
    } else if (button.dataset.fieldAction) {
      const binding = this.fieldBinding(button);
      if (!binding) return;
      const error = button.closest('form')?.querySelector<HTMLElement>('.bot-error');
      const values = applyBotFieldAction(button, binding.fields, binding.values, binding.context);
      if (values) {
        binding.save(values);
        if (error) { error.textContent = ''; error.hidden = true; }
      }
    } else if (button.dataset.botAction === 'cancel-command') this.cancelCommand();
    else if (button.dataset.botAction === 'cancel-invocation') {
      const id = button.closest<HTMLElement>('[data-invocation-id]')?.dataset.invocationId;
      if (id) void this.cancelInvocation(id);
    }
  };

  private onSubmit = (event: Event): void => {
    if (!(event.target instanceof HTMLFormElement) || !this.isCurrent()) return;
    const form = event.target;
    if (form.hasAttribute('data-command-form')) {
      event.preventDefault();
      const gesture = this.submitGesture;
      this.submitGesture = false;
      void this.invoke(gesture);
    } else if (form.dataset.interactionId) {
      event.preventDefault();
      const id = form.closest<HTMLElement>('[data-invocation-id]')?.dataset.invocationId;
      if (id) void this.submitForm(id, form.dataset.interactionId);
    }
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (!(event.target instanceof HTMLElement) || !this.isCurrent()) return;
    if (audioPreviewService.ownsEventTarget(event.target)) return;
    if (event.isComposing || this.composing || event.keyCode === 229) return;
    if (this.handleBotSelectKey(event)) return;
    const inComposer = this.composer.contains(event.target);
    const card = event.target.closest<HTMLElement>('[data-invocation-id]');
    if (!inComposer && !card) return;
    if (inComposer && this.handleParameterArrowRight(event)) return;
    if (inComposer && this.handleParameterMenuKey(event)) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (inComposer) this.cancelCommand();
      else {
        const id = card?.dataset.invocationId;
        if (id) void this.cancelInvocation(id);
      }
    } else if (event.key === 'Enter' && !event.shiftKey && !event.isComposing &&
      !(event.target instanceof HTMLButtonElement || event.target instanceof HTMLSelectElement) &&
      !(event.target instanceof HTMLInputElement && event.target.type === 'checkbox')) {
      if (event.target instanceof HTMLTextAreaElement && !inComposer && !event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      if (inComposer) void this.invoke(event.isTrusted);
      else event.target.closest('form')?.requestSubmit();
    }
  };

  private chooseBotSelectValue(element: HTMLElement): void {
    const value = element.dataset.botSelectValue;
    const binding = this.fieldBinding(element);
    const root = element.closest<HTMLElement>('[data-field-name]');
    const field = binding?.fields.find((entry) => entry.name === root?.dataset.fieldName);
    if (value === undefined || !binding || binding.context.disabled || field?.type !== 'select' ||
        !field.choices.some((choice) => choice.value === value)) return;
    binding.save({ ...binding.values, [field.name]: value });
    root?.querySelectorAll<HTMLElement>('[data-bot-select-value]').forEach((choice) => {
      const selected = choice.dataset.botSelectValue === value;
      choice.classList.toggle('active', selected);
      choice.setAttribute('aria-selected', String(selected));
      choice.tabIndex = selected ? 0 : -1;
    });
    if (element.dataset.botSelectSubmit === 'true' || field.presentation === 'buttons') {
      element.closest('form')?.requestSubmit();
    }
  }

  private handleBotSelectKey(event: KeyboardEvent): boolean {
    const option = event.target instanceof HTMLElement
      ? event.target.closest<HTMLElement>('[data-bot-select-value]')
      : null;
    if (!option) return false;
    const options = [...(option.parentElement?.querySelectorAll<HTMLElement>('[data-bot-select-value]') ?? [])];
    const index = options.indexOf(option);
    if (index < 0) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const next = (index + ((event.key === 'ArrowDown' || event.key === 'ArrowRight') ? 1 : -1) + options.length) % options.length;
      options[next]?.focus();
      return true;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.chooseBotSelectValue(option);
      return true;
    }
    return false;
  }

  private cancelCommand(): void {
    if (this.store.getCommandDraft(this.channelId)?.pending) return;
    this.cancelLocalPreparation();
    this.store.clearCommand(this.channelId);
  }

  public async invoke(userGesture = false): Promise<void> {
    const draft = this.store.getCommandDraft(this.channelId);
    if (!draft || draft.pending || this.preparingCommand === draft || !this.canSend()) return;
    const command = draft.command;
    const voiceError = this.voiceError(command);
    if (voiceError) {
      this.closeParameterMenu();
      this.store.setCommandPending(this.channelId, draft, false, voiceError);
      return;
    }
    if (!this.store.isCommandAvailable(command)) {
      this.store.setCommandPending(this.channelId, draft, false, t('botChat.commandUnavailable'));
      return;
    }
    const result = commandValuesFromInputs(
      command, visibleCommandValues(command, draft.values, draft.visibleOptionalNames), this.server.getHumanMembersInDisplayOrder(),
      draft.autocomplete, draft.visibleOptionalNames
    );
    if (!result.success) {
      this.store.touchCommandField(this.channelId, result.field);
      this.store.setCommandPending(this.channelId, draft, false,
        botInputError(commandInputFields(this.localizedCommand(command)), result.field, result.reason));
      this.focusInvalidField(`command-${this.channelId}`, result.field);
      return;
    }
    const payload: CommandInvokePayload = {
      commandName: command.name,
      botId: command.botId,
      channelId: this.channelId,
      options: result.values,
      locale: botLocaleFor(this.client, this.server, command.botId),
    };
    const connectionId = this.client.getConnectionId();
    const requestId = uuidv4();
    let local: LocalExecutionController | undefined;
    let grant: PreparedLocalCapability | undefined;
    const voiceEpoch = this.voiceEpoch;
    const folder = settingsStore.soundboardFolderPath;
    if (command.downloadsSound && (!userGesture || !draft.downloadConsent)) {
      this.store.setCommandPending(this.channelId, draft, false, t('botChat.downloadNeedsGesture'));
      return;
    }
    try {
      if (commandLocalCapabilities(command).length) {
        this.preparingCommand = draft;
        this.commandPreparationId = requestId;
        this.renderComposer();
        [grant] = await this.prepareLocalCommand(draft);
        if (this.preparingCommand !== draft || this.commandPreparationId !== requestId || this.store.getCommandDraft(this.channelId) !== draft ||
          !this.isCurrent() || this.client.getConnectionId() !== connectionId || voiceEpoch !== this.voiceEpoch) return;
        this.preparingCommand = null;
        this.commandPreparationId = null;
      }
    } catch (error) {
      if (this.commandPreparationId === requestId) {
        this.preparingCommand = null;
        this.commandPreparationId = null;
      }
      if (this.commandPreparationId === null && this.isCurrent() && this.store.getCommandDraft(this.channelId) === draft &&
        this.client.getConnectionId() === connectionId && voiceEpoch === this.voiceEpoch &&
        this.localMetadataKey(command) === this.localMetadataKey(draft.command)) {
        this.store.setCommandPending(this.channelId, draft, false, t(`localExecution.failure.${localFailure(error)}`));
      }
      return;
    }
    this.store.setCommandPending(this.channelId, draft, true);
    try {
      if (command.downloadsSound) {
        const availability = await window.api?.soundDownloadAvailability?.(folder);
        if (availability !== 'ready') {
          this.store.setCommandPending(this.channelId, draft, false,
            t(availability === 'unavailable' ? 'botChat.downloadWriteFailed'
              : availability === 'confirmation_required' ? 'botChat.downloadFolderNeedsConfirmation' : 'botChat.downloadFolderRequired'));
          return;
        }
        payload.allowSoundDownload = true;
      }
      if (this.store.getCommandDraft(this.channelId) !== draft || !draft.pending ||
          this.client.getConnectionId() !== connectionId || !this.canSend()) return;
      if (voiceEpoch !== this.voiceEpoch || this.voiceError(command)) {
        this.store.setCommandPending(this.channelId, draft, false, this.voiceError(command) ?? t('botChat.voiceContextChanged'));
        return;
      }
      if (!this.store.isCommandAvailable(command) || this.localMetadataKey(command) !== this.localMetadataKey(draft.command)) {
        this.store.setCommandPending(this.channelId, draft, false, t('botChat.commandUnavailable'));
        return;
      }
      if (grant) {
        local = localExecutionFor(this.client);
        payload.localPreparation = local.registerRequest('invocation', requestId, grant, {
          channelId: this.channelId, commandName: command.name,
        });
      }
      const ack = await this.client.sendRequest<CommandInvokedPayload>(MessageType.COMMAND_INVOKE,
        { ...payload, ...botUserSettingsPayload(this.client, this.server, command.botId) }, requestId);
      local?.acknowledgeRequest(requestId, ack);
      if (this.store.getCommandDraft(this.channelId) !== draft || !draft.pending || voiceEpoch !== this.voiceEpoch) return;
      if (this.voiceError(command)) {
        this.store.setCommandPending(this.channelId, draft, false, this.voiceError(command));
        return;
      }
      if (!ack || typeof ack.invocationId !== 'string' || !ack.invocationId || ack.invocationId.length > 128 ||
          ack.botId !== command.botId || ack.commandName !== command.name || ack.channelId !== this.channelId ||
          this.client.getConnectionId() !== connectionId || this.client.getStatus() !== 'CONNECTED') {
        local?.releaseRequest(requestId);
        this.store.setCommandPending(this.channelId, draft, false, t('botChat.requestFailed'));
        return;
      }
      this.store.acknowledgeCommand(ack, command);
      if (command.downloadsSound) localSoundDownloads.authorize(this.client, this.store, this.server, command, ack, connectionId, folder, userGesture);
      this.store.clearCommand(this.channelId, draft);
    } catch (error) {
      local?.releaseRequest(requestId);
      if (this.store.getCommandDraft(this.channelId) === draft && draft.pending && voiceEpoch === this.voiceEpoch) {
        this.store.setCommandPending(this.channelId, draft, false, botRequestError(error));
      }
    }
  }

  private async submitForm(invocationId: string, interactionId: string): Promise<void> {
    const invocation = this.store.getInvocation(invocationId);
    const form = invocation?.forms.find((state) => state.interactionId === interactionId);
    if (!invocation || !form || form.status !== 'editing' || !this.canSend() || this.voiceError(invocation)) return;
    const result = formValuesFromInputs(form.form, form.values);
    if (!result.success) {
      this.store.failFormSubmit(invocationId, interactionId, botInputError(form.form.fields, result.field, result.reason));
      this.focusInvalidField(`${invocationId}-${interactionId}`, result.field);
      return;
    }
    if (!this.store.beginFormSubmit(invocationId, interactionId)) return;
    const payload: CommandSubmitPayload = { invocationId, interactionId, values: result.values };
    try {
      const ack = await this.client.sendRequest<CommandSubmitPayload>(MessageType.COMMAND_SUBMIT, payload);
      if (this.store.getInvocation(invocationId) === invocation) this.store.acknowledgeForm(ack);
    } catch (error) {
      if (this.store.getInvocation(invocationId) === invocation) {
        this.store.failFormSubmit(invocationId, interactionId, botRequestError(error));
      }
    }
  }

  private async cancelInvocation(invocationId: string): Promise<void> {
    const invocation = this.store.getInvocation(invocationId);
    if (!invocation || !this.store.setCancelPending(invocationId, true)) return;
    localSoundDownloads.cancelInvocation(this.client, invocationId);
    try {
      const ack = await this.client.sendRequest<CommandFinishedPayload>(MessageType.COMMAND_CANCEL, { invocationId });
      if (this.store.getInvocation(invocationId) === invocation) this.store.finishInvocation(ack);
    } catch (error) {
      if (this.store.getInvocation(invocationId) === invocation) {
        this.store.setCancelPending(invocationId, false, botRequestError(error));
      }
    }
  }

  private focusInvalidField(prefix: string, name: string): void {
    if (!this.isCurrent()) return;
    const field = [...this.composer.querySelectorAll<HTMLElement>('[id]'), ...this.feed.querySelectorAll<HTMLElement>('[id]')]
      .find((element) => element.id === `${prefix}-${name}` || element.id === `${prefix}-${name}-0`);
    field?.setAttribute('aria-invalid', 'true');
    field?.focus();
  }

  private scheduleExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    if (this.destroyed) return;
    const next = this.store.getInvocations(this.channelId)
      .filter((invocation) => invocation.status === 'active')
      .reduce((time, invocation) => Math.min(time, invocation.expiresAt), Infinity);
    if (!Number.isFinite(next)) return;
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      this.store.expireInvocations();
      this.scheduleExpiry();
    }, Math.max(1, next - Date.now()));
  }

  public destroy(): void {
    this.cancelLocalPreparation();
    this.closeParameterMenu();
    this.destroyed = true;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    for (const unbind of this.unbind) unbind();
    this.unbind = [];
  }
}
