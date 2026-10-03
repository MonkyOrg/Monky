import type { TutorialDefinition } from '../TutorialDefinition';

export const tailscaleTutorial: TutorialDefinition = {
  id: 'tailscale',
  name: 'tutorial.tailscale.name',
  icon: 'vpn_lock',
  steps: [
    {
      title: 'tutorial.tailscale.step1.title',
      content: 'tutorial.tailscale.step1.content',
    },
    {
      title: 'tutorial.tailscale.step2.title',
      content: 'tutorial.tailscale.step2.content',
    },
    {
      title: 'tutorial.tailscale.step3.title',
      content: 'tutorial.tailscale.step3.content',
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
