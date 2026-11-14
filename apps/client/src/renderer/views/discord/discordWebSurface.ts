import type { DiscordWebCommand, DiscordWebFrame, DiscordWebLayers, DiscordWebPopup, DiscordWebServerList } from '@monky/shared';

type Modifier = Extract<DiscordWebCommand, { action: 'mouse' }>['modifiers'][number];
type MouseButton = 'left' | 'middle' | 'right';
type KeyCommand = Extract<DiscordWebCommand, { action: 'key' }>;

const BUTTONS: Record<number, MouseButton> = { 0: 'left', 1: 'middle', 2: 'right' };
const DOUBLE_CLICK_MS = 500;
const DOUBLE_CLICK_DISTANCE = 4;
const WHEEL_LINE = 40;
const MAX_WHEEL = 10000;
/** Room around a popup for its shadow and its caret, hidden with it where it does not belong. */
const POPUP_MARGIN = 40;

type PopupKind = DiscordWebPopup['kind'];
/** A popup and the canvas whose part of the page opened it, which it is drawn beside. */
interface PlacedPopup { popup: DiscordWebPopup; owner: HTMLCanvasElement }

/** Keys whose DOM name differs from Electron's, and the text some of them type. */
const SPECIAL_KEYS: Record<string, { keyCode: string; text?: string }> = {
  Enter: { keyCode: 'Enter', text: '\r' },
  ' ': { keyCode: 'Space', text: ' ' },
  Backspace: { keyCode: 'Backspace' },
  Tab: { keyCode: 'Tab' },
  Escape: { keyCode: 'Escape' },
  Delete: { keyCode: 'Delete' },
  Insert: { keyCode: 'Insert' },
  Home: { keyCode: 'Home' },
  End: { keyCode: 'End' },
  PageUp: { keyCode: 'PageUp' },
  PageDown: { keyCode: 'PageDown' },
  ArrowUp: { keyCode: 'Up' },
  ArrowDown: { keyCode: 'Down' },
  ArrowLeft: { keyCode: 'Left' },
  ArrowRight: { keyCode: 'Right' },
};

/** Electron's cursor names that differ from CSS; the rest share CSS's name. */
const CURSOR_NAMES: Record<string, string> = { pointer: 'default', hand: 'pointer', nodrop: 'no-drop' };
const CSS_CURSORS = new Set(['default', 'pointer', 'text', 'wait', 'help', 'crosshair', 'move', 'progress', 'cell', 'copy', 'alias',
  'context-menu', 'vertical-text', 'no-drop', 'not-allowed', 'grab', 'grabbing', 'zoom-in', 'zoom-out', 'none', 'col-resize',
  'row-resize', 'all-scroll', 'e-resize', 'n-resize', 'ne-resize', 'nw-resize', 's-resize', 'se-resize', 'sw-resize', 'w-resize',
  'ew-resize', 'ns-resize', 'nesw-resize', 'nwse-resize']);

export function discordCursor(electronName: string): string {
  const name = CURSOR_NAMES[electronName] ?? electronName;
  return CSS_CURSORS.has(name) ? name : 'default';
}

/** A popup's box on the page's picture, grown by `margin` CSS px and rounded outward to whole device pixels. */
function devicePixels(popup: DiscordWebPopup, scale: number, margin: number): { x: number; y: number; width: number; height: number } {
  const x = Math.floor((popup.x - margin) * scale), y = Math.floor((popup.y - margin) * scale);
  return {
    x, y,
    width: Math.ceil((popup.x + popup.width + margin) * scale) - x,
    height: Math.ceil((popup.y + popup.height + margin) * scale) - y,
  };
}

function clampWheel(value: number): number {
  return Math.max(-MAX_WHEEL, Math.min(MAX_WHEEL, value));
}

function keyModifiers(event: KeyboardEvent): Modifier[] {
  const list: Modifier[] = [];
  if (event.shiftKey) list.push('shift');
  if (event.ctrlKey) list.push('control');
  if (event.altKey) list.push('alt');
  if (event.metaKey) list.push('meta');
  if (event.repeat) list.push('isautorepeat');
  return list;
}

function pointerModifiers(event: PointerEvent | WheelEvent): Modifier[] {
  const list: Modifier[] = [];
  if (event.shiftKey) list.push('shift');
  if (event.ctrlKey) list.push('control');
  if (event.altKey) list.push('alt');
  if (event.metaKey) list.push('meta');
  if (event.buttons & 1) list.push('leftbuttondown');
  if (event.buttons & 2) list.push('rightbuttondown');
  if (event.buttons & 4) list.push('middlebuttondown');
  return list;
}

/** One printable character (letters with accents and emoji included), as the keyboard typed it. */
function typedText(event: KeyboardEvent): string | null {
  if ([...event.key].length !== 1) return null;
  // Control and Meta make shortcuts, except AltGr (Control + Alt on Windows), which types.
  const shortcut = (event.ctrlKey || event.metaKey) && !event.getModifierState('AltGraph');
  return shortcut ? null : event.key;
}

/** The key Electron should press for a shortcut: the physical letter or digit, whatever the layout typed. */
function shortcutKey(event: KeyboardEvent): string {
  const physical = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(event.code);
  return physical ? (physical[1] ?? physical[2]) : event.key.length === 1 ? event.key.toUpperCase() : event.key;
}

/**
 * Draws the hidden Discord page into Monky's canvases and hands the person's
 * pointer and keyboard back to it. Every canvas shows the part of the page that
 * lies under it when the page's top-left corner sits at that canvas's origin
 * (client CSS px), and a point on the canvas maps back the same way.
 * Canvases may place the page differently (Discord's server list sits lower in
 * Monky's rail than on the page), so Discord's menus and tooltips, which cross
 * from one part into another, are drawn whole on a layer over all of them,
 * beside the canvas that opened them; every canvas placing the page otherwise
 * shows, where they are, the page as it was before they opened.
 */
export class DiscordWebSurface {
  private readonly backing = document.createElement('canvas');
  private readonly backingContext: CanvasRenderingContext2D | null;
  /** The page without its menus and tooltips, as last painted while none was open. */
  private readonly clean = document.createElement('canvas');
  private readonly cleanContext: CanvasRenderingContext2D | null;
  /** Every canvas the person points at: the page's parts and the menus' hit area. */
  private readonly canvases: readonly HTMLCanvasElement[];
  private readonly origins = new Map<HTMLCanvasElement, { x: number; y: number }>();
  private popups: PlacedPopup[] = [];
  private servers: DiscordWebServerList | null = null;
  private wheelFirst: ((canvas: HTMLCanvasElement, deltaY: number) => boolean) | null = null;
  /** Who opened the menus and the tooltips open now; kept while any of them stays open. */
  private readonly owners: Record<PopupKind, HTMLCanvasElement | null> = { menu: null, tooltip: null };
  /** The part the pointer was last on, or the menus when it was on them. */
  private pointerOn: HTMLCanvasElement | null = null;
  private hitsClip = '';
  private painted = false;
  private drawFrame: number | null = null;
  private moveFrame: number | null = null;
  private pendingMove: Extract<DiscordWebCommand, { action: 'mouse' }> | null = null;
  private lastClick = { button: '' as string, time: 0, x: 0, y: 0, count: 0 };
  /** Keys whose press reached Discord, so their release does too. */
  private readonly pressed = new Map<string, string>();

  /**
   * `parts` show the page; `primary`, one of them, owns the popups the pointer
   * did not open (the keyboard's, for one). Over every part and the rest of
   * Monky, `layer` draws the popups and `hits`, transparent and cut to the
   * menus, takes the pointer on them.
   */
  constructor(private readonly parts: readonly HTMLCanvasElement[], private readonly primary: HTMLCanvasElement,
    private readonly layer: HTMLCanvasElement, private readonly hits: HTMLCanvasElement,
    private readonly send: (command: DiscordWebCommand) => void, private readonly onFirstPaint: () => void) {
    this.canvases = [...parts, hits];
    this.backingContext = this.backing.getContext('2d');
    this.cleanContext = this.clean.getContext('2d');
    layer.hidden = true;
    hits.hidden = true;
  }

  /** Where the page's top-left corner sits in the window, for the part `canvas` shows. */
  setOrigin(canvas: HTMLCanvasElement, x: number, y: number): void {
    const origin = this.origin(canvas);
    if (origin.x === x && origin.y === y) return;
    this.origins.set(canvas, { x, y });
    this.scheduleDraw();
  }

  /** The menus follow whoever opened them, so a point on a menu reaches it where Discord drew it. */
  private origin(canvas: HTMLCanvasElement): { x: number; y: number } {
    const placed = canvas === this.hits ? this.owners.menu ?? this.primary : canvas;
    return this.origins.get(placed) ?? { x: 0, y: 0 };
  }

  frame(frame: DiscordWebFrame): void {
    const context = this.backingContext;
    if (!context || frame.pixels.length !== frame.patchWidth * frame.patchHeight * 4) return;
    if (this.backing.width !== frame.width || this.backing.height !== frame.height) {
      this.backing.width = this.clean.width = frame.width;
      this.backing.height = this.clean.height = frame.height;
    }
    const image = new ImageData(frame.patchWidth, frame.patchHeight);
    image.data.set(frame.pixels);
    // BGRA to RGBA, four bytes at a time.
    const pixels = new Uint32Array(image.data.buffer);
    for (let index = 0; index < pixels.length; index++) {
      const value = pixels[index];
      pixels[index] = (value & 0xff00ff00) | ((value & 0xff) << 16) | ((value >>> 16) & 0xff);
    }
    context.putImageData(image, frame.x, frame.y);
    const covered = this.popups.length > 0;
    this.place(frame);
    this.servers = frame.servers;
    // Any popup on the page, even one not drawn yet, keeps the clean copy as it was.
    // Once the last closes, the whole picture is clean again, parts repainted meanwhile too.
    if (this.popups.length === 0) {
      if (covered) this.cleanContext?.drawImage(this.backing, 0, 0);
      else this.cleanContext?.drawImage(this.backing, frame.x, frame.y, frame.patchWidth, frame.patchHeight,
        frame.x, frame.y, frame.patchWidth, frame.patchHeight);
    }
    if (!this.painted) {
      this.painted = true;
      this.onFirstPaint();
    }
    this.scheduleDraw();
  }

  /** A popup belongs to the canvas the pointer was on when the first of its kind opened; one opened from a menu, to the menu's. */
  private place({ popups }: DiscordWebLayers): void {
    const pointed = (this.pointerOn === this.hits ? this.owners.menu : this.pointerOn) ?? this.primary;
    const menuOwner = this.owners.menu;
    for (const kind of ['menu', 'tooltip'] as const) {
      if (!popups.some(popup => popup.kind === kind)) this.owners[kind] = null;
      else this.owners[kind] ??= pointed;
    }
    this.popups = popups.map(popup => ({ popup, owner: this.owners[popup.kind] ?? this.primary }));
    // A closed menu hands the keyboard back to the part of Discord that opened it.
    if (!this.owners.menu && menuOwner && document.activeElement === this.hits) menuOwner.focus({ preventScroll: true });
    this.layer.hidden = !this.popups.some(({ popup }) => popup.shown);
  }

  /** Where Discord's server list is and how far it has scrolled, as of the latest picture. */
  serverList(): DiscordWebServerList | null {
    return this.servers;
  }

  /**
   * Lets `handler` take a wheel turn over a part of the page before it reaches
   * Discord: it tells whether it used it.
   */
  interceptWheel(handler: (canvas: HTMLCanvasElement, deltaY: number) => boolean): void {
    this.wheelFirst = handler;
  }

  cursor(electronName: string): void {
    const cursor = discordCursor(electronName);
    for (const canvas of this.canvases) if (canvas.style.cursor !== cursor) canvas.style.cursor = cursor;
  }

  /** How tall the page's latest picture is, in CSS px. */
  pictureHeight(): number {
    return this.backing.height / (window.devicePixelRatio || 1);
  }

  /** Forgets the page's picture, for a page that closed. */
  reset(): void {
    this.backing.width = this.clean.width = 0;
    this.backing.height = this.clean.height = 0;
    this.painted = false;
    this.pressed.clear();
    this.pendingMove = null;
    this.popups = [];
    this.servers = null;
    this.owners.menu = this.owners.tooltip = null;
    this.pointerOn = null;
    this.cancelFrames();
    for (const canvas of [...this.canvases, this.layer]) {
      canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
      canvas.style.cursor = '';
    }
    this.layer.hidden = true;
    this.syncHits();
  }

  cancelFrames(): void {
    if (this.drawFrame !== null) cancelAnimationFrame(this.drawFrame);
    if (this.moveFrame !== null) cancelAnimationFrame(this.moveFrame);
    this.drawFrame = null;
    this.moveFrame = null;
  }

  scheduleDraw(): void {
    if (this.drawFrame !== null) return;
    this.drawFrame = requestAnimationFrame(() => {
      this.drawFrame = null;
      this.draw();
    });
  }

  private draw(): void {
    const scale = window.devicePixelRatio || 1;
    for (const canvas of [...this.parts, this.layer]) {
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(0, Math.round(rect.width * scale)), height = Math.max(0, Math.round(rect.height * scale));
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context || width === 0 || height === 0) continue;
      context.imageSmoothingEnabled = false;
      context.clearRect(0, 0, width, height);
      if (this.backing.width === 0 || this.backing.height === 0) continue;
      if (canvas === this.layer) this.drawPopups(context, rect, scale);
      else this.drawPart(canvas, context, rect, scale);
    }
    this.syncHits();
  }

  private drawPart(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D, rect: DOMRect, scale: number): void {
    const origin = this.origin(canvas);
    const sourceX = Math.round((rect.left - origin.x) * scale), sourceY = Math.round((rect.top - origin.y) * scale);
    context.drawImage(this.backing, sourceX, sourceY, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
    // A popup opened elsewhere would show here torn or twice: this part shows the page as it was without it.
    for (const { popup, owner } of this.popups) {
      const at = this.origin(owner);
      if (at.x === origin.x && at.y === origin.y) continue;
      const box = devicePixels(popup, scale, POPUP_MARGIN);
      context.clearRect(box.x - sourceX, box.y - sourceY, box.width, box.height);
      context.drawImage(this.clean, box.x, box.y, box.width, box.height, box.x - sourceX, box.y - sourceY, box.width, box.height);
    }
  }

  /** Each shown popup, whole and with its round corners, beside the part of the page that opened it. */
  private drawPopups(context: CanvasRenderingContext2D, rect: DOMRect, scale: number): void {
    for (const { popup, owner } of this.popups) {
      if (!popup.shown) continue;
      const at = this.origin(owner);
      const box = devicePixels(popup, scale, 0);
      const x = Math.round((at.x - rect.left) * scale) + box.x, y = Math.round((at.y - rect.top) * scale) + box.y;
      context.save();
      context.beginPath();
      context.roundRect(x, y, box.width, box.height, popup.radius * scale);
      context.clip();
      context.drawImage(this.backing, box.x, box.y, box.width, box.height, x, y, box.width, box.height);
      context.restore();
    }
  }

  /** Over Monky's own screen, the pointer reaches Discord only on its open menus. */
  private syncHits(): void {
    const menus = this.popups.filter(({ popup }) => popup.kind === 'menu' && popup.shown);
    const clip = menus.map(({ popup, owner }) => {
      const at = this.origin(owner);
      return `M${at.x + popup.x} ${at.y + popup.y}h${popup.width}v${popup.height}h${-popup.width}Z`;
    }).join('');
    if (clip === this.hitsClip) return;
    this.hitsClip = clip;
    this.hits.style.clipPath = clip ? `path('${clip}')` : '';
    this.hits.hidden = clip === '';
  }

  /** Listens to the person on every canvas until `signal` aborts. */
  bind(signal: AbortSignal): void {
    for (const canvas of this.canvases) {
      const options = { signal };
      canvas.addEventListener('pointerdown', event => this.pointerDown(canvas, event), options);
      canvas.addEventListener('pointermove', event => this.pointerMove(canvas, event), options);
      canvas.addEventListener('pointerup', event => this.pointerUp(canvas, event), options);
      canvas.addEventListener('pointercancel', event => this.pointerLeave(canvas, event), options);
      canvas.addEventListener('pointerleave', event => {
        // Crossing into another canvas is still inside Discord's page.
        const into = event.relatedTarget;
        if (!canvas.hasPointerCapture(event.pointerId) && !(into instanceof HTMLCanvasElement && this.canvases.includes(into))) {
          this.pointerLeave(canvas, event);
        }
      }, options);
      canvas.addEventListener('wheel', event => this.wheel(canvas, event), { signal, passive: false });
      // Discord draws its own menus; Monky's must not open over them.
      canvas.addEventListener('contextmenu', event => { event.preventDefault(); event.stopPropagation(); }, options);
      canvas.addEventListener('keydown', event => this.keyDown(event), options);
      canvas.addEventListener('keyup', event => this.keyUp(event), options);
      canvas.addEventListener('blur', () => this.releaseKeys(), options);
    }
    // A part that grows or shrinks with Monky's frame is redrawn before that frame paints, never shown stretched.
    const resized = new ResizeObserver(() => {
      if (this.drawFrame !== null) cancelAnimationFrame(this.drawFrame);
      this.drawFrame = null;
      this.draw();
    });
    for (const canvas of [...this.parts, this.layer]) resized.observe(canvas);
    signal.addEventListener('abort', () => resized.disconnect(), { once: true });
    // Pressing anywhere else in Monky closes Discord's open menus, as a press beside them would in Discord.
    document.addEventListener('pointerdown', event => {
      if (!this.owners.menu || (event.target instanceof HTMLCanvasElement && this.canvases.includes(event.target))) return;
      this.key('down', 'Escape', []);
      this.key('up', 'Escape', []);
    }, { signal, capture: true });
  }

  private point(canvas: HTMLCanvasElement, event: MouseEvent): { x: number; y: number } {
    const origin = this.origin(canvas);
    return { x: event.clientX - origin.x, y: event.clientY - origin.y };
  }

  private pointerDown(canvas: HTMLCanvasElement, event: PointerEvent): void {
    this.pointerOn = canvas;
    const button = BUTTONS[event.button];
    if (!button) return;
    // No middle-button autoscroll or text selection in Monky itself.
    event.preventDefault();
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture(event.pointerId);
    this.flushMove();
    const { x, y } = this.point(canvas, event);
    const last = this.lastClick, now = performance.now();
    const repeat = last.button === button && now - last.time < DOUBLE_CLICK_MS
      && Math.abs(x - last.x) <= DOUBLE_CLICK_DISTANCE && Math.abs(y - last.y) <= DOUBLE_CLICK_DISTANCE;
    this.lastClick = { button, time: now, x, y, count: repeat ? Math.min(3, last.count + 1) : 1 };
    this.send({ action: 'mouse', type: 'down', x, y, button, clickCount: this.lastClick.count, modifiers: pointerModifiers(event) });
  }

  private pointerMove(canvas: HTMLCanvasElement, event: PointerEvent): void {
    this.pointerOn = canvas;
    const { x, y } = this.point(canvas, event);
    this.pendingMove = { action: 'mouse', type: 'move', x, y, modifiers: pointerModifiers(event) };
    this.moveFrame ??= requestAnimationFrame(() => {
      this.moveFrame = null;
      this.flushMove();
    });
  }

  private flushMove(): void {
    const move = this.pendingMove;
    this.pendingMove = null;
    if (move) this.send(move);
  }

  private pointerUp(canvas: HTMLCanvasElement, event: PointerEvent): void {
    const button = BUTTONS[event.button];
    if (!button) return;
    this.flushMove();
    const { x, y } = this.point(canvas, event);
    this.send({ action: 'mouse', type: 'up', x, y, button, clickCount: this.lastClick.count || 1, modifiers: pointerModifiers(event) });
  }

  private pointerLeave(canvas: HTMLCanvasElement, event: PointerEvent): void {
    this.flushMove();
    const { x, y } = this.point(canvas, event);
    this.send({ action: 'mouse', type: 'leave', x, y, modifiers: pointerModifiers(event) });
  }

  private wheel(canvas: HTMLCanvasElement, event: WheelEvent): void {
    event.preventDefault();
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? WHEEL_LINE
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? window.innerHeight : 1;
    const deltaX = clampWheel(event.deltaX * unit), deltaY = clampWheel(event.deltaY * unit);
    if (deltaX === 0 && this.wheelFirst?.(canvas, deltaY)) return;
    const { x, y } = this.point(canvas, event);
    this.send({ action: 'wheel', x, y, deltaX, deltaY, modifiers: pointerModifiers(event) });
  }

  private keyDown(event: KeyboardEvent): void {
    if (event.isComposing || event.key === 'Dead' || event.key === 'Process' || event.key === 'Unidentified') return;
    const special = SPECIAL_KEYS[event.key] ?? (/^F([1-9]|1[0-9]|2[0-4])$/.test(event.key) ? { keyCode: event.key } : undefined);
    const text = special ? null : typedText(event);
    const keyCode = special?.keyCode ?? (text ?? shortcutKey(event));
    // Shift, Control, Alt and Meta reach Discord as modifiers of the other keys.
    if (!special && !text && ['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'NumLock'].includes(event.key)) return;
    if (keyCode.length > 32) return;
    event.preventDefault();
    event.stopPropagation();
    const modifiers = keyModifiers(event);
    this.key('down', keyCode, modifiers);
    const typed = special?.text ?? text;
    if (typed && !((event.ctrlKey || event.metaKey) && !event.getModifierState('AltGraph'))) this.key('char', typed, modifiers);
    this.pressed.set(event.code || event.key, keyCode);
  }

  private keyUp(event: KeyboardEvent): void {
    const keyCode = this.pressed.get(event.code || event.key);
    if (!keyCode) return;
    this.pressed.delete(event.code || event.key);
    event.preventDefault();
    event.stopPropagation();
    this.key('up', keyCode, keyModifiers(event));
  }

  /** A key held when Monky's canvas lost focus would otherwise stay down inside Discord. */
  private releaseKeys(): void {
    for (const keyCode of this.pressed.values()) this.key('up', keyCode, []);
    this.pressed.clear();
  }

  private key(type: KeyCommand['type'], keyCode: string, modifiers: Modifier[]): void {
    this.send({ action: 'key', type, keyCode, modifiers });
  }
}
