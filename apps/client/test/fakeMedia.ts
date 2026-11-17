/** A live video track whose settings report `facingMode` when given one. */
export class FakeTrack extends EventTarget implements MediaStreamTrack {
  public contentHint = '';
  public enabled = true;
  public readonly kind = 'video';
  public readonly label = 'camera';
  public readonly muted = false;
  public onended: MediaStreamTrack['onended'] = null;
  public onmute: MediaStreamTrack['onmute'] = null;
  public onunmute: MediaStreamTrack['onunmute'] = null;
  public readyState: MediaStreamTrackState = 'live';
  constructor(public readonly id: string, private readonly facing?: string) { super(); }
  async applyConstraints() {}
  clone(): MediaStreamTrack { return new FakeTrack(`${this.id}-clone`, this.facing); }
  getCapabilities(): MediaTrackCapabilities { return {}; }
  getConstraints(): MediaTrackConstraints { return {}; }
  getSettings(): MediaTrackSettings { return this.facing ? { facingMode: this.facing } : {}; }
  stop() { this.readyState = 'ended'; }
}

export class FakeStream extends EventTarget implements MediaStream {
  public readonly active = true;
  public readonly id = 'stream';
  public onaddtrack: MediaStream['onaddtrack'] = null;
  public onremovetrack: MediaStream['onremovetrack'] = null;
  private readonly tracks: MediaStreamTrack[];
  constructor(tracks: MediaStreamTrack[] = []) { super(); this.tracks = [...tracks]; }
  clone(): MediaStream { return new FakeStream(this.tracks.map(entry => entry.clone())); }
  getTracks() { return [...this.tracks]; }
  getVideoTracks() { return this.tracks.filter((entry): entry is MediaStreamVideoTrack => entry.kind === 'video'); }
  getAudioTracks() { return this.tracks.filter((entry): entry is MediaStreamAudioTrack => entry.kind === 'audio'); }
  getTrackById(id: string) { return this.tracks.find(entry => entry.id === id) ?? null; }
  addTrack(track: MediaStreamTrack) { this.tracks.push(track); }
  removeTrack(track: MediaStreamTrack) { this.tracks.splice(this.tracks.indexOf(track), 1); }
}
