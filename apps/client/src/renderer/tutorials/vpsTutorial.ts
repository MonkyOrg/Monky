import type { TutorialDefinition } from './TutorialDefinition';

export const vpsOracleFreeTutorial: TutorialDefinition = {
  id: 'vps-oracle-free',
  name: 'tutorial.vpsOracle.name',
  icon: 'cloud',
  steps: [
    {
      title: 'tutorial.vpsOracle.step1.title',
      content: 'tutorial.vpsOracle.step1.content',
      images: [{ shot: 'site-oracle-free', alt: 'tutorial.shotOracleSiteAlt' }],
    },
    {
      title: 'tutorial.vpsOracle.step2.title',
      content: 'tutorial.vpsOracle.step2.content',
      images: [{ shot: 'illustration-oracle-instance', alt: 'tutorial.shotOracleInstanceAlt' }],
    },
    {
      title: 'tutorial.vpsOracle.step3.title',
      content: 'tutorial.vpsOracle.step3.content',
      tip: 'tutorial.vpsOracle.step3.tip',
      images: [{ shot: 'illustration-oracle-ingress', alt: 'tutorial.shotOracleIngressAlt' }],
    },
    {
      title: 'tutorial.vpsOracle.step4.title',
      content: 'tutorial.vpsOracle.step4.content',
      images: [{ shot: 'terminal-monky-install', alt: 'tutorial.shotInstallAlt' }, { shot: 'terminal-monky-create', alt: 'tutorial.shotMonkyCreateAlt' }],
    },
    {
      title: 'tutorial.vpsOracle.step5.title',
      content: 'tutorial.vpsOracle.step5.content',
      images: [{ shot: 'add-server-join', alt: 'tutorial.shotJoinAlt' }],
      tip: 'tutorial.vpsOracle.step5.tip',
    },
  ],
};

export const vpsGenericTutorial: TutorialDefinition = {
  id: 'vps-generic',
  name: 'tutorial.vpsGeneric.name',
  icon: 'cloud',
  steps: [
    {
      title: 'tutorial.vpsGeneric.step1.title',
      content: 'tutorial.vpsGeneric.step1.content',
      images: [{ shot: 'illustration-vps-providers', alt: 'tutorial.shotVpsProvidersAlt' }],
    },
    {
      title: 'tutorial.vpsGeneric.step2.title',
      content: 'tutorial.vpsGeneric.step2.content',
      tip: 'tutorial.vpsGeneric.step2.tip',
      images: [{ shot: 'terminal-ssh', alt: 'tutorial.shotSshAlt' }],
    },
    {
      title: 'tutorial.vpsGeneric.step3.title',
      content: 'tutorial.vpsGeneric.step3.content',
      images: [{ shot: 'terminal-monky-install', alt: 'tutorial.shotInstallAlt' }],
    },
    {
      title: 'tutorial.vpsGeneric.step4.title',
      content: 'tutorial.vpsGeneric.step4.content',
      images: [{ shot: 'terminal-monky-create', alt: 'tutorial.shotMonkyCreateAlt' }, { shot: 'add-server-join', alt: 'tutorial.shotJoinAlt' }],
      tip: 'tutorial.vpsGeneric.step4.tip',
    },
  ],
};
