// Chromium exposes encoding.codec before the DOM typings used by the client.
export interface CodecSendParameters extends RTCRtpSendParameters {
  encodings: (RTCRtpEncodingParameters & { codec?: RTCRtpCodec })[];
}

type ParameterTarget = Pick<RTCRtpSender, 'getParameters' | 'setParameters'>;
const pendingUpdates = new WeakMap<ParameterTarget, Promise<void>>();

/** Serialize the whole read/modify/write transaction, including codec and quality updates. */
export async function updateRtpSenderParameters(
  sender: ParameterTarget,
  update: (parameters: CodecSendParameters) => boolean,
  verify?: (parameters: CodecSendParameters) => void,
): Promise<void> {
  const previous = pendingUpdates.get(sender) ?? Promise.resolve();
  const task = previous.then(async () => {
    const parameters: CodecSendParameters = sender.getParameters();
    if (!update(parameters)) return;
    await sender.setParameters(parameters);
    verify?.(sender.getParameters());
  });
  // Failure belongs to the caller; it must not poison subsequent transactions.
  const settled = task.then(() => {}, () => {});
  pendingUpdates.set(sender, settled);
  try {
    await task;
  } finally {
    if (pendingUpdates.get(sender) === settled) pendingUpdates.delete(sender);
  }
}
