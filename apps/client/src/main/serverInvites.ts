import { parseServerInviteLink, SERVER_INVITE_SCHEME, type ServerInviteResult } from '@monky/shared';

export class ServerInviteInbox {
  private pending: ServerInviteResult | null = null;

  public receive(url: string): boolean {
    if (!url.toLowerCase().startsWith(`${SERVER_INVITE_SCHEME}:`)) return false;
    const result = parseServerInviteLink(url);
    if (!result.ok) console.warn('[Invites] Invalid server invitation received:', result.reason);
    this.pending = result;
    return true;
  }

  public receiveArguments(args: readonly string[]): boolean {
    let received = false;
    for (const argument of args) received = this.receive(argument) || received;
    return received;
  }

  public take(): ServerInviteResult | null {
    const pending = this.pending;
    this.pending = null;
    return pending;
  }
}
