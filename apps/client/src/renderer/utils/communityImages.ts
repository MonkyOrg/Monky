import {
  MessageType,
  communityImageUploadResultSchema,
} from '@monky/shared';
import type { NetworkClient } from '../core/NetworkClient';

const previews = new Map<string, string>();

export async function uploadCommunityImage(
  client: NetworkClient,
  channelId: string,
  imageData: string,
): Promise<{ ref: string; url: string }> {
  const response = communityImageUploadResultSchema.parse(await client.sendRequest<unknown>(
    MessageType.COMMUNITY_IMAGE_UPLOAD,
    { channelId, imageData },
  ));
  const url = client.getHttpBaseUrl() + response.url;
  previews.set(response.ref, url);
  return { ref: response.ref, url };
}

export function communityImagePreview(ref: string): string | undefined {
  return previews.get(ref);
}
