import { messageOf, type Call, type NativeScreenCalls, type NativeScreenRequest } from './NativeScreenCall';

/**
 * Main asks the renderer to carry the call's signaling, an SFU request or a presentation stop, and waits
 * for the reply. The reply always goes back, with the failure when there was one: Main never waits forever.
 */
export async function answerMainRequest(
  calls: NativeScreenCalls, call: Call, request: NativeScreenRequest,
  stopPresentation: (presentationId: string) => Promise<void>,
): Promise<void> {
  // Replies must run independently of the command awaiting this request.
  try {
    let value: unknown = null;
    if (request.type === 'presentation-stop') {
      await stopPresentation(request.presentationId);
    } else {
      if (!calls.networkCurrent(call)) throw new Error('The original signaling connection is unavailable.');
      if (request.type === 'signal') {
        await calls.sendSignal(call, request.signal);
      } else {
        value = await call.context.client.relayRequest(request.method, request.payload);
        if (value === undefined) throw new Error('Native SFU RPC returned no acknowledgement.');
      }
    }
    await call.api.nativeScreenReply({ callId: request.callId, requestId: request.requestId, ok: true, value });
  } catch (error) {
    await call.api.nativeScreenReply({
      callId: request.callId, requestId: request.requestId, ok: false,
      error: messageOf(error).slice(0, 4096) || 'Native screen request failed.',
    });
  }
}
