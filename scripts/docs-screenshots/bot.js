import fs from 'node:fs';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { repoRoot } from '../qa.js';

const require = createRequire(import.meta.url);
const sdk = require(path.join(repoRoot, 'packages', 'bot-sdk', 'dist', 'index.js'));

const pick = (ctx, pt, en) => (ctx.locale === 'en' ? en : pt);

function panelHtml() {
  return `<!doctype html><html><head><style>
    body { margin: 0; padding: 28px 32px; font-family: Inter, system-ui, sans-serif; color: #f0f3f6; background: #161b26; }
    .eyebrow { color: #a2a8ff; font-size: 12px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
    h1 { margin: 12px 0 10px; font-size: 30px; }
    p { margin: 0 0 24px; color: #b4bcc8; font-size: 15px; }
    .choices { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
    button { padding: 22px 12px; border: 1px solid #3a4258; border-radius: 12px; background: #222a3b; color: #f0f3f6;
      font: 600 16px Inter, system-ui, sans-serif; cursor: pointer; }
    button.leading { border-color: #5865f2; background: #2a3260; }
    .note { margin-top: 24px; padding: 14px 18px; border-radius: 10px; background: #1f2636; color: #b4bcc8; font-size: 14px; }
  </style></head><body>
    <div class="eyebrow" id="eyebrow"></div><h1 id="title"></h1><p id="lead"></p>
    <div class="choices" id="choices"></div><div class="note" id="note"></div>
    <script>
      const text = {
        'pt-BR': { eyebrow: 'Miniapp compartilhado', title: 'Qual é o plano para hoje?',
          lead: 'Escolha uma atividade com o grupo. Todos acompanham o mesmo estado.',
          note: 'Esta é uma tela do bot demonstrativo, não um compartilhamento de tela.',
          labels: { games: 'Jogos', music: 'Música', chat: 'Conversa' } },
        en: { eyebrow: 'Shared miniapp', title: 'What is the plan for today?',
          lead: 'Pick an activity with the group. Everyone sees the same state.',
          note: 'This is a screen from the demo bot, not a screen share.',
          labels: { games: 'Games', music: 'Music', chat: 'Talk' } },
      };
      window.monkyScreen.onState(state => {
        const t = text[window.monkyScreen.viewer.locale] || text.en;
        for (const key of ['eyebrow', 'title', 'lead', 'note']) document.getElementById(key).textContent = t[key];
        const top = Math.max(...Object.values(state.votes));
        document.getElementById('choices').replaceChildren(...Object.entries(state.votes).map(([key, votes]) => {
          const button = document.createElement('button');
          button.textContent = t.labels[key] + ' · ' + votes;
          if (votes === top && votes > 0) button.className = 'leading';
          button.onclick = () => window.monkyScreen.sendAction('vote', { choice: key });
          return button;
        }));
      });
    </script></body></html>`;
}

/** The demo bot shown in the screenshots: a form, a shared poll, a miniapp and /ping. */
export async function startGuiaBot(directory, language) {
  const bot = new sdk.BotClient({
    requestedCapabilities: ['commands', 'send_messages', 'selectors', 'miniapps'],
    publicKey: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('hex'),
    name: 'GuiaBot',
    registrationFile: path.join(directory, 'registrations.json'),
  });
  bot.on('error', error => console.error('[GuiaBot]', error.message));

  bot.command({
    name: 'plan',
    description: 'Organize the next get-together with a private form',
    localizations: { 'pt-BR': { name: 'planejar', description: 'Organiza o próximo encontro com um formulário privado' } },
    handler: async ctx => {
      const result = await ctx.prompt({
        title: pick(ctx, 'Vamos combinar o próximo encontro', 'Let\'s plan the next get-together'),
        description: pick(ctx, 'Só você vê este formulário. Nada é publicado no canal.',
          'Only you can see this form. Nothing is posted to the channel.'),
        submitLabel: pick(ctx, 'Confirmar plano', 'Confirm plan'),
        fields: [
          { name: 'activity', label: pick(ctx, 'Atividade', 'Activity'), type: 'text', required: true, maxLength: 80,
            placeholder: pick(ctx, 'Ex.: noite de jogos', 'E.g. game night') },
          { name: 'when', label: pick(ctx, 'Quando?', 'When?'), type: 'select', required: true,
            choices: [
              { label: pick(ctx, 'Sexta à noite', 'Friday night'), value: 'friday' },
              { label: pick(ctx, 'Sábado à tarde', 'Saturday afternoon'), value: 'saturday' },
              { label: pick(ctx, 'Domingo', 'Sunday'), value: 'sunday' },
            ] },
          { name: 'reminder', label: pick(ctx, 'Incluir lembrete no resumo', 'Add a reminder to the summary'),
            type: 'boolean', defaultValue: true },
        ],
      });
      if (result) ctx.reply(pick(ctx, 'Plano anotado!', 'Plan saved!'));
    },
  });

  bot.command({
    name: 'poll',
    description: 'Create a shared channel poll',
    localizations: { 'pt-BR': { name: 'enquete', description: 'Cria uma votação compartilhada no canal' } },
    handler: async ctx => {
      await ctx.createSelector({
        title: pick(ctx, 'Qual atividade devemos organizar?', 'Which activity should we organize?'),
        choices: [
          { label: pick(ctx, 'Campeonato', 'Tournament'), value: 'tournament' },
          { label: pick(ctx, 'Sessão de conversa', 'Hangout session'), value: 'chat' },
        ],
        presentation: 'buttons', responder: 'any', allowChange: true,
        expiresAt: Date.now() + 60 * 60 * 1000,
      });
    },
  });

  const votes = new Map();
  bot.command({
    name: 'panel',
    description: 'Open a shared miniapp in your voice room',
    voiceRequirement: 'joined',
    localizations: { 'pt-BR': { name: 'painel', description: 'Abre um miniapp compartilhado na sua sala de voz' } },
    handler: async ctx => {
      const screen = await ctx.createScreen({
        title: pick(ctx, 'Nosso próximo encontro', 'Our next get-together'),
        html: panelHtml(),
        state: { votes: { games: 2, music: 1, chat: 0 } },
      });
      votes.set(screen.id, screen);
    },
  });

  bot.command({
    name: 'ping',
    description: 'Check whether the bot is online',
    localizations: { 'pt-BR': { description: 'Verifica se o bot está respondendo' } },
    handler: ctx => ctx.reply('Pong!'),
  });

  const icon = `data:image/png;base64,${fs.readFileSync(path.join(repoRoot, 'docs-site', 'public', 'logo.png')).toString('base64')}`;
  const server = await bot.serve({
    name: 'GuiaBot',
    description: language === 'en'
      ? 'Example of SDK commands, forms, polls and miniapps.'
      : 'Exemplo de comandos, formulários, enquetes e miniapps do SDK.',
    icon, port: 0, host: '127.0.0.1', publicHost: '127.0.0.1',
  });
  return {
    bot,
    manifestUrl: `http://127.0.0.1:${server.address().port}/manifest`,
    async close() { await bot.close(); },
  };
}
