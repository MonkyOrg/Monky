import { screenShareIdSchema } from '@monky/shared';

/**
 * The stream a local screen share is shown through. Its id names the share everywhere (stores, IPC and the
 * server), so it must be a valid share id. Firefox names every stream `{uuid}`, braces the rule refuses (#858):
 * such a stream gets an id of its own, which only the app reads.
 */
export function createScreenShareStream(): MediaStream {
  const stream = new MediaStream();
  if (!screenShareIdSchema.safeParse(stream.id).success)
    Object.defineProperty(stream, 'id', { value: crypto.randomUUID(), enumerable: true });
  return stream;
}
