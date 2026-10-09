import type { TutorialDefinition } from '../TutorialDefinition';

export const radminTutorial: TutorialDefinition = {
  id: 'radmin-vpn',
  name: 'tutorial.radmin.name',
  icon: 'vpn_lock',
  steps: [
    {
      title: 'tutorial.radmin.step1.title',
      content: 'tutorial.radmin.step1.content',
      images: [{ shot: 'site-radmin', alt: 'tutorial.shotRadminSiteAlt' }],
    },
    {
      title: 'tutorial.radmin.step2.title',
      content: 'tutorial.radmin.step2.content',
      images: [{ shot: 'app-radmin-create', alt: 'tutorial.shotRadminCreateAlt' }],
    },
    {
      title: 'tutorial.radmin.step3.title',
      content: 'tutorial.radmin.step3.content',
      images: [{ shot: 'app-radmin-join', alt: 'tutorial.shotRadminJoinAlt' }],
      tip: 'tutorial.radmin.step3.tip',
    },
    {
      title: 'tutorial.radmin.step4.title',
      content: 'tutorial.radmin.step4.content',
      images: [{ shot: 'app-radmin-ip', alt: 'tutorial.shotRadminIpAlt' }],
    },
    {
      title: 'tutorial.radmin.step5.title',
      content: 'tutorial.radmin.step5.content',
      images: [{ shot: 'add-server-create', alt: 'tutorial.shotCreateAlt' }, { shot: 'invite-radmin', alt: 'tutorial.shotInviteAlt' }],
      tip: 'tutorial.radmin.step5.tip',
    },
  ],
};
