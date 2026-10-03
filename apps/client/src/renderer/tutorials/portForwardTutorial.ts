import type { TutorialDefinition } from './TutorialDefinition';

export const portForwardTutorial: TutorialDefinition = {
  id: 'port-forward',
  name: 'tutorial.portForward.name',
  icon: 'router',
  steps: [
    {
      title: 'tutorial.portForward.step1.title',
      content: 'tutorial.portForward.step1.content',
      tip: 'tutorial.portForward.step1.tip',
      images: [{ shot: 'terminal-gateway', alt: 'tutorial.shotGatewayAlt' }],
    },
    {
      title: 'tutorial.portForward.step2.title',
      content: 'tutorial.portForward.step2.content',
    },
    {
      title: 'tutorial.portForward.step3.title',
      content: 'tutorial.portForward.step3.content',
      tip: 'tutorial.portForward.step3.tip',
    },
    {
      title: 'tutorial.portForward.step4.title',
      content: 'tutorial.portForward.step4.content',
    },
    {
      title: 'tutorial.portForward.step5.title',
      content: 'tutorial.portForward.step5.content',
      images: [{ shot: 'add-server-create', alt: 'tutorial.shotCreateAlt' }, { shot: 'invite-public', alt: 'tutorial.shotInviteAlt' }],
      tip: 'tutorial.portForward.step5.tip',
    },
  ],
};
