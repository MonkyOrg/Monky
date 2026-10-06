const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'audio', 'soundboardLimiter.worklet.js'), 'utf8');

function processor(sampleRate = 48000) {
  let Processor;
  const notices = [];
  vm.runInNewContext(code, {
    sampleRate,
    AudioWorkletProcessor: class {
      constructor() { this.port = { postMessage: message => notices.push(message) }; }
    },
    registerProcessor(name, type) {
      assert.equal(name, 'monky-soundboard-limiter');
      Processor = type;
    },
  });
  assert.ok(Processor);
  return { node: new Processor(), descriptors: Processor.parameterDescriptors, notices };
}

function render(node, channels, parameters) {
  const length = channels[0].length;
  const result = channels.map(() => new Float32Array(length));
  for (let start = 0; start < length; start += 128) {
    const end = Math.min(length, start + 128);
    const input = channels.map(channel => channel.subarray(start, end));
    const output = channels.map(() => new Float32Array(end - start));
    const values = typeof parameters === 'function' ? parameters(start) : parameters;
    assert.equal(node.process([input], [output], {
      enabled: new Float32Array([values.enabled ? 1 : 0]),
      limitLevel: new Float32Array([values.limitLevel]),
    }), true);
    output.forEach((channel, index) => result[index].set(channel, start));
  }
  return result;
}

function peak(values) {
  let maximum = 0;
  for (const sample of values) {
    assert.ok(Number.isFinite(sample), 'all rendered samples must be finite');
    maximum = Math.max(maximum, Math.abs(sample));
  }
  return maximum;
}

function tone(rate, amplitude, seconds = 0.5) {
  return Float32Array.from({ length: Math.ceil(rate * (seconds + 0.15)) },
    (_, index) => index < rate * seconds ? Math.sin(2 * Math.PI * 1000 * index / rate) * amplitude : 0);
}

function rms(values) {
  let power = 0;
  for (const sample of values) power += sample * sample;
  return Math.sqrt(power / values.length);
}

function referenceLoudness(left, right, start, end) {
  // Independent 48 kHz reference coefficients from BS.1770.
  const filter = (input, b, a) => {
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    return Float64Array.from(input, x => {
      const y = b[0] * x + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      return y;
    });
  };
  let power = 0;
  for (const channel of [left, right]) {
    const shelf = filter(channel,
      [1.53512485958697, -2.69169618940638, 1.19839281085285], [1, -1.69065929318241, 0.73248077421585]);
    const weighted = filter(shelf, [1, -2, 1], [1, -1.99004745483398, 0.99007225036621]);
    for (let index = start; index < end; index++) power += weighted[index] ** 2;
  }
  return -0.691 + 10 * Math.log10(power / (end - start));
}

test('limiting is disabled by default and bypasses audio without attenuation or delay', () => {
  for (const rate of [44100, 48000, 96000]) {
    const { node, descriptors } = processor(rate);
    assert.equal(descriptors.find(parameter => parameter.name === 'enabled').defaultValue, 0);
    const left = Float32Array.from({ length: 2048 }, (_, index) => Math.sin(index / 9) * 2.5);
    const right = Float32Array.from(left, value => -value / 3);
    assert.equal(descriptors.find(parameter => parameter.name === 'limitLevel').defaultValue, 6);
    const output = render(node, [left, right], { enabled: false, limitLevel: 1 });
    assert.deepEqual(output[0], left);
    assert.deepEqual(output[1], right);
  }
});

test('loudness limiting retains separate linked peak protection at common sample rates', () => {
  for (const rate of [44100, 48000, 96000]) {
    for (const limitLevel of [1, 3, 6, 10]) {
      const { node } = processor(rate);
      const length = rate / 2 + node.lookAhead;
      const left = Float32Array.from({ length }, (_, index) => index >= rate / 2 ? 0
        : index % 119 === 0 ? -7 : 1.6 * Math.sin(index / 7) + 0.9 * Math.sin(index / 13));
      const right = Float32Array.from(left, value => value / 4);
      const [limitedLeft, limitedRight] = render(node, [left, right], { enabled: true, limitLevel });
      const ceiling = 10 ** (-1 / 20);
      const maximum = peak(limitedLeft);
      assert.ok(maximum <= ceiling + 1e-7, `${rate} Hz/level ${limitLevel}: measured ${maximum}, allowed ${ceiling}`);
      assert.ok(maximum > 0, 'silencing must not pass as limiting');
      for (let index = 0; index < limitedLeft.length; index++) {
        assert.ok(Math.abs(limitedRight[index] - limitedLeft[index] / 4) < 1e-7, 'stereo channels share gain');
      }
    }
  }
});

test('sounds below the ceiling are unchanged, never amplified, apart from bounded look-ahead', () => {
  for (const rate of [44100, 48000, 96000]) {
    for (const amplitude of [0.001, 0.03, 0.08]) {
      const { node } = processor(rate);
      const input = tone(rate, amplitude);
      const [output] = render(node, [input, input], { enabled: true, limitLevel: 6 });
      assert.ok(node.lookAhead / rate <= 0.101);
      for (let index = 0; index < node.lookAhead; index++) assert.equal(output[index], 0);
      for (let index = node.lookAhead; index < output.length; index++) {
        assert.equal(output[index], input[index - node.lookAhead]);
      }
    }
  }
});

test('higher-intensity audio converges to the selected loudness, not to a sample-peak proxy', () => {
  for (const rate of [44100, 48000, 96000]) {
    for (const limitLevel of [1, 3, 6, 10]) {
      const { node } = processor(rate);
      const input = tone(rate, 0.8);
      const [output] = render(node, [input, input], { enabled: true, limitLevel });
      const measured = 20 * Math.log10(Math.SQRT2 * rms(output.subarray(rate * 0.2, rate * 0.4)));
      const target = -36 + 3 * limitLevel;
      assert.ok(Math.abs(measured - target) < 0.15,
        `${rate} Hz, level ${limitLevel}: measured 1 kHz level ${measured}, target ${target}`);
      if (rate === 48000) {
        const weighted = referenceLoudness(output, output, 9600, 19200);
        assert.ok(Math.abs(weighted - target) < 0.02, `Independent loudness measurement: ${weighted}, target ${target}`);
      }
    }
  }
});

test('the same peak can be preserved in a sparse sound and reduced in a sustained loud sound', () => {
  const sparseNode = processor().node;
  const loudNode = processor().node;
  const loud = tone(48000, 0.3);
  const sparse = Float32Array.from(loud, (value, index) => index % 2400 < 48 ? value : 0);
  assert.equal(peak(sparse), peak(loud));
  const [quietOutput] = render(sparseNode, [sparse, sparse], { enabled: true, limitLevel: 6 });
  const [loudOutput] = render(loudNode, [loud, loud], { enabled: true, limitLevel: 6 });
  assert.equal(peak(quietOutput), peak(sparse));
  for (let index = sparseNode.lookAhead; index < quietOutput.length; index++) {
    assert.equal(quietOutput[index], sparse[index - sparseNode.lookAhead]);
  }
  assert.ok(peak(loudOutput) < peak(loud) / 2);
});

test('level-five and level-six signals stay normal while level-ten is reduced to six', () => {
  const calibration = referenceLoudness(tone(48000, 1), tone(48000, 1), 4800, 19200);
  for (const inputLevel of [5, 6, 10]) {
    const input = tone(48000, 10 ** ((-36 + 3 * inputLevel - calibration - 0.01) / 20));
    const { node } = processor();
    const [output] = render(node, [input, input], { enabled: true, limitLevel: 6 });
    const actual = referenceLoudness(output, output, 9600, 19200);
    const expected = -36 + 3 * Math.min(inputLevel, 6);
    assert.ok(Math.abs(actual - expected) < 0.03, `Input ${inputLevel}: ${actual}, expected ${expected}`);
    if (inputLevel <= 6) {
      for (let index = 9600; index < 19200; index++) assert.equal(output[index], input[index - node.lookAhead]);
    }
  }
});

test('a loud onset after silence is controlled before its first audible samples', () => {
  const { node } = processor();
  const input = tone(48000, 0.8);
  input.fill(0, 0, 12000);
  const [output] = render(node, [input, input], { enabled: true, limitLevel: 6 });
  const onset = 12000 + node.lookAhead;
  assert.ok(peak(output.subarray(onset, onset + 480)) < 0.13);
  assert.ok(rms(output.subarray(onset, onset + 480)) > 0.08, 'must attenuate, not drop the onset');
});

test('very short effects and their final samples survive the analysis buffer', () => {
  for (const seconds of [0.001, 0.02, 0.05, 0.073]) {
    const { node } = processor();
    const input = tone(48000, 0.01, seconds);
    const [output] = render(node, [input, input], { enabled: true, limitLevel: 6 });
    assert.ok(peak(output) > 0);
    for (let index = node.lookAhead; index < output.length; index++) {
      assert.equal(output[index], input[index - node.lookAhead]);
    }
  }
});

test('lowering the ceiling mid-playback applies immediately and disabling restores exact bypass', () => {
  const { node } = processor();
  const input = tone(48000, 0.8, 1);
  const [output] = render(node, [input, input], start => ({
    enabled: start < 32768,
    limitLevel: start < 16384 ? 10 : 3,
  }));
  assert.ok(peak(output.subarray(16384, 32768)) < 0.046);
  assert.deepEqual(output.subarray(32768), input.subarray(32768));
});

test('invalid decoder samples are silenced and reported once, without contaminating later audio', () => {
  const { node, notices } = processor();
  const input = new Float32Array(12000);
  input.set([NaN, Infinity, -Infinity, 1]);
  const [output] = render(node, [input, input], { enabled: true, limitLevel: 6 });
  assert.ok(peak(output) > 0);
  assert.deepEqual(notices.filter(notice => typeof notice === 'string'), ['invalid-samples']);
});

test('live intensity uses the same scale before attenuation, not the selected ceiling', () => {
  for (const limitLevel of [1, 6, 10]) {
    const { node, notices } = processor();
    const input = tone(48000, 0.8);
    render(node, [input, input], { enabled: true, limitLevel });
    const reports = notices.filter(notice => notice.type === 'intensity');
    assert.equal(reports.length, 13, '50 ms blocks keep telemetry bounded at 20 Hz');
    const measured = reports[7].value;
    const expected = (referenceLoudness(input, input, 4800, 19200) + 36) / 3;
    assert.ok(Math.abs(measured - expected) < 0.01);
    assert.ok(measured > 10, 'over-range audio is not silently clamped to the slider maximum');
    for (const report of reports) assert.ok(Number.isFinite(report.value) && report.value >= 0);
  }
});

test('intensity follows actual playback timing in both buffered and bypass modes', () => {
  for (const enabled of [false, true]) {
    for (const rate of [44100, 48000, 96000]) {
      const { node, notices } = processor(rate);
      const input = tone(rate, 0.3, 0.05);
      render(node, [input, input], { enabled, limitLevel: 6 });
      const reports = notices.filter(notice => notice.type === 'intensity');
      const initialEmptyBlocks = enabled ? 2 : 0;
      for (let index = 0; index < initialEmptyBlocks; index++) assert.equal(reports[index].value, 0);
      assert.ok(reports[initialEmptyBlocks].value > 7, 'the current audible block, not future look-ahead, drives the meter');
    }
  }
});

test('silence reports zero intensity and cannot retain a stale high reading', () => {
  const { node, notices } = processor();
  const input = tone(48000, 0.8, 0.05);
  const silence = new Float32Array(48000);
  render(node, [input, input], { enabled: true, limitLevel: 6 });
  render(node, [silence, silence], { enabled: true, limitLevel: 6 });
  assert.equal(notices.at(-1).value, 0);
});
