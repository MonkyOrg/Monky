// Records what a conversation feed (src/renderer/views/chat/MessageFeed.ts) did, so that a
// check about where the feed rests can say why it failed, from the CI log alone (#490):
// the feed's state now (the automatic scroll on its way, following, the end it last pinned,
// the reveal window, where it last looked) and the last steps that led there (pins, the
// scroll and scrollend events, landings, resizes of the feed, the reader's input).
//
// It runs in the page: inject its source (`${recordFeed}`) and call it with the feed. It
// reads the feed's private fields and wraps a few of its methods only to note their calls;
// it never changes what the feed does. `frame` is the time of the last animation frame
// (document.timeline): steps sharing it happened before the same next frame, which tells
// a pin and a scroll of the reader in the same frame apart from ones a frame apart.
function recordFeed(list, limit = 40) {
  // One recorder per feed: recording it again returns the one already listening.
  const own = Symbol.for('monky.feedRecorder');
  if (list[own]) return list[own];
  const element = list.element;
  const start = performance.now();
  const trail = [];
  const round = value => Math.round(value * 10) / 10;
  const remaining = until => (until > performance.now() ? Math.round(until - performance.now()) : 0);
  const where = () => ({
    top: round(element.scrollTop),
    left: round(element.scrollHeight - element.clientHeight - element.scrollTop),
    view: element.clientHeight,
    following: list.following,
    flight: remaining(list.autoScrollUntil),
    reveal: remaining(list.revealingUntil),
  });
  const note = (step, extra = {}) => {
    trail.push({ t: Math.round(performance.now() - start), frame: Math.round(document.timeline.currentTime ?? -1), step, ...where(), ...extra });
    if (trail.length > limit) trail.shift();
  };
  // Calls that move the view or decide the following, with where the view was before them.
  for (const name of ['scrollToEnd', 'pinToEnd', 'land', 'stopFlight', 'jumpTo', 'restoreAnchor']) {
    const original = list[name];
    if (typeof original !== 'function') continue;
    list[name] = function (...args) {
      const from = round(element.scrollTop);
      const result = original.apply(this, args);
      note(name, { from, ...(name === 'pinToEnd' ? { pinned: round(list.pinnedEnd), revealMotion: args[0] } : {}),
        ...(name === 'scrollToEnd' ? { asked: args[0] ?? {} } : {}) });
      return result;
    };
  }
  // After the feed's own listeners and observer, so each step shows what the feed made of it.
  element.addEventListener('scroll', () => note('scroll'), { passive: true });
  element.addEventListener('scrollend', () => note('scrollend'));
  const resize = new ResizeObserver(() => note('resize'));
  resize.observe(element);
  for (const type of ['keydown', 'wheel', 'pointerdown']) {
    window.addEventListener(type, event => note(`input ${type}`, event.key ? { key: event.key } : {}), { capture: true, passive: true });
  }
  return list[own] = {
    dump: () => ({
      now: {
        t: Math.round(performance.now() - start), frame: Math.round(document.timeline.currentTime ?? -1), ...where(),
        scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, drift: list.drift,
        seenTop: round(list.seenTop), seenEnd: round(list.seenEnd), seenEntry: list.seenEntry ?? null, pinnedEnd: round(list.pinnedEnd),
      },
      trail: trail.slice(),
    }),
  };
}

module.exports = { recordFeed };
