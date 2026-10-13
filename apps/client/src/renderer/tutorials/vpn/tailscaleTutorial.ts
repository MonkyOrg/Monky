import type { TutorialDefinition } from '../TutorialDefinition';

export const tailscaleTutorial: TutorialDefinition = {
  id: 'tailscale',
  name: 'tutorial.tailscale.name',
  icon: 'vpn_lock',
  skill: 'tailscale',
  steps: [
    {
      title: 'tutorial.tailscale.step1.title',
      content: 'tutorial.tailscale.step1.content',
      images: [{ shot: 'site-tailscale', alt: 'tutorial.shotTailscaleSiteAlt' }],
    },
    {
      title: 'tutorial.tailscale.step2.title',
      content: 'tutorial.tailscale.step2.content',
      images: [{ shot: 'app-tailscale-keys', alt: 'tutorial.shotTailscaleKeysAlt' }],
    },
    {
      title: 'tutorial.tailscale.step3.title',
      content: 'tutorial.tailscale.step3.content',
      images: [{ shot: 'app-tailscale-ip', alt: 'tutorial.shotTailscaleIpAlt' }],
      tip: 'tutorial.tailscale.step3.tip',
    },
    {
      title: 'tutorial.tailscale.step4.title',
      content: 'tutorial.tailscale.step4.content',
      images: [{ shot: 'add-server-create', alt: 'tutorial.shotCreateAlt' }, { shot: 'invite-tailscale', alt: 'tutorial.shotInviteAlt' }],
      tip: 'tutorial.tailscale.step4.tip',
    },
  ],
};
