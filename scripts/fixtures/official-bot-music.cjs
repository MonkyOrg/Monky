const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { YouTubeSource } = require(path.join(path.dirname(process.argv[1]), 'music', 'source.js'));
const { MusicError, SourceRecoveryError } = require(path.join(path.dirname(process.argv[1]), 'music', 'errors.js'));

const recordings = [
  { query: 'monky-e2e-original', id: 'e2eSilent00', title: 'Locally generated silence for the official music bot' },
  { query: 'monky-e2e-failure', id: 'e2eFailure0', title: 'Controlled mid-track failure for the official music bot' },
  { query: 'monky-e2e-recovery-failure', id: 'e2eRecover0', title: 'Controlled exhausted recovery for the official music bot' },
];
const resolve = YouTubeSource.prototype.resolve;
const open = YouTubeSource.prototype.open;

// Only the E2E child loads this fixture; no provider or copyrighted audio is fetched.
YouTubeSource.prototype.check = async () => {};
YouTubeSource.prototype.resolve = async function (query, signal) {
  const recording = recordings.find(item => item.query === query || query === `https://www.youtube.com/watch?v=${item.id}`);
  if (!recording) return resolve.call(this, query, signal);
  return { ...recording, url: `https://www.youtube.com/watch?v=${recording.id}`, audioUrl: '', duration: 2 };
};
YouTubeSource.prototype.open = async function (track, signal, options) {
  if (!recordings.some(item => item.id === track.id)) return open.call(this, track, signal, options);
  if (options?.mode !== 'persistent' || options.progress !== 'playback' || 'onRecovery' in options) {
    throw new Error('The production music queue must enable playback-clocked silent recovery.');
  }
  return {
    recoveryMode: 'persistent',
    frames: (async function* () {
      for (let i = 0; i < 100 && !signal.aborted; i++) {
        if (track.id === 'e2eFailure0' && i === 25) {
          throw new MusicError('unavailable', 'Controlled decoder failure: https://private.example.test/?secret=token');
        }
        if (track.id === 'e2eRecover0' && i === 25) throw new SourceRecoveryError();
        if (track.id === 'e2eSilent00' && i === 40) {
          await delay(120, undefined, { signal });
        }
        yield Buffer.from([0xf8, 0xff, 0xfe]);
      }
    })(),
    close: async () => {},
  };
};
