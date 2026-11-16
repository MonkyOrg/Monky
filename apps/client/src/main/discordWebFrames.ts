import type { WebContents } from 'electron';
import type { DiscordWebCommand } from '@monky/shared';
import { isRecord } from './ipc/guards';

type PointerCommand = Extract<DiscordWebCommand, { action: 'mouse' | 'wheel' }>;
type Modifier = PointerCommand['modifiers'][number];

const MODIFIER_BITS: Partial<Record<Modifier, number>> = { alt: 1, control: 2, meta: 4, shift: 8 };
const BUTTON_BITS: Partial<Record<Modifier, number>> = { leftbuttondown: 1, rightbuttondown: 2, middlebuttondown: 4 };
const PRESS_TYPES = { down: 'mousePressed', up: 'mouseReleased' } as const;

interface Frame { frameId: string; session: string; x: number; y: number }

/** Attaches DevTools to the page, unless it already is; throws when someone else holds it. */
export function attachDevTools(contents: WebContents): void {
  if (!contents.debugger.isAttached()) contents.debugger.attach('1.3');
}

const text = (value: unknown, key: string): string | null => {
  const field = isRecord(value) ? value[key] : undefined;
  return typeof field === 'string' ? field : null;
};

const number = (value: unknown, key: string): number | null => {
  const field = isRecord(value) ? value[key] : undefined;
  return typeof field === 'number' && Number.isFinite(field) ? field : null;
};

const bits = (modifiers: readonly Modifier[], table: Partial<Record<Modifier, number>>): number =>
  modifiers.reduce((sum, modifier) => sum | (table[modifier] ?? 0), 0);

/**
 * Hands the pointer to the frames Discord embeds from other sites, such as its
 * hCaptcha check. Chromium renders each of those in a process of its own, and
 * an offscreen page passes the input it is sent to its own frame only, so a
 * click on one reached nothing (electron/electron#20333). DevTools reaches each
 * such frame as a target of its own: the pointer over one is sent to it there,
 * at the same point in the frame's own coordinates, as a person's would be.
 * Everywhere else, and until the page embeds such a frame, the page receives
 * the input as before.
 */
export class DiscordWebFrames {
  /** The DevTools session of each frame from another site, by the frame it renders. */
  private readonly frames = new Map<string, string>();
  private watching = false;
  /** The frame a button was pressed in keeps the pointer until it is released, as with a real pointer. */
  private captured: string | null = null;
  /** Input waiting to learn where it goes, in the order it was given. */
  private queue: Promise<void> = Promise.resolve();
  private queued = 0;
  /** The last input queued, while it is a move still waiting: a move queued right after it overtakes it. */
  private waitingMove: { overtaken: boolean } | null = null;

  constructor(private readonly contents: WebContents) {
    contents.debugger.on('message', (_event, method: string, params: unknown) => this.message(method, params));
  }

  /** The page's pointer input, in its CSS pixels; `page` delivers it to the page's own frame. */
  route(command: PointerCommand, page: () => void): void {
    this.watch();
    if (!this.frames.size && !this.queued) {
      page();
      return;
    }
    this.queued++;
    const move = command.action === 'mouse' && command.type === 'move' ? { overtaken: false } : null;
    if (move && this.waitingMove) this.waitingMove.overtaken = true;
    this.waitingMove = move;
    this.queue = this.queue
      .then(() => {
        if (this.waitingMove === move) this.waitingMove = null;
        // A move overtaken by the next before it went anywhere is left out rather than delivered late.
        return move?.overtaken ? undefined : this.deliver(command, page);
      })
      .catch(error => console.warn('[Discord web] Could not reach an embedded frame.', error instanceof Error ? error.message : error))
      .finally(() => { this.queued--; });
  }

  /** DevTools let go of the page: its frames are found again on the next input. */
  detached(): void {
    this.watching = false;
    this.frames.clear();
    this.captured = null;
  }

  private watch(): void {
    if (this.watching) return;
    try {
      attachDevTools(this.contents);
    } catch (error) {
      console.warn('[Discord web] Could not reach embedded frames.', error instanceof Error ? error.message : error);
      return;
    }
    this.watching = true;
    // Only frames: a worker Chromium attached here crashed the whole app when Discord
    // restarted it (TargetHandler::AutoAttach on a session already let go).
    void this.send('Target.setAutoAttach', {
      autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: 'iframe' }],
    }).catch(error => {
      this.watching = false;
      console.warn('[Discord web] Could not reach embedded frames.', error instanceof Error ? error.message : error);
    });
  }

  private message(method: string, params: unknown): void {
    if (method === 'Target.attachedToTarget') {
      const session = text(params, 'sessionId');
      const target = isRecord(params) ? params.targetInfo : undefined;
      const frameId = text(target, 'targetId');
      if (!session || !frameId || text(target, 'type') !== 'iframe') return;
      this.frames.set(frameId, session);
    } else if (method === 'Target.detachedFromTarget') {
      const session = text(params, 'sessionId');
      for (const [frameId, owned] of this.frames) if (owned === session) this.frames.delete(frameId);
      if (this.captured && !this.frames.has(this.captured)) this.captured = null;
    }
  }

  private async deliver(command: PointerCommand, page: () => void): Promise<void> {
    const frame = await this.frameAt(command);
    if (!frame) {
      page();
      return;
    }
    const x = command.x - frame.x, y = command.y - frame.y, modifiers = bits(command.modifiers, MODIFIER_BITS);
    if (command.action === 'wheel') {
      await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: command.deltaX, deltaY: command.deltaY, modifiers },
        frame.session);
      return;
    }
    const type = command.type === 'down' || command.type === 'up' ? PRESS_TYPES[command.type] : 'mouseMoved';
    if (command.type === 'down') this.captured = frame.frameId;
    if (command.type === 'up') this.captured = null;
    await this.send('Input.dispatchMouseEvent', {
      type, x, y, modifiers, button: command.button ?? 'none', buttons: bits(command.modifiers, BUTTON_BITS),
      clickCount: command.clickCount ?? 0,
    }, frame.session);
  }

  /** The frame from another site under the pointer, or the one holding it, and where its box starts on the page. */
  private async frameAt(command: PointerCommand): Promise<Frame | null> {
    if (this.captured) {
      const session = this.frames.get(this.captured);
      const owner = session ? await this.owner(this.captured) : null;
      const origin = owner === null ? null : await this.origin(owner);
      if (session && origin) return { frameId: this.captured, session, ...origin };
      this.captured = null;
    }
    if (command.action === 'mouse' && command.type === 'leave') return null;
    // Hit-tested as the pointer is, past what lets it through: Discord lays a canvas for its
    // effects over the whole page, and counting it hid every frame under it.
    const hit = await this.send('DOM.getNodeForLocation', {
      x: Math.floor(command.x), y: Math.floor(command.y), ignorePointerEventsNone: false,
    }).catch(() => null);
    const node = number(hit, 'backendNodeId');
    if (node === null) return null;
    for (const [frameId, session] of this.frames) {
      if (await this.owner(frameId) !== node) continue;
      const origin = await this.origin(node);
      return origin && { frameId, session, ...origin };
    }
    return null;
  }

  /** The page's element that holds the frame. */
  private async owner(frameId: string): Promise<number | null> {
    return number(await this.send('DOM.getFrameOwner', { frameId }).catch(() => null), 'backendNodeId');
  }

  /** Where the content of the frame's element starts on the page, in the page's CSS pixels. */
  private async origin(owner: number): Promise<{ x: number; y: number } | null> {
    const box = await this.send('DOM.getBoxModel', { backendNodeId: owner }).catch(() => null);
    const content = isRecord(box) && isRecord(box.model) ? box.model.content : null;
    const [x, y] = Array.isArray(content) ? content : [];
    return typeof x === 'number' && typeof y === 'number' ? { x, y } : null;
  }

  private send(method: string, params: Record<string, unknown>, session?: string): Promise<unknown> {
    return this.contents.debugger.sendCommand(method, params, session);
  }
}
