/**
 * Volume control of a miniapp document, installed before the bot's own scripts.
 *
 * Electron has no per-frame volume, so the isolated document scales its own
 * output: `<audio>`/`<video>` (which the browser caps at 100%) and the Web Audio
 * destination of live contexts (which can be amplified up to 200%). The source
 * is serialized into the miniapp, so it must stay self-contained: no imports or
 * module-level references. Returns the setter for the live volume (0 to 2).
 */
export function installMiniappVolume(scope: Window & typeof globalThis, initial: number): (volume: number) => void {
  const media = scope.HTMLMediaElement.prototype;
  const nodes = scope.AudioNode.prototype;
  const property = Object.getOwnPropertyDescriptor(media, 'volume');
  const readVolume = property?.get;
  const writeVolume = property?.set;
  if (!property || !readVolume || !writeVolume) throw new Error('HTMLMediaElement volume is unavailable.');
  const nativePlay = media.play;
  const nativeConnect = nodes.connect;
  const nativeDisconnect = nodes.disconnect;
  const createGain = scope.BaseAudioContext.prototype.createGain;
  // Validates assignments exactly like the native setter without touching the target.
  const probe = scope.document.createElement('audio');
  const clamp = (value: number, fallback: number): number =>
    Number.isFinite(value) ? Math.min(2, Math.max(0, value)) : fallback;
  let level = clamp(initial, 1);
  // The miniapp keeps reading the volume it chose; only what reaches the speakers changes.
  const chosen = new WeakMap<HTMLMediaElement, number>();
  // What this control last wrote, to recognize changes made without the accessor.
  const written = new WeakMap<HTMLMediaElement, number>();
  const graphed = new WeakSet<HTMLMediaElement>();
  const outputs = new WeakMap<AudioContext, GainNode>();
  const elements = new Set<WeakRef<HTMLMediaElement>>();
  const gains = new Set<WeakRef<GainNode>>();
  const released = new FinalizationRegistry<() => void>((forget) => forget());
  const track = <T extends object>(refs: Set<WeakRef<T>>, target: T): void => {
    const ref = new WeakRef(target);
    refs.add(ref);
    released.register(target, () => refs.delete(ref));
  };
  const read = (element: HTMLMediaElement): number => Number(Reflect.apply(readVolume, element, []));
  const adopt = (element: HTMLMediaElement): number => {
    let value = chosen.get(element);
    if (value === undefined) {
      value = read(element);
      chosen.set(element, value);
      track(elements, element);
    }
    return value;
  };
  const apply = (element: HTMLMediaElement): void => {
    const value = adopt(element);
    // Media routed into Web Audio is scaled once, by its context output.
    const output = graphed.has(element) ? value : Math.min(1, value * level);
    written.set(element, output);
    Reflect.apply(writeVolume, element, [output]);
  };
  const liveOutput = (target: unknown, create: boolean): GainNode | undefined => {
    if (!(target instanceof scope.AudioDestinationNode)) return undefined;
    const context = target.context;
    // Offline rendering produces data, not sound, so it keeps the app's own levels.
    if (!(context instanceof scope.AudioContext)) return undefined;
    let output = outputs.get(context);
    if (!output && create) {
      output = createGain.call(context);
      output.gain.value = level;
      Reflect.apply(nativeConnect, output, [target]);
      outputs.set(context, output);
      track(gains, output);
    }
    return output;
  };

  Object.defineProperty(media, 'volume', {
    configurable: true,
    enumerable: property.enumerable,
    get(this: HTMLMediaElement): number {
      return chosen.get(this) ?? read(this);
    },
    set(this: HTMLMediaElement, value: number): void {
      read(this); // Rejects foreign receivers like the native accessor.
      Reflect.apply(writeVolume, probe, [value]);
      if (!chosen.has(this)) track(elements, this);
      chosen.set(this, read(probe));
      apply(this);
    },
  });
  Object.defineProperty(media, 'play', {
    configurable: true, enumerable: true, writable: true,
    value: function play(this: HTMLMediaElement): Promise<void> {
      apply(this);
      return Reflect.apply(nativePlay, this, []);
    },
  });
  Object.defineProperty(nodes, 'connect', {
    configurable: true, enumerable: true, writable: true,
    value: function connect(this: AudioNode, ...args: unknown[]): unknown {
      if (this instanceof scope.MediaElementAudioSourceNode && !graphed.has(this.mediaElement)) {
        graphed.add(this.mediaElement);
        apply(this.mediaElement);
      }
      const output = liveOutput(args[0], true);
      if (!output) return Reflect.apply(nativeConnect, this, args);
      Reflect.apply(nativeConnect, this, [output, ...args.slice(1)]);
      // Chaining still receives the destination the app asked for.
      return args[0];
    },
  });
  Object.defineProperty(nodes, 'disconnect', {
    configurable: true, enumerable: true, writable: true,
    value: function disconnect(this: AudioNode, ...args: unknown[]): unknown {
      const output = liveOutput(args[0], false);
      return Reflect.apply(nativeDisconnect, this, output ? [output, ...args.slice(1)] : args);
    },
  });
  // Elements in the document can start by themselves (autoplay, native controls).
  const adoptPlayback = (event: Event): void => {
    if (event.target instanceof scope.HTMLMediaElement) apply(event.target);
  };
  scope.addEventListener('loadstart', adoptPlayback, true);
  scope.addEventListener('play', adoptPlayback, true);
  // Native media controls set the volume in the browser, bypassing the accessor. Take
  // their value as the new choice, so playback never restores an older one and a
  // muted tile stays silent.
  scope.addEventListener('volumechange', (event: Event): void => {
    const element = event.target;
    if (!(element instanceof scope.HTMLMediaElement) || !chosen.has(element)) return;
    const output = read(element);
    if (output === written.get(element)) return;
    chosen.set(element, graphed.has(element) || level === 0 ? output : Math.min(1, output / level));
    apply(element);
  }, true);

  return (volume: number): void => {
    const next = clamp(volume, level);
    if (next === level) return;
    level = next;
    for (const ref of gains) {
      const gain = ref.deref();
      if (gain) gain.gain.value = level;
    }
    for (const ref of elements) {
      const element = ref.deref();
      if (element) apply(element);
    }
  };
}
