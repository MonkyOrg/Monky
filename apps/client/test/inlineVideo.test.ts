import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isShowingStream, onPresentedFrame, showInlineStream, type InlineVideo } from '../src/renderer/utils/inlineVideo';
import { FakeStream, FakeTrack } from './fakeMedia';

class FakeVideo implements InlineVideo {
  public muted = false;
  public autoplay = false;
  public playsInline = false;
  public isConnected = true;
  public readonly attributes = new Map<string, string>();
  /** Each stream the element was given, in order, as WebKit would load it. */
  public readonly loads: (MediaProvider | null)[] = [];
  public plays = 0;
  public refusePlay = false;
  private source: MediaProvider | null = null;
  get srcObject(): MediaProvider | null { return this.source; }
  set srcObject(value: MediaProvider | null) { this.source = value; this.loads.push(value); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  pause() {}
  async play() {
    this.plays++;
    if (this.refusePlay) throw new DOMException('Autoplay is blocked', 'NotAllowedError');
  }
}

test('a stream is shown inline and muted, marked before it is assigned', async () => {
  const video = new FakeVideo();
  const stream = new FakeStream([new FakeTrack('camera')]);
  await showInlineStream(video, stream);
  assert.equal(video.playsInline, true);
  assert.equal(video.muted, true);
  assert.equal(video.autoplay, true);
  assert.equal(video.attributes.get('playsinline'), '');
  assert.equal(video.srcObject, stream);
  assert.equal(video.plays, 1);
  assert.equal(isShowingStream(video, stream), true);
});

test('a stream that gained a track after it was shown is assigned again', async () => {
  const video = new FakeVideo();
  const stream = new FakeStream();
  await showInlineStream(video, stream);
  stream.addTrack(new FakeTrack('screen-preview'));
  assert.equal(isShowingStream(video, stream), false, 'WebKit keeps painting the empty stream');
  await showInlineStream(video, stream);
  assert.deepEqual(video.loads, [stream, null, stream]);
  assert.equal(isShowingStream(video, stream), true);
});

test('a blocked autoplay starts at the next touch instead of staying black', async (t) => {
  const page = new EventTarget();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: page });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'document', original);
    else Reflect.deleteProperty(globalThis, 'document');
  });
  const video = new FakeVideo();
  video.refusePlay = true;
  await showInlineStream(video, new FakeStream([new FakeTrack('camera')]));
  assert.equal(video.plays, 1);

  video.refusePlay = false;
  page.dispatchEvent(new Event('pointerdown'));
  await Promise.resolve();
  assert.equal(video.plays, 2);
  page.dispatchEvent(new Event('pointerdown'));
  assert.equal(video.plays, 2, 'the page stops listening once the picture plays');
});

test('a video that plays before decoding a frame is not taken as presented', () => {
  const video = Object.assign(new EventTarget(), { videoWidth: 0, videoHeight: 0 });
  const lifecycle = new AbortController();
  let presented = 0;
  onPresentedFrame(video, () => { presented++; }, lifecycle.signal);
  video.dispatchEvent(new Event('playing'));
  assert.equal(presented, 0);
  Object.assign(video, { videoWidth: 1170, videoHeight: 2532 });
  video.dispatchEvent(new Event('resize'));
  assert.equal(presented, 1);
  lifecycle.abort();
  video.dispatchEvent(new Event('playing'));
  assert.equal(presented, 1);
});
