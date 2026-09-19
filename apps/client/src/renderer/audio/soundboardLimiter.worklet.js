class Biquad {
  constructor(b0, b1, b2, a1, a2) {
    this.b0 = b0;
    this.b1 = b1;
    this.b2 = b2;
    this.a1 = a1;
    this.a2 = a2;
    this.s1 = 0;
    this.s2 = 0;
  }

  process(value) {
    const output = this.b0 * value + this.s1;
    this.s1 = this.b1 * value - this.a1 * output + this.s2;
    this.s2 = this.b2 * value - this.a2 * output;
    return output;
  }
}

function kWeighting() {
  // BS.1770 K weighting is used only by the detector, not on the audible signal.
  const shelfK = Math.tan(Math.PI * 1681.974450955533 / sampleRate);
  const shelfQ = 0.7071752369554196;
  const highGain = 10 ** (3.999843853973347 / 20);
  const middleGain = highGain ** 0.4996667741545416;
  const shelfA0 = 1 + shelfK / shelfQ + shelfK * shelfK;
  const shelf = new Biquad(
    (highGain + middleGain * shelfK / shelfQ + shelfK * shelfK) / shelfA0,
    2 * (shelfK * shelfK - highGain) / shelfA0,
    (highGain - middleGain * shelfK / shelfQ + shelfK * shelfK) / shelfA0,
    2 * (shelfK * shelfK - 1) / shelfA0,
    (1 - shelfK / shelfQ + shelfK * shelfK) / shelfA0,
  );
  const highPassK = Math.tan(Math.PI * 38.13547087602444 / sampleRate);
  const highPassQ = 0.5003270373238773;
  const highPassA0 = 1 + highPassK / highPassQ + highPassK * highPassK;
  const highPass = new Biquad(
    1, -2, 1,
    2 * (highPassK * highPassK - 1) / highPassA0,
    (1 - highPassK / highPassQ + highPassK * highPassK) / highPassA0,
  );
  return { shelf, highPass };
}

class SoundboardLimiter extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'enabled', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'limitLevel', defaultValue: 6, minValue: 1, maxValue: 10, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    // Short energy blocks catch brief clips too. Two blocks of look-ahead let
    // gain change smoothly before a loud onset; this is not an R128 meter.
    this.blockSize = Math.max(1, Math.round(sampleRate * 0.05));
    this.lookAhead = 2 * this.blockSize;
    this.fadeFrames = Math.max(1, Math.round(sampleRate * 0.005));
    this.samples = [new Float32Array(3 * this.blockSize), new Float32Array(3 * this.blockSize)];
    this.energy = new Float64Array(3);
    this.peaks = new Float64Array(3);
    this.filters = [kWeighting(), kWeighting()];
    this.writeBlock = 0;
    this.position = 0;
    this.blockEnergy = 0;
    this.blockPeak = 0;
    this.previousGain = 1;
    this.peakCeiling = 10 ** (-1 / 20);
    this.reportedInvalidSample = false;
  }

  blockGain(block, ceilingPower) {
    return Math.min(
      1,
      this.energy[block] > ceilingPower ? Math.sqrt(ceilingPower / this.energy[block]) : 1,
      this.peaks[block] > this.peakCeiling ? this.peakCeiling / this.peaks[block] : 1,
    );
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0] ?? [];
    const output = outputs[0];
    if (!output?.length) return true;
    const enabled = parameters.enabled[0] >= 0.5;
    // Levels 1..10 map to -33..-6 in K-weighted energy (6 is -18).
    const ceilingPower = 10 ** ((-36 + 3 * parameters.limitLevel[0] + 0.691) / 10);
    let readBlock = (this.writeBlock + 1) % 3;
    let currentGain = this.blockGain(readBlock, ceilingPower);
    let nextGain = this.blockGain((this.writeBlock + 2) % 3, ceilingPower);
    for (let sample = 0; sample < output[0].length; sample++) {
      const write = this.writeBlock * this.blockSize + this.position;
      for (let channel = 0; channel < 2; channel++) {
        let value = (input[channel] ?? input[0])?.[sample] ?? 0;
        if (!Number.isFinite(value)) {
          value = 0;
          if (!this.reportedInvalidSample) {
            this.port.postMessage('invalid-samples');
            this.reportedInvalidSample = true;
          }
        }
        this.samples[channel][write] = value;
        this.blockPeak = Math.max(this.blockPeak, Math.abs(value));
        const filter = this.filters[channel];
        const weighted = filter.highPass.process(filter.shelf.process(value));
        this.blockEnergy += weighted * weighted;
      }
      const read = enabled ? readBlock * this.blockSize + this.position : write;
      let gain = 1;
      if (enabled) {
        const rise = Math.min(1, this.position / this.fadeFrames);
        const fall = Math.min(1, (this.blockSize - 1 - this.position) / this.fadeFrames);
        gain = Math.min(currentGain,
          this.previousGain + (currentGain - this.previousGain) * rise,
          nextGain + (currentGain - nextGain) * fall);
      }
      for (let channel = 0; channel < output.length; channel++) {
        output[channel][sample] = this.samples[channel % 2][read] * gain;
      }
      if (++this.position === this.blockSize) {
        this.energy[this.writeBlock] = this.blockEnergy / this.blockSize;
        this.peaks[this.writeBlock] = this.blockPeak;
        // Report the unattenuated block currently leaving the buffer, not the
        // look-ahead block. Bypass has no delay. This emits at about 20 Hz.
        const meterBlock = enabled ? readBlock : this.writeBlock;
        const power = this.energy[meterBlock];
        const intensity = power > 0 ? Math.max(0, (-0.691 + 10 * Math.log10(power) + 36) / 3) : 0;
        this.port.postMessage({ type: 'intensity', value: intensity });
        this.blockEnergy = 0;
        this.blockPeak = 0;
        this.position = 0;
        this.previousGain = currentGain;
        this.writeBlock = (this.writeBlock + 1) % 3;
        readBlock = (this.writeBlock + 1) % 3;
        currentGain = this.blockGain(readBlock, ceilingPower);
        nextGain = this.blockGain((this.writeBlock + 2) % 3, ceilingPower);
      }
    }
    return true;
  }
}

registerProcessor('monky-soundboard-limiter', SoundboardLimiter);
