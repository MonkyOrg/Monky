import {
  MessageType, botScreenCreateSchema, botScreenIdSchema, botScreenPatchSchema,
  botScreenSchema, botScreenListSchema, botScreenListResultSchema, botScreenActionEventSchema, botScreenRemovedSchema,
  type BotScreen, type BotScreenCreate, type BotScreenPatch, type BotScreenActionEvent, type BotScreenRemoved,
} from '@monky/shared';

export interface BotScreenAdapter {
  request(serverId: string, type: MessageType, payload: unknown): Promise<unknown>;
  report(serverId: string, event: BotScreenActionEvent): void;
  removed(serverId: string, event: BotScreenRemoved): void;
  error(serverId: string, error: Error): void;
}

/** Composes with BotClient's authenticated per-server request transport; owns no sockets. */
export class BotScreenClient {
  constructor(private adapter: BotScreenAdapter) {}

  async createScreen(serverId: string, input: BotScreenCreate): Promise<BotScreen> {
    return botScreenSchema.parse(await this.adapter.request(serverId, MessageType.BOT_SCREEN_CREATE, botScreenCreateSchema.parse(input)));
  }

  async updateScreen(serverId: string, id: string, patch: BotScreenPatch): Promise<BotScreen> {
    return botScreenSchema.parse(await this.adapter.request(serverId, MessageType.BOT_SCREEN_UPDATE,
      { ...botScreenIdSchema.parse({ id }), ...botScreenPatchSchema.parse(patch) }));
  }

  async closeScreen(serverId: string, id: string): Promise<void> {
    botScreenRemovedSchema.parse(await this.adapter.request(serverId, MessageType.BOT_SCREEN_CLOSE, botScreenIdSchema.parse({ id })));
  }

  async listScreens(serverId: string, channelId: string): Promise<BotScreen[]> {
    return botScreenListResultSchema.parse(await this.adapter.request(serverId, MessageType.BOT_SCREEN_LIST, botScreenListSchema.parse({ channelId }))).screens;
  }

  handle(serverId: string, type: string, payload: unknown): boolean {
    if (type === MessageType.BOT_SCREEN_ACTION_EVENT) {
      const event = botScreenActionEventSchema.safeParse(payload);
      if (event.success) this.adapter.report(serverId, event.data);
      else this.adapter.error(serverId, new Error('Invalid programmable screen action.'));
      return true;
    }
    if (type === MessageType.BOT_SCREEN_REMOVED) {
      const event = botScreenRemovedSchema.safeParse(payload);
      if (event.success) this.adapter.removed(serverId, event.data);
      else this.adapter.error(serverId, new Error('Invalid programmable screen removal.'));
      return true;
    }
    return false;
  }
}
