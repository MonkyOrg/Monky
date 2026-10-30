'use strict';

/**
 * Writes frames to a track writer with at most one write in flight and only the
 * newest pending frame kept. Subclasses admit frames through queueFrame().
 */
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

module.exports = { VideoFrameSink };
