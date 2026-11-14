import type { BrowserWindow } from 'electron';
import { DISCORD_WEB_CLOSED, DISCORD_WEB_CURSOR, DISCORD_WEB_FRAME, DISCORD_WEB_IPC, DISCORD_WEB_SPLIT, discordWebCommandSchema } from '@monky/shared';
import type { IpcRegistry } from './registry';
import { DiscordWebPage } from '../discordWebPage';

export function registerDiscordWebIpc(registry: IpcRegistry, owner: BrowserWindow): DiscordWebPage {
  const discord = new DiscordWebPage(owner, {
    frame: frame => registry.send('main', DISCORD_WEB_FRAME, frame),
    cursor: type => registry.send('main', DISCORD_WEB_CURSOR, type),
    split: split => registry.send('main', DISCORD_WEB_SPLIT, split),
    closed: () => registry.send('main', DISCORD_WEB_CLOSED),
  });
  registry.handle(DISCORD_WEB_IPC.open, 'main', () => discord.open());
  registry.handle(DISCORD_WEB_IPC.command, 'main', (_event, input) => {
    const command = discordWebCommandSchema.parse(input);
    if (command.action === 'layout') discord.layout(command.width, command.height, command.visible);
    else if (command.action === 'close') discord.close();
    else discord.input(command);
  });
  // A reloaded or crashed Monky page no longer knows the Discord page it had opened.
  const ownerNavigated = (_event: unknown, _url: string, _inPlace: boolean, mainFrame: boolean): void => {
    if (mainFrame) discord.close();
  };
  const ownerGone = (): void => discord.close();
  owner.webContents.on('did-start-navigation', ownerNavigated);
  owner.webContents.on('render-process-gone', ownerGone);
  registry.onDispose(() => {
    if (!owner.isDestroyed()) {
      owner.webContents.removeListener('did-start-navigation', ownerNavigated);
      owner.webContents.removeListener('render-process-gone', ownerGone);
    }
    discord.dispose();
  });
  return discord;
}
