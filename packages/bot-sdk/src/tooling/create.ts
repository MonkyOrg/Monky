import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PROTOCOL_VERSION, type BotLocale } from '@monky/shared';
import { askCliChoice, askCliValue } from '../cli/prompts';
import { CliError, cliText, isInteractiveCliAccess } from '../cli/locale';
import { validateBotName } from '../cli/config';
import { isRecord, loadBotProject } from './config';
import { runNpm } from './process';
import { bundleDependencies } from './bundle';

export function validateProjectName(value: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)) {
    throw new CliError('Nome inválido. Use 2 a 64 letras minúsculas, números, hífen ou sublinhado; não use nomes reservados.',
      'Invalid name. Use 2–64 lowercase letters, digits, hyphens or underscores, excluding reserved names.');
  }
  return value;
}

function entrySource(displayName: string): string {
  return `import { BotClient, validateBotServerUrl, validateBotToken } from '@monky/bot-sdk';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(\`Missing environment variable: \${name}. Start through the SDK CLI.\`);
  return value;
}

const bot = new BotClient({
  name: process.env.MONKY_BOT_NAME ?? ${JSON.stringify(displayName)},
  publicKey: required('MONKY_BOT_PUBLIC_KEY'),
  requestedCapabilities: ['commands'],
});

bot.command({
  name: 'ping',
  description: 'Check whether the bot is online',
  localizations: { 'pt-BR': { description: 'Verifica se o bot está respondendo' } },
  handler: ctx => {
    if (ctx.signal.aborted) return;
    ctx.reply({
      content: 'Pong! I am online.',
      localizations: { 'pt-BR': 'Pong! Estou online.', en: 'Pong! I am online.' },
    });
  },
});

bot.on('error', (error: Error) => { console.error('[bot]', error.message); });
let closing = false;
const shutdown = (): void => {
  if (closing) return;
  closing = true;
  void bot.close().catch((error: unknown) => {
    console.error('[shutdown]', error instanceof Error ? error.message : 'Could not close the bot');
    process.exitCode = 1;
  });
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

bot.connect({
  serverUrl: validateBotServerUrl(required('MONKY_SERVER_URL')),
  token: validateBotToken(required('MONKY_BOT_TOKEN')),
});
`;
}

export interface CreateBotOptions {
  directory: string;
  name: string;
  displayName: string;
  install: boolean;
}

export function createBotProject(options: CreateBotOptions): string {
  const name = validateProjectName(options.name);
  const displayName = validateBotName(options.displayName);
  const target = path.resolve(options.directory);
  const sdkRoot = path.resolve(__dirname, '..', '..');
  const sdk = loadBotProject(sdkRoot).manifest;
  if (sdk.name !== '@monky/bot-sdk' || !isRecord(sdk.dependencies)) {
    throw new CliError('A instalação do SDK de bots está inválida. Reinstale o artefato oficial.',
      'The bot SDK installation is invalid. Reinstall the official artifact.');
  }
  if (fs.existsSync(target)) throw new CliError('A pasta de destino já existe; nenhum arquivo foi alterado.',
    'The destination already exists; no files were changed.');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.mkdirSync(target);
  fs.mkdirSync(path.join(target, 'src'));
  fs.mkdirSync(path.join(target, 'vendor'));
  let stage = 'SDK / npm pack';
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-bot-create-'));
  try {
    fs.writeFileSync(path.join(staging, 'package.json'), JSON.stringify({ name: 'monky-scaffold-sdk', version: '1.0.0' }));
    bundleDependencies(staging, staging, new Map([['@monky/bot-sdk', sdkRoot]]));
    runNpm(['pack', '--ignore-scripts', '--silent', '--pack-destination', path.join(target, 'vendor')], {
      cwd: path.join(staging, 'node_modules', '@monky', 'bot-sdk'),
    });
    const archives = fs.readdirSync(path.join(target, 'vendor')).filter(file => file.endsWith('.tgz'));
    if (archives.length !== 1) throw new Error('SDK packaging did not produce exactly one archive.');
    stage = 'project files';
    const manifest = {
      name, version: '1.0.0', private: true, type: 'module',
      engines: { node: '>=22' },
      scripts: { build: 'tsc', cli: 'monky-bot-sdk cli', package: 'monky-bot-sdk build', doctor: 'monky-bot-sdk doctor' },
      monkyBot: { cliName: name, displayName, entry: 'dist/index.js', files: ['dist'], modes: ['manual'] },
      dependencies: { '@monky/bot-sdk': `file:vendor/${archives[0]}` },
      devDependencies: { '@types/node': '^22.0.0', typescript: '^5.9.3' },
    };
    const files: Record<string, string> = {
      'package.json': JSON.stringify(manifest, null, 2) + '\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', rootDir: 'src', outDir: 'dist',
          strict: true, esModuleInterop: true, skipLibCheck: true, noEmitOnError: true,
        },
        include: ['src/**/*.ts'],
      }, null, 2) + '\n',
      '.gitignore': 'node_modules/\ndist/\nrelease/\n.keys/\n.env\n*.log\n',
      [path.join('src', 'index.ts')]: entrySource(displayName),
    };
    for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(target, file), content, { flag: 'wx' });
    if (options.install) {
      stage = 'npm install';
      runNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: target, stdio: 'inherit', timeout: 300_000 });
      stage = 'npm run build';
      runNpm(['run', 'build'], { cwd: target, stdio: 'inherit' });
    }
  } catch {
    throw new CliError(`Não foi possível concluir a etapa "${stage}" em ${target}. Os arquivos criados foram preservados. Confira o SDK local; se package.json existir, execute npm install e npm run build nessa pasta.`,
      `Could not complete "${stage}" in ${target}. Created files were preserved. Check the local SDK; if package.json exists, run npm install and npm run build there.`);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
  return target;
}

export async function createBotCommand(args: string[], locale: BotLocale): Promise<void> {
  let directory: string | undefined, name: string | undefined, displayName: string | undefined;
  let install = true;
  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    if (argument === '--no-install') { install = false; continue; }
    if (['--non-interactive', '--yes', '-y'].includes(argument)) continue;
    if (argument === '--name' || argument === '--display-name') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new CliError('A opção precisa de um valor.', 'The option requires a value.');
      if (argument === '--name' && name === undefined) name = validateProjectName(value);
      else if (argument === '--display-name' && displayName === undefined) displayName = validateBotName(value);
      else throw new CliError('Opção repetida.', 'Duplicate option.');
    } else if (!argument.startsWith('-') && directory === undefined) directory = argument;
    else throw new CliError('Opção de create desconhecida.', 'Unknown create option.');
  }
  const text = (pt: string, en: string): string => cliText(locale, pt, en);
  if (isInteractiveCliAccess(args)) {
    directory ??= await askCliValue(locale, text('Pasta do novo projeto', 'New project directory'),
      value => { if (!value) throw new Error(text('Informe uma pasta.', 'Enter a directory.')); return value; },
      { defaultValue: locale === 'en' ? 'my-bot' : 'meu-bot' });
    name ??= await askCliValue(locale, text('Nome do pacote e comando CLI', 'Package and CLI command name'),
      validateProjectName, { defaultValue: path.basename(path.resolve(directory)) });
    displayName ??= await askCliValue(locale, text('Nome exibido no Monky', 'Name displayed in Monky'),
      validateBotName, { defaultValue: name });
    if (install) install = await askCliChoice(locale, text('Instalar dependências e compilar agora?', 'Install dependencies and build now?'), [
      { value: 'yes', label: text('Sim', 'Yes') }, { value: 'no', label: text('Não; apenas criar arquivos', 'No; create files only') },
    ]) === 'yes';
  }
  if (!directory) throw new CliError('Informe create <pasta> ou execute em um terminal interativo.',
    'Provide create <directory> or run in an interactive terminal.');
  name ??= validateProjectName(path.basename(path.resolve(directory)));
  displayName ??= name;
  const target = createBotProject({ directory, name, displayName, install });
  console.log(text(`Projeto criado em ${target}. SDK de bots: ${PROTOCOL_VERSION} (protocolo).`,
    `Project created in ${target}. Bot SDK protocol: ${PROTOCOL_VERSION}.`));
  if (!install) console.log('npm install\nnpm run build');
  console.log(text('Nessa pasta: npm run doctor; depois npm run cli -- setup e npm run cli -- start --foreground.',
    'In that directory: npm run doctor; then npm run cli -- setup and npm run cli -- start --foreground.'));
  console.log(text('Gere o token do bot em Configurações do Servidor > Bots > Mostrar opção avançada. Não use um token GitHub.',
    'Generate the bot token in Server Settings > Bots > Show advanced option. Do not use a GitHub token.'));
}
