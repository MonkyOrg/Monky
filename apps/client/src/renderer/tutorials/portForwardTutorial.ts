import type { TutorialDefinition } from './TutorialDefinition';

export const portForwardTutorial: TutorialDefinition = {
  id: 'port-forward',
  name: 'tutorial.portForward.name',
  icon: 'router',
  skill: 'port-forward',
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
      images: [{ shot: 'illustration-router-menu', alt: 'tutorial.shotRouterMenuAlt' }],
    },
    {
      title: 'tutorial.portForward.step3.title',
      content: 'tutorial.portForward.step3.content',
      tip: 'tutorial.portForward.step3.tip',
      images: [{ shot: 'illustration-router-rule', alt: 'tutorial.shotRouterRuleAlt' }],
    },
    {
      title: 'tutorial.portForward.step4.title',
      content: 'tutorial.portForward.step4.content',
      images: [{ shot: 'illustration-public-ip', alt: 'tutorial.shotPublicIpAlt' }],
    },
    {
      title: 'tutorial.portForward.step5.title',
      content: 'tutorial.portForward.step5.content',
      images: [{ shot: 'add-server-create', alt: 'tutorial.shotCreateAlt' }, { shot: 'invite-public', alt: 'tutorial.shotInviteAlt' }],
      tip: 'tutorial.portForward.step5.tip',
    },
  ],
};
