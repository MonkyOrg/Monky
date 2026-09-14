import {
  MessageType, botScreenCreateSchema, botScreenRefSchema, botScreenPatchSchema,
  botScreenSchema, botScreenListSchema, botScreenListResultSchema, botScreenActionEventSchema, botScreenRemovedSchema,
  type BotScreen, type BotScreenRef, type BotScreenCreate, type BotScreenPatch, type BotScreenActionEvent, type BotScreenRemoved,
} from '@monky/shared';

export interface BotScreenAdapter {
  request(serverId: string, type: MessageType, payload: unknown): Promise<unknown>;
  report(serverId: string, event: BotScreenActionEvent): void;
  removed(serverId: string, event: BotScreenRemoved): void;
  error(serverId: string, error: Error): void;
}

/** Composes with BotClient's authenticated per-server request transport; owns no sockets. */
export class BotScreenClient {
  private reads = new Set<{ serverId: string; removed: Set<string> }>();

  constructor(private adapter: BotScreenAdapter) {}

  async createScreen(serverId: string, input: BotScreenCreate): Promise<BotScreen> {
    return this.read(serverId, async () => {
      const screen = botScreenSchema.parse(await this.adapter.request(
        serverId, MessageType.BOT_SCREEN_CREATE, botScreenCreateSchema.parse(input),
      ));
      if (screen.channelId !== input.channelId || (input.id !== undefined && screen.id !== input.id)) {
        throw new Error('The miniapp creation response does not match the request.');
      }
      return screen;
    }, (screen) => [screen]);
  }

  async updateScreen(serverId: string, ref: BotScreenRef, patch: BotScreenPatch): Promise<BotScreen> {
    const reference = botScreenRefSchema.parse({ id: ref.id, instanceId: ref.instanceId });
    return this.read(serverId, async () => {
      const screen = botScreenSchema.parse(await this.adapter.request(serverId, MessageType.BOT_SCREEN_UPDATE,
        { ...reference, ...botScreenPatchSchema.parse(patch) }));
      if (screen.id !== reference.id || screen.instanceId !== reference.instanceId) {
        throw new Error('The miniapp update response addresses another instance.');
      }
      return screen;
    }, (screen) => [screen]);
  }

  async closeScreen(serverId: string, ref: BotScreenRef): Promise<void> {
    const reference = botScreenRefSchema.parse({ id: ref.id, instanceId: ref.instanceId });
    const removed = botScreenRemovedSchema.parse(await this.adapter.request(serverId, MessageType.BOT_SCREEN_CLOSE, reference));
    if (removed.id !== reference.id || removed.instanceId !== reference.instanceId || removed.reason !== 'closed') {
      throw new Error('The miniapp close response does not match the request.');
    }
  }

  async listScreens(serverId: string, channelId: string): Promise<BotScreen[]> {
    return this.read(serverId, async () => {
      const result = botScreenListResultSchema.parse(await this.adapter.request(
        serverId, MessageType.BOT_SCREEN_LIST, botScreenListSchema.parse({ channelId }),
      ));
      if (result.channelId !== channelId || result.screens.some((screen) => screen.channelId !== channelId)) {
        throw new Error('The miniapp list response addresses another channel.');
      }
      return result.screens;
    }, (screens) => screens);
  }

  private async read<T>(serverId: string, load: () => Promise<T>, screens: (value: T) => readonly BotScreenRef[]): Promise<T> {
    const pending = { serverId, removed: new Set<string>() };
    this.reads.add(pending);
    try {
      const value = await load();
      if (screens(value).some((screen) => pending.removed.has(screen.instanceId))) {
        throw new Error('The miniapp instance was removed while its request was in flight.');
      }
      return value;
    } finally {
      this.reads.delete(pending);
    }
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
      if (event.success) {
        for (const pending of this.reads) {
          if (pending.serverId === serverId) pending.removed.add(event.data.instanceId);
        }
        this.adapter.removed(serverId, event.data);
      } else this.adapter.error(serverId, new Error('Invalid programmable screen removal.'));
      return true;
    }
    return false;
  }
}
