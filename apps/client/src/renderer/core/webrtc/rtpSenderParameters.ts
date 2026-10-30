type ParameterTarget = Pick<RTCRtpSender, 'getParameters' | 'setParameters'>;
const pendingUpdates = new WeakMap<ParameterTarget, Promise<void>>();

/** Serialize the whole read/modify/write transaction so overlapping updates never overwrite each other. */
export async function updateRtpSenderParameters(
  sender: ParameterTarget,
  update: (parameters: RTCRtpSendParameters) => boolean,
): Promise<void> {
  const previous = pendingUpdates.get(sender) ?? Promise.resolve();
  const task = previous.then(async () => {
    const parameters = sender.getParameters();
    if (!update(parameters)) return;
    await sender.setParameters(parameters);
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
