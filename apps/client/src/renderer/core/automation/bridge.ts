import { automationRequestSchema } from '@monky/shared';
import { executeAutomation } from './executeAutomation';

export function bindAutomation(): () => void {
  if (!window.api?.capabilities?.automation) return () => {};
  const pending = new Map<string, AbortController>();
  const unbindRequest = window.api.onAutomationRequest(value => {
    const parsed = automationRequestSchema.safeParse(value);
    if (!parsed.success) {
      const correlation = automationRequestSchema.pick({ requestId: true }).strip().safeParse(value);
      if (correlation.success && !pending.has(correlation.data.requestId)) {
        void window.api.replyAutomation({ requestId: correlation.data.requestId, result: { ok: false, code: 'invalid_input' } }).catch(() => {});
      }
      return;
    }
    if (pending.has(parsed.data.requestId)) return;
    const request = parsed.data;
    const controller = new AbortController();
    pending.set(request.requestId, controller);
    void executeAutomation(request, controller.signal).then(async result => {
      if (!controller.signal.aborted) await window.api.replyAutomation({ requestId: request.requestId, result });
    }).catch(() => {}).finally(() => pending.delete(request.requestId));
  });
  const unbindCancel = window.api.onAutomationCancel(requestId => pending.get(requestId)?.abort());
  void window.api.automationReady().catch(() => {});
  return () => {
    unbindRequest();
    unbindCancel();
    for (const controller of pending.values()) controller.abort();
    pending.clear();
  };
}
