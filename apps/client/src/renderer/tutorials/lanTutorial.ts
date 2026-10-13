import type { TutorialDefinition } from './TutorialDefinition';

export const lanTutorial: TutorialDefinition = {
  id: 'lan',
  name: 'tutorial.lan.name',
  icon: 'wifi',
  skill: 'lan',
  steps: [
    {
      title: 'tutorial.lan.step1.title',
      content: 'tutorial.lan.step1.content',
      images: [{ shot: 'illustration-lan', alt: 'tutorial.shotLanAlt' }],
    },
    {
      title: 'tutorial.lan.step2.title',
      content: 'tutorial.lan.step2.content',
      tip: 'tutorial.lan.step2.tip',
      images: [{ shot: 'terminal-ipconfig', alt: 'tutorial.shotIpconfigAlt' }],
    },
    {
      title: 'tutorial.lan.step3.title',
      content: 'tutorial.lan.step3.content',
      tip: 'tutorial.lan.step3.tip',
      images: [{ shot: 'terminal-ip-unix', alt: 'tutorial.shotUnixIpAlt' }],
    },
    {
      title: 'tutorial.lan.step4.title',
      content: 'tutorial.lan.step4.content',
      images: [{ shot: 'add-server-create', alt: 'tutorial.shotCreateAlt' }, { shot: 'invite-lan', alt: 'tutorial.shotInviteAlt' }],
    },
  ],
};
