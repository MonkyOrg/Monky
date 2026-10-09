import type { TutorialDefinition } from '../TutorialDefinition';

export const hamachiTutorial: TutorialDefinition = {
  id: 'hamachi',
  name: 'tutorial.hamachi.name',
  icon: 'vpn_lock',
  steps: [
    {
      title: 'tutorial.hamachi.step1.title',
      content: 'tutorial.hamachi.step1.content',
      images: [{ shot: 'site-hamachi', alt: 'tutorial.shotHamachiSiteAlt' }],
    },
    {
      title: 'tutorial.hamachi.step2.title',
      content: 'tutorial.hamachi.step2.content',
      images: [{ shot: 'app-hamachi-create', alt: 'tutorial.shotHamachiCreateAlt' }],
    },
    {
      title: 'tutorial.hamachi.step3.title',
      content: 'tutorial.hamachi.step3.content',
      images: [{ shot: 'app-hamachi-join', alt: 'tutorial.shotHamachiJoinAlt' }],
      tip: 'tutorial.hamachi.step3.tip',
    },
    {
      title: 'tutorial.hamachi.step4.title',
      content: 'tutorial.hamachi.step4.content',
      images: [{ shot: 'app-hamachi-ip', alt: 'tutorial.shotHamachiIpAlt' }, { shot: 'add-server-create', alt: 'tutorial.shotCreateAlt' }, { shot: 'invite-hamachi', alt: 'tutorial.shotInviteAlt' }],
      tip: 'tutorial.hamachi.step4.tip',
    },
  ],
};
