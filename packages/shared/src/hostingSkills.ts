import { z } from 'zod';

/** Every hosting tutorial ships an AI agent skill that walks through the same setup. */
export const HOSTING_SKILL_IDS = [
  'lan', 'radmin', 'tailscale', 'hamachi', 'zerotier', 'port-forward', 'vps-oracle', 'vps-generic',
] as const;
export const hostingSkillIdSchema = z.enum(HOSTING_SKILL_IDS);
export type HostingSkillId = z.infer<typeof hostingSkillIdSchema>;
export type HostingSkillSaveResult = { status: 'saved' | 'cancelled' } | { status: 'failed'; error: string };
export const HOSTING_SKILL_IPC = 'onboarding:save-hosting-skill' as const;

/** Folder and `name` of the skill: agent skill names only allow lowercase letters, digits and hyphens. */
export function hostingSkillName(id: HostingSkillId): string {
  return `monky-server-${id}`;
}
