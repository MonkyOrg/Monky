import { z } from 'zod';

const reference = z.string().min(1).max(128);

export const privateAudienceSelectionSchema = z.object({
  visibility: z.literal('private'),
  userIds: z.array(reference).max(256).refine(values => new Set(values).size === values.length),
  roleIds: z.array(reference).max(128).refine(values => new Set(values).size === values.length),
}).strict().refine(
  value => value.userIds.length + value.roleIds.length > 0,
  'A private audience requires at least one user or role.',
);

export const resourceAudienceSchema = z.union([
  z.object({ visibility: z.literal('public') }).strict(),
  privateAudienceSelectionSchema,
]);

export const resourceAudienceProjectionSchema = z.union([
  z.object({ visibility: z.literal('public') }).strict(),
  z.object({
    visibility: z.literal('private'),
    userIds: z.array(reference).max(256).refine(values => new Set(values).size === values.length).optional(),
    roleIds: z.array(reference).max(128).refine(values => new Set(values).size === values.length).optional(),
  }).strict().superRefine((value, ctx) => {
    const hasUsers = value.userIds !== undefined;
    const hasRoles = value.roleIds !== undefined;
    if (hasUsers !== hasRoles) {
      ctx.addIssue({ code: 'custom', message: 'Private audience details must be complete.' });
    }
  }),
]);

export type ResourceAudience = z.infer<typeof resourceAudienceSchema>;
export type ResourceAudienceProjection = z.infer<typeof resourceAudienceProjectionSchema>;

export const PUBLIC_AUDIENCE: ResourceAudience = Object.freeze({ visibility: 'public' });

export function projectResourceAudience(
  audience: ResourceAudience,
  revealSelection: boolean,
): ResourceAudienceProjection {
  if (audience.visibility === 'public' || revealSelection) return audience;
  return { visibility: 'private' };
}
