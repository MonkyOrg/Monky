import type { MessageType, Permission } from '@monky/shared';
import type { NetworkClient } from '../../core/NetworkClient';
import type { ServerStore } from '../../stores/serverStore';
import type { ServerSettingsOperations } from './ServerSettingsOperations';

export interface ServerSettingsContext {
  readonly client: NetworkClient;
  readonly store: ServerStore;
  readonly operations: ServerSettingsOperations;
  isCurrent(): boolean;
  assertAllowed(permission?: Permission): void;
  request<T>(type: MessageType, payload: object, permission: Permission, timeoutMs?: number): Promise<T>;
}
