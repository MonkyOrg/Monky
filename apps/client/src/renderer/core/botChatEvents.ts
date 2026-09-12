import {
  MessageType,
  type BotCommandMessagePayload,
  type BotRevokedPayload,
  type CommandsListResponsePayload,
  type CommandInvokedPayload,
  type CommandPromptReceivedPayload,
  type CommandSubmitPayload,
  type CommandFinishedPayload,
  type CommandSoundDownloadReceivedPayload,
  type CommandSoundDownloadCancelPayload,
} from '@monky/shared';
import { appEvents, type EventBus } from './EventBus';
import { chatStore } from '../stores/chatStore';
import { serverStore } from '../stores/serverStore';
import { botCommandMessage } from '../utils/botInputs';
import { getActiveNetworkClient, type ConnectionStatus } from './NetworkClient';
import { localSoundDownloads } from './LocalSoundDownloadService';

/** SessionManager routes these synchronous mutations to the originating stores. */
export function bindBotChatEvents(events: EventBus = appEvents): () => void {
  const unbind = [
    events.on(`message.${MessageType.COMMAND_SOUND_DOWNLOAD}`, (payload: CommandSoundDownloadReceivedPayload) => {
      localSoundDownloads.receive(getActiveNetworkClient(), payload);
    }),
    events.on(`message.${MessageType.COMMAND_SOUND_DOWNLOAD_CANCEL}`, (payload: CommandSoundDownloadCancelPayload) => {
      localSoundDownloads.cancelRequest(getActiveNetworkClient(), payload);
    }),
    events.on('network.status', (status: ConnectionStatus) => {
      if (status !== 'CONNECTED') localSoundDownloads.disconnect(getActiveNetworkClient());
    }),
    events.on(`message.${MessageType.COMMANDS_LIST_RESPONSE}`, (payload: CommandsListResponsePayload) => {
      serverStore.setSlashCommands(payload.commands ?? []);
      chatStore.setCommands(payload.commands ?? []);
    }),
    events.on(`message.${MessageType.COMMAND_RESPONSE}`, (payload: BotCommandMessagePayload) => {
      chatStore.addMessage(botCommandMessage(payload));
    }),
    events.on(`message.${MessageType.COMMAND_INVOKED}`, (payload: CommandInvokedPayload) => {
      chatStore.acknowledgeCommand(payload);
    }),
    events.on(`message.${MessageType.COMMAND_PROMPT}`, (payload: CommandPromptReceivedPayload) => {
      chatStore.receivePrompt(payload);
    }),
    events.on(`message.${MessageType.COMMAND_SUBMITTED}`, (payload: CommandSubmitPayload) => {
      chatStore.acknowledgeForm(payload);
    }),
    events.on(`message.${MessageType.COMMAND_FINISHED}`, (payload: CommandFinishedPayload) => {
      chatStore.finishInvocation(payload);
    }),
    events.on(`message.${MessageType.BOT_REVOKED}`, (payload: BotRevokedPayload) => {
      chatStore.finishBotInvocations(payload.botId);
      serverStore.removeMember(payload.botId);
    }),
  ];
  return () => {
    for (const remove of unbind) remove();
  };
}
