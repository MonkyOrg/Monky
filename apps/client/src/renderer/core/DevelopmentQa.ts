import {
  LOCAL_CAPABILITY_TOOLS, MessageType, Permission, type BotInstalledPayload, type BotInstallPreview,
  type BotPermissionsSnapshot, type DevelopmentQaConfig, type DevelopmentQaReport,
} from '@monky/shared';
import { connectionStore } from '../stores/connectionStore';
import { settingsStore } from '../stores/settingsStore';
import { voiceStore } from '../stores/voiceStore';
import { sessionManager } from './SessionManager';
import { joinCallOnSession, openServerSession } from './serverConnection';
import { serverSettingsModal } from '../views/ServerSettingsModal';
import { webRtcManager } from './WebRtcManager';
import { localExecutionFor } from './LocalExecutionController';
import { getCommandPresentation } from '@monky/shared';
import { getLanguage } from '../i18n';

async function until(check: () => boolean, description: string, signal: AbortSignal): Promise<void> {
  const deadline = performance.now() + 30_000;
  while (!check()) {
    signal.throwIfAborted();
    if (performance.now() > deadline) throw new Error(`Prepared QA timed out: ${description}`);
    await new Promise<void>((resolve) => window.setTimeout(resolve, 40));
  }
}

export async function prepareDevelopmentQaProfile(config: DevelopmentQaConfig): Promise<void> {
  // Use the real identity service in the already isolated Main profile.
  await window.api.getIdentity();
  connectionStore.saveUserProfile(config.nickname);
  settingsStore.onboardingCompleted = true;
  settingsStore.minimizeToTrayOnClose = false;
  settingsStore.autoEntryServerKeys = [];
  voiceStore.setMuted(true);
  settingsStore.save();
}

export async function startDevelopmentQa(config: DevelopmentQaConfig): Promise<void> {
  const owner = new AbortController();
  const abort = () => owner.abort();
  window.addEventListener('pagehide', abort, { once: true });
  const report: DevelopmentQaReport = { runId: config.runId, scenario: config.scenario, phase: 'ready', connected: false };
  const publish = async (phase: DevelopmentQaReport['phase']): Promise<void> => {
    if (!await window.api.reportDevelopmentQaState({ ...report, phase })) throw new Error('Prepared QA launcher is no longer available.');
  };
  try {
    if (config.scenario === 'home' || config.scenario === 'login') {
      if (!document.querySelector('.connection-layout')) throw new Error('The real Home view was not rendered.');
      if (config.scenario === 'login') {
        for (const [id, value] of Object.entries({
          'join-host': config.server.host, 'join-port': String(config.server.port),
          'join-nickname': config.nickname, 'join-password': config.server.password,
        })) {
          const input = document.getElementById(id);
          if (!(input instanceof HTMLInputElement)) throw new Error(`Missing real login field: ${id}`);
          input.value = value;
        }
      }
      await publish('ready');
      return;
    }
    const identity = await window.api.getIdentity();
    const auth = await openServerSession(config.server.host, config.server.port, identity, config.nickname, config.server.password, { timeoutMs: 30_000 });
    const session = sessionManager.getActive();
    if (!session || session.client.getStatus() !== 'CONNECTED' || !session.serverStore.hasPermission(Permission.MANAGE_SERVER)) {
      throw new Error('Prepared QA did not authenticate as the first real server owner.');
    }
    const text = auth.server.channels.find((channel) => channel.type === 'TEXT');
    const voice = auth.server.channels.find((channel) => channel.type === 'VOICE');
    if (!text || !voice) throw new Error('The real QA server is missing its seeded channels.');
    Object.assign(report, { connected: true, serverId: auth.server.id, userId: auth.currentUser.id, textChannelId: text.id });
    await publish('connected');
    const channel = document.querySelector<HTMLButtonElement>(`[data-channel-id="${CSS.escape(text.id)}"][data-channel-type="TEXT"]`);
    if (!channel) throw new Error('The real text-channel control is missing.');
    channel.click();
    await until(() => !!document.querySelector('#chat-message-input'), 'chat view', owner.signal);
    const seed = '**QA preparado / Prepared QA**\nPerfil, servidor e dados isolados / Isolated profile, server and data.';
    session.client.send(MessageType.CHAT_SEND, { channelId: text.id, content: seed });
    await until(() => session.chatStore.getMessages(text.id).some((message) => message.content === seed), 'authenticated seeded message acknowledgement', owner.signal);

    if (config.scenario === 'bot-install') {
      serverSettingsModal.open('bots');
      const input = document.querySelector<HTMLInputElement>('#bot-manifest-url');
      if (!input || !config.bot) throw new Error('Bot installation UI is not available.');
      input.value = config.bot.manifestUrl;
      await publish('ready');
      return;
    }
    if (config.bot) {
      if (!session.serverStore.hasPermission(Permission.MANAGE_BOTS)) throw new Error('The QA owner cannot review bot capabilities.');
      const preview = await session.client.sendRequest<BotInstallPreview>(
        MessageType.BOT_INSTALL_PREVIEW, { manifestUrl: config.bot.manifestUrl }, undefined, 30_000);
      const requested = preview.manifest.requestedCapabilities;
      const installed = await session.client.sendRequest<BotInstalledPayload>(MessageType.BOT_INSTALL, {
        previewId: preview.previewId, grantedCapabilities: requested,
      }, undefined, 30_000);
      report.botId = installed.bot.id;
      await until(() => session.chatStore.getCommands().some((command) => command.botId === installed.bot.id),
        'authenticated bot connection and registered commands', owner.signal);
      report.commandCount = session.chatStore.getCommands().filter((command) => command.botId === installed.bot.id).length;
      const snapshot = await session.client.sendRequest<BotPermissionsSnapshot>(
        MessageType.BOT_PERMISSIONS_GET, { botId: installed.bot.id }, undefined, 30_000);
      const permissions = snapshot.permissions;
      if (snapshot.botId !== installed.bot.id || permissions.reviewRequired || permissions.reviewedBy !== auth.currentUser.id ||
          permissions.requested?.length !== requested.length || permissions.granted.length !== requested.length ||
          !requested.every((capability) => permissions.requested?.includes(capability) && permissions.granted.includes(capability))) {
        throw new Error('The QA owner did not approve exactly the bot capabilities reviewed in its real manifest.');
      }
      report.botPermissions = permissions;
    }
    if (config.scenario === 'voice' || config.scenario === 'music') {
      await joinCallOnSession(session.key, voice.id);
      report.voiceChannelId = voice.id;
      await publish('voice-joined');
      await until(() => webRtcManager.getVoiceStatus().connectedP2pPeers.length > 0, 'real SDK bot P2P peer', owner.signal);
      report.peers = webRtcManager.getVoiceStatus().connectedP2pPeers.length;
      report.muted = voiceStore.isMuted;
      if (!report.muted) throw new Error('Prepared QA must start with its synthetic microphone muted.');
    }
    if (config.scenario === 'tool-consent' || config.scenario === 'music') {
      const command = session.chatStore.getCommands().find((candidate) => candidate.botId === report.botId &&
        candidate.localCapabilities?.includes('youtube-audio') && (config.scenario !== 'music' || candidate.name === 'play'));
      if (!command?.botPublicKey) throw new Error('The selected bot did not register the required authenticated local-audio command.');
      const snapshot = await window.api.getLocalExecutionState();
      if (!snapshot.supported) throw new Error('Local tool preparation is unavailable on this platform.');
      if (snapshot.permissions.length) throw new Error('A fresh QA profile must never inherit local consent.');
      const requiredTools = LOCAL_CAPABILITY_TOOLS['youtube-audio'];
      if (!requiredTools.every((id) => snapshot.tools.some((tool) => tool.id === id && tool.status === 'absent'))) {
        throw new Error('Fresh QA must not skip preparation by inheriting installed tools.');
      }
      report.localConsentCount = snapshot.permissions.length;
      report.localToolStatus = 'absent';
      if (config.scenario === 'music') {
        await publish('waiting-consent');
        if (config.smoke) throw new Error('Music QA needs real user consent and verified local tools. Unattended smoke cannot approve that dialog; use tool-consent --smoke to test its prerequisites.');
        await localExecutionFor(session.client).prepare({
          botId: command.botId, botName: command.botName, botPublicKey: command.botPublicKey,
        }, 'youtube-audio', owner.signal);
        const prepared = await window.api.getLocalExecutionState();
        if (!requiredTools.every((id) => prepared.tools.some((tool) => tool.id === id && tool.status === 'ready'))) {
          throw new Error('Production music tools did not become ready.');
        }
        report.localConsentCount = prepared.permissions.length;
        report.localToolStatus = 'ready';
      }
      const input = document.querySelector<HTMLTextAreaElement>('#chat-message-input');
      if (!input) throw new Error('The command composer is not available.');
      input.value = `/${getCommandPresentation(command, getLanguage()).displayName}`;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
    }
    if (config.scenario === 'server-settings') {
      serverSettingsModal.open('general');
      if (!document.querySelector('.server-settings-modal-card')) throw new Error('The real server-settings UI did not open.');
    }
    if (session.client.getStatus() !== 'CONNECTED') throw new Error('The QA session disconnected during preparation.');
    if (config.scenario === 'voice' || config.scenario === 'music') {
      const current = webRtcManager.getVoiceStatus();
      if (current.channelId !== voice.id || current.connectedP2pPeers.length === 0) {
        throw new Error('The real voice peer disconnected during preparation.');
      }
      report.peers = current.connectedP2pPeers.length;
      report.muted = voiceStore.isMuted;
    }
    await publish('ready');
  } catch (error: unknown) {
    if (!owner.signal.aborted) {
      await window.api.reportDevelopmentQaState({
        ...report, phase: 'failed', error: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
      });
    }
  } finally {
    owner.abort();
    window.removeEventListener('pagehide', abort);
  }
}
