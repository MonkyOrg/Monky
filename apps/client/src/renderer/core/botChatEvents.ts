import {
  MessageType,
  type BotCommandMessagePayload,
  type BotRevokedPayload,
  type CommandsListResponsePayload,
  type CommandInvokedPayload,
  type CommandPromptReceivedPayload,
  type CommandSubmitPayload,
  type CommandFinishedPayload,
} from '@monky/shared';
import { appEvents, type EventBus } from './EventBus';
import { chatStore } from '../stores/chatStore';
import { serverStore } from '../stores/serverStore';
import { botCommandMessage } from '../utils/botInputs';

/** SessionManager routes these synchronous mutations to the originating stores. */
export function bindBotChatEvents(events: EventBus = appEvents): () => void {
  const unbind = [
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
