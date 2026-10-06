import { z } from 'zod';

export const communityImageAssetRefSchema = z.string().uuid();
export const communityImageUrlSchema = z.string().regex(/^\/avatars\/[A-Za-z0-9._-]+$/);
