'use strict';

async function boundedCleanup(promise, description, timeoutMs = 5000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(description)), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

class VideoFrameSink {
  constructor() {
    this.stopping = false;
    this.writer = null;
    this.writeInFlight = null;
    this.writerBusy = false;
    this.pendingFrame = null;
    this.writerError = null;
    this.errors = [];
    this.framesSubmitted = 0;
    this.bridgeBusyDrops = 0;
    this.lastSourceTimestampUs = null;
  }

  discardPendingFrame() {
    if (!this.pendingFrame) return;
    this.pendingFrame.frame.close();
    this.pendingFrame.resolve(false);
    this.pendingFrame = null;
  }

  stopAccepting() {
    this.stopping = true;
    this.discardPendingFrame();
  }

  async acceptFrame(frame, timestampUs) {
    if (!this.writer || this.stopping) {
      frame.close();
      return false;
    }
    if (!Number.isSafeInteger(timestampUs) || timestampUs < 0
      || (this.lastSourceTimestampUs !== null && timestampUs <= this.lastSourceTimestampUs)) {
      frame.close();
      throw new Error('Non-monotonic native capture timestamp.');
    }
    this.lastSourceTimestampUs = timestampUs;
    let stamped;
    try {
      // NV12 already carries its import timestamp; RGB needs opaque alpha metadata.
      stamped = frame.format === 'NV12' && frame.timestamp === timestampUs
        ? frame : new VideoFrame(frame, { timestamp: timestampUs, alpha: 'discard' });
    } finally {
      if (stamped !== frame) frame.close();
    }
    return this.queueFrame(stamped);
  }

  queueFrame(frame) {
    if (this.stopping || !this.writer) {
      frame.close();
      return Promise.resolve(false);
    }
    if (this.writerError) {
      frame.close();
      return Promise.reject(this.writerError);
    }
    return new Promise((resolve, reject) => {
      if (this.pendingFrame) {
        this.pendingFrame.frame.close();
        this.pendingFrame.resolve(false);
        this.bridgeBusyDrops++;
      }
      // One in-flight write and one newest pending frame bound latency and leases.
      this.pendingFrame = { frame, resolve, reject };
      if (!this.writerBusy) {
        this.writerBusy = true;
        this.writeInFlight = this.drainFrames();
      }
    });
  }

  async drainFrames() {
    try {
      while (this.pendingFrame && !this.stopping) {
        const entry = this.pendingFrame;
        this.pendingFrame = null;
        try {
          await this.writer.write(entry.frame);
          this.framesSubmitted++;
          entry.resolve(true);
        } catch (error) {
          if (this.stopping && error === 'pipeline-stopped') entry.resolve(false);
          else {
            this.writerError = error;
            this.errors.push(error instanceof Error ? error.message : String(error));
            entry.reject(error);
            if (this.pendingFrame) {
              this.pendingFrame.frame.close();
              this.pendingFrame.reject(error);
              this.pendingFrame = null;
            }
          }
          break;
        } finally {
          entry.frame.close();
        }
      }
    } finally {
      this.writerBusy = false;
      this.writeInFlight = null;
    }
  }
}

module.exports = { VideoFrameSink, boundedCleanup };
