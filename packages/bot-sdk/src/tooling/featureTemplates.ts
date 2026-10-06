import type { BotCapability, BotFormField, SelectionChoice } from '@monky/shared';

export const FEATURE_KINDS = ['command', 'form', 'selector', 'settings', 'screen'] as const;
export type FeatureKind = typeof FEATURE_KINDS[number];
export type BotFeature =
  | { kind: 'command' | 'screen' | 'settings'; name: string }
  | { kind: 'form'; name: string; fields: BotFormField[] }
  | { kind: 'selector'; name: string; choices: SelectionChoice[]; public: boolean };

export function featureFile(feature: BotFeature): string {
  if (feature.kind === 'settings') return 'src/settings.ts';
  const directory = { command: 'commands', form: 'forms', selector: 'selectors', screen: 'screens' }[feature.kind];
  return `src/${directory}/${feature.name}.ts`;
}

export function featureCapabilities(features: readonly BotFeature[]): BotCapability[] {
  const capabilities = new Set<BotCapability>(['commands']);
  for (const feature of features) {
    if (feature.kind === 'screen') capabilities.add('miniapps');
    if (feature.kind === 'selector' && feature.public) {
      capabilities.add('send_messages');
      capabilities.add('selectors');
    }
  }
  return [...capabilities];
}

export function featureRegistry(features: readonly BotFeature[]): string {
  const imports = features.map((feature, index) =>
    `import { ${feature.kind === 'settings' ? 'settings' : 'command'} as feature${index} } from ${JSON.stringify(
      `./${featureFile(feature).slice('src/'.length).replace(/\.ts$/, '.js')}`)};`);
  const registrations = features.map((feature, index) =>
    `  bot.${feature.kind === 'settings' ? 'settings' : 'command'}(feature${index});`);
  return `// Managed by monky-bot-sdk add. Edit the individual feature modules instead.
import type { BotCapability, BotClient } from '@monky/bot-sdk';
${imports.join('\n')}

export const requestedCapabilities: BotCapability[] = ${JSON.stringify(featureCapabilities(features))};

export function registerFeatures(bot: BotClient): void {
${registrations.join('\n')}
}
`;
}

const screenHtml = `<main>
  <h1 id="title"></h1>
  <p id="message"></p>
</main>
<script>
  window.monkyScreen.onState(state => {
    const english = window.monkyScreen.viewer.locale === 'en';
    document.getElementById('title').textContent = english ? 'Shared panel' : 'Painel compartilhado';
    document.getElementById('message').textContent = (english ? 'Example: ' : 'Exemplo: ') + state.name;
  });
</script>`;

export function featureSource(feature: BotFeature): string {
  if (feature.kind === 'settings') {
    return `import type { BotSettingsDefinition } from '@monky/bot-sdk';

export const settings: BotSettingsDefinition = {
  server: {
    title: 'Comportamento',
    fields: [{ name: 'enabled', label: 'Ativado', type: 'boolean', required: true, defaultValue: true }],
  },
  user: {
    title: 'Minhas preferências',
    fields: [{ name: 'compact', label: 'Respostas compactas', type: 'boolean', required: true, defaultValue: false }],
  },
  localizations: {
    en: {
      server: { title: 'Behavior', fields: { enabled: { label: 'Enabled' } } },
      user: { title: 'My preferences', fields: { compact: { label: 'Compact replies' } } },
    },
  },
};
`;
  }
  const name = JSON.stringify(feature.name);
  const descriptions = {
    command: ['Executa um comando de exemplo', 'Run an example command'],
    form: ['Abre um formulário privado', 'Open a private form'],
    selector: ['Abre uma seleção', 'Open a selection'],
    screen: ['Abre um miniapp na sua sala de voz', 'Open a miniapp in your voice room'],
  }[feature.kind];
  let body: string;
  if (feature.kind === 'command') {
    const pt = feature.name === 'ping' ? 'Pong! Estou online.' : `Comando ${feature.name} executado.`;
    const en = feature.name === 'ping' ? 'Pong! I am online.' : `Command ${feature.name} completed.`;
    body = `    ctx.reply({
      content: ${JSON.stringify(en)},
      localizations: { 'pt-BR': ${JSON.stringify(pt)}, en: ${JSON.stringify(en)} },
    });`;
  } else if (feature.kind === 'form') {
    body = `    const values = await ctx.prompt({
      title: ${name},
      fields: ${JSON.stringify(feature.fields, null, 2).replace(/\n/g, '\n      ')},
    });
    if (values === null || ctx.signal.aborted) return;
    ctx.reply({
      content: 'Form received.',
      localizations: { 'pt-BR': 'Formulário recebido.', en: 'Form received.' },
    });`;
  } else if (feature.kind === 'selector') {
    const choices = JSON.stringify(feature.choices, null, 2).replace(/\n/g, '\n      ');
    body = feature.public ? `    await ctx.createSelector({
      title: ${name},
      choices: ${choices},
      presentation: 'buttons',
      responder: 'any',
      allowChange: true,
      expiresAt: Date.now() + 5 * 60_000,
      maxResponders: 50,
    });` : `    const selected = await ctx.choose({
      title: ${name},
      choices: ${choices},
      presentation: 'buttons',
    });
    if (selected === null || ctx.signal.aborted) return;
    ctx.reply({
      content: \`Selected: \${selected}\`,
      localizations: { 'pt-BR': \`Escolha: \${selected}\`, en: \`Selected: \${selected}\` },
    });`;
  } else {
    body = `    await ctx.createScreen({
      title: ${name},
      html: ${JSON.stringify(screenHtml)},
      state: { name: ${name} },
    });`;
  }
  return `import type { CommandDefinition } from '@monky/bot-sdk';

export const command: CommandDefinition = {
  name: ${name},
  description: ${JSON.stringify(descriptions[1])},
  localizations: { 'pt-BR': { description: ${JSON.stringify(descriptions[0])} } },
${feature.kind === 'screen' ? "  voiceRequirement: 'joined',\n" : ''}  handler: ${feature.kind === 'command' ? '' : 'async '}(ctx) => {
    if (ctx.signal.aborted) return;
${body}
  },
};
`;
}
