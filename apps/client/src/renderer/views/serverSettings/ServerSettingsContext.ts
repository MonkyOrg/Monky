import type { ClientMessageArgs, Permission } from '@monky/shared';
import type { NetworkClient } from '../../core/NetworkClient';
import type { ServerStore } from '../../stores/serverStore';
import type { ServerSettingsOperations } from './ServerSettingsOperations';

export interface ServerSettingsContext {
  readonly client: NetworkClient;
  readonly store: ServerStore;
  readonly operations: ServerSettingsOperations;
  isCurrent(): boolean;
  assertAllowed(permission?: Permission): void;
  /** Sends [type, payload] once permission still holds; T is the answer expected. */
  request<T>(message: ClientMessageArgs, permission: Permission, timeoutMs?: number): Promise<T>;
}
