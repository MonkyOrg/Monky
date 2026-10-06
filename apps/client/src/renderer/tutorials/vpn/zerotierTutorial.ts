import type { TutorialDefinition } from '../TutorialDefinition';

export const zerotierTutorial: TutorialDefinition = {
  id: 'zerotier',
  name: 'tutorial.zerotier.name',
  icon: 'vpn_lock',
  steps: [
    {
      title: 'tutorial.zerotier.step1.title',
      content: 'tutorial.zerotier.step1.content',
    },
    {
      title: 'tutorial.zerotier.step2.title',
      content: 'tutorial.zerotier.step2.content',
    },
    {
      title: 'tutorial.zerotier.step3.title',
      content: 'tutorial.zerotier.step3.content',
      tip: 'tutorial.zerotier.step3.tip',
    },
    {
      title: 'tutorial.zerotier.step4.title',
      content: 'tutorial.zerotier.step4.content',
      images: [{ shot: 'add-server-create', alt: 'tutorial.shotCreateAlt' }, { shot: 'invite-zerotier', alt: 'tutorial.shotInviteAlt' }],
      tip: 'tutorial.zerotier.step4.tip',
    },
  ],
};
