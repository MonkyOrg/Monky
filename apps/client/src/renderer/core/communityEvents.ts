import { LIMITS, MessageType, eventSaveSchema, type EventSave } from '@monky/shared';
import type { NetworkClient } from './NetworkClient';
import { t } from '../i18n';

/** The wizard and automation share validation and transport limits. */
export function saveCommunityEvent(client: NetworkClient, input: EventSave, requestId: string = crypto.randomUUID()): Promise<unknown> {
  const payload = eventSaveSchema.parse(input);
  const envelope = JSON.stringify({ type: MessageType.EVENT_SAVE, requestId, payload });
  if (new TextEncoder().encode(envelope).byteLength > LIMITS.WS_MAX_PAYLOAD_BYTES) {
    return Promise.reject(new Error(t('community.eventImagesTooLarge')));
  }
  return client.sendRequest(MessageType.EVENT_SAVE, payload, requestId);
}
