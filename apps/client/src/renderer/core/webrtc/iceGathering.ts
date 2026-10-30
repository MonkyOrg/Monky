/** What waitForIceGatheringComplete reads from a connection: a real RTCPeerConnection or a test double. */
export interface IceGatheringTarget {
  readonly iceGatheringState: RTCIceGatheringState;
  addEventListener(type: 'icegatheringstatechange', listener: () => void): void;
  removeEventListener(type: 'icegatheringstatechange', listener: () => void): void;
}

/**
 * Resolves once `connection` has gathered all of its ICE candidates, or after
 * `timeoutMs`, whichever comes first, so the description sent afterwards
 * already carries the candidates. The overlay's local link only gathers host
 * candidates, which arrive almost at once; the timeout keeps a missing
 * `complete` from stalling the negotiation. The listener and the timer are
 * released either way (R-MEDIA-2).
 */
export function waitForIceGatheringComplete(connection: IceGatheringTarget, timeoutMs: number): Promise<void> {
  if (connection.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      connection.removeEventListener('icegatheringstatechange', onChange);
      resolve();
    };
    const onChange = () => {
      if (connection.iceGatheringState === 'complete') finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    connection.addEventListener('icegatheringstatechange', onChange);
  });
}
