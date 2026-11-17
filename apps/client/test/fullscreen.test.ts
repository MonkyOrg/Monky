import test from 'node:test';
import assert from 'node:assert/strict';
import { toggleFullscreen } from '../src/renderer/utils/fullscreen';
import { FakeStream } from './fakeMedia';

interface FakeDocument {
  fullscreenEnabled: boolean;
  fullscreenElement: object | null;
  exitFullscreen: () => Promise<void>;
}

function withDocument(fake: FakeDocument, run: () => Promise<void>): Promise<void> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { value: fake, configurable: true });
  return run().finally(() => {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
  });
}

function element(): { requested: number; requestFullscreen: () => Promise<void> } {
  const target = { requested: 0, requestFullscreen: async () => { target.requested += 1; } };
  return target;
}

/** An iPhone `<video>` showing a live stream, whose system player pauses it on closing. */
class SystemPlayerVideo extends EventTarget {
  public entered = 0;
  public plays = 0;
  public paused = false;
  public muted = true;
  public autoplay = true;
  public playsInline = true;
  public isConnected = true;
  public srcObject: MediaProvider | null = new FakeStream();
  setAttribute() {}
  pause() { this.paused = true; }
  async play() { this.plays += 1; this.paused = false; }
  webkitEnterFullscreen() { this.entered += 1; }
  closePlayer() { this.pause(); this.dispatchEvent(new Event('webkitendfullscreen')); }
}

function video(): SystemPlayerVideo {
  return new SystemPlayerVideo();
}

test('a browser with element fullscreen shows the whole card, and the same tap brings it back', async () => {
  const card = element();
  const player = video();
  const fake: FakeDocument = { fullscreenEnabled: true, fullscreenElement: null, exitFullscreen: async () => { fake.fullscreenElement = null; } };
  await withDocument(fake, async () => {
    assert.equal(await toggleFullscreen(card, player), true);
    assert.equal(card.requested, 1);
    assert.equal(player.entered, 0);
    fake.fullscreenElement = card;
    assert.equal(await toggleFullscreen(card, player), true);
    assert.equal(fake.fullscreenElement, null);
  });
});

test('Safari on the iPhone, without element fullscreen, opens the video in the system player instead', async () => {
  const card = element();
  const player = video();
  await withDocument({ fullscreenEnabled: false, fullscreenElement: null, exitFullscreen: async () => {} }, async () => {
    assert.equal(await toggleFullscreen(card, player), true);
    assert.equal(player.entered, 1);
    assert.equal(card.requested, 0);
  });
});

test('without element fullscreen nor a video, the caller learns it could not go fullscreen', async () => {
  await withDocument({ fullscreenEnabled: false, fullscreenElement: null, exitFullscreen: async () => {} }, async () => {
    assert.equal(await toggleFullscreen(element(), null), false);
  });
});

test('closing the iPhone system player plays the live stream on in its tile instead of freezing it', async () => {
  const player = video();
  await withDocument({ fullscreenEnabled: false, fullscreenElement: null, exitFullscreen: async () => {} }, async () => {
    await toggleFullscreen(element(), player);
    player.closePlayer();
    await Promise.resolve();
    assert.equal(player.plays, 1);
    assert.equal(player.paused, false);
    // A later close, after the tile was paused on purpose, is not this fullscreen's.
    player.closePlayer();
    await Promise.resolve();
    assert.equal(player.plays, 1);
  });
});
