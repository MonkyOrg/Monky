import type { CliContext } from './config';
import { readConfig, validateTokenEnv } from './config';
import { askCliChoice, askCliText, askCliValue, type CliChoice } from './prompts';
import { chooseCliLocale, cliText, saveCliLocale } from './locale';
import { configCommand, logsCommand, restartCommand, startCommand, statusCommand, stopCommand } from './commands/lifecycle';
import { setupCommand } from './commands/setup';
import { autoUpdateCommand, updateCommand } from './commands/update';
import { updateSourceConfigCommand } from './updateConfiguration';
import { updateCredentialCommand } from './updateCredentials';

function choice(context: CliContext, value: string, pt: string, en: string): CliChoice<string> {
  return { value, label: cliText(context.locale, pt, en) };
}

async function updatesMenu(context: CliContext): Promise<void> {
  const text = (pt: string, en: string): string => cliText(context.locale, pt, en);
  while (true) {
    const action = await askCliChoice(context.locale, text('Configuração > Atualizações', 'Configuration > Updates'), [
      choice(context, 'check', 'Verificar versão stable', 'Check stable version'),
      choice(context, 'install', 'Instalar atualização stable', 'Install stable update'),
      choice(context, 'beta', 'Verificar/instalar beta (opção explícita)', 'Check/install beta (explicit choice)'),
      choice(context, 'source', 'Origem das atualizações', 'Update source'),
      choice(context, 'token', 'Token GitHub privado (entrada oculta)', 'Private GitHub token (hidden input)'),
      choice(context, 'token-clear', 'Remover token salvo', 'Remove saved token'),
      choice(context, 'automatic', 'Atualização automática', 'Automatic updates'),
      choice(context, 'back', 'Voltar', 'Back'),
    ]);
    if (action === 'back') return;
    if (action === 'check' || action === 'install') {
      await updateCommand(context, action === 'check' ? ['--check'] : []);
    } else if (action === 'beta') {
      const selected = await askCliChoice(context.locale, text('Betas são versões de teste', 'Betas are test releases'), [
        choice(context, 'check', 'Somente verificar', 'Check only'),
        choice(context, 'install', 'Instalar a versão mais nova, incluindo beta', 'Install the newest version, including beta'),
        choice(context, 'back', 'Voltar', 'Back'),
      ]);
      if (selected !== 'back') await updateCommand(context, ['--beta', ...(selected === 'check' ? ['--check'] : [])]);
    } else if (action === 'source') {
      updateSourceConfigCommand(context, ['show']);
      const source = await askCliChoice(context.locale, text('Escolha a origem', 'Choose the source'), [
        choice(context, 'github', 'GitHub Releases', 'GitHub Releases'),
        choice(context, 'https', 'URL HTTPS de um pacote .tgz', 'HTTPS URL of a .tgz package'),
        choice(context, 'file', 'Arquivo .tgz local', 'Local .tgz file'),
        choice(context, 'reset', 'Restaurar padrão do pacote', 'Restore package default'),
        choice(context, 'back', 'Voltar', 'Back'),
      ]);
      if (source === 'back') continue;
      if (source === 'reset') { updateSourceConfigCommand(context, ['reset']); continue; }
      const location = await askCliText(context.locale, source === 'file' ? text('Caminho do arquivo', 'File path')
        : source === 'github' ? text('URL do repositório GitHub', 'GitHub repository URL') : 'URL HTTPS');
      const args = [source, location];
      if (source === 'github') {
        const asset = await askCliText(context.locale, text('Nome do artefato; {version} será substituído', 'Asset name; {version} will be replaced'),
          { defaultValue: `${context.cliName}-{version}.tgz` });
        args.push('--asset-name', asset);
      }
      const authentication = source === 'file' ? 'default' : await askCliChoice(context.locale, text('Acesso às atualizações', 'Update access'), [
        choice(context, 'default', 'Público ou manter o acesso configurado', 'Public or keep configured access'),
        ...(source === 'github' ? [choice(context, 'paste', 'Repositório privado: colar token GitHub (oculto)', 'Private repository: paste GitHub token (hidden)')] : []),
        choice(context, 'environment', 'Avançado: usar uma variável de ambiente', 'Advanced: use an environment variable'),
      ]);
      if (authentication === 'environment') {
        const variable = await askCliValue(context.locale,
          text('Nome da variável (não cole o token aqui)', 'Variable name (do not paste a token here)'), validateTokenEnv,
          { defaultValue: 'GH_TOKEN' });
        args.push('--token-env', variable);
      }
      updateSourceConfigCommand(context, args);
      if (authentication === 'paste') await updateCredentialCommand(context, []);
    } else if (action === 'token') {
      await updateCredentialCommand(context, []);
    } else if (action === 'token-clear') {
      if (await askCliChoice(context.locale, text('Remover a credencial salva?', 'Remove the saved credential?'), [
        choice(context, 'no', 'Não', 'No'), choice(context, 'yes', 'Sim', 'Yes'),
      ]) === 'yes') await updateCredentialCommand(context, ['--clear']);
    } else {
      await autoUpdateCommand(context, ['status']);
      const operation = await askCliChoice(context.locale, text('Atualização automática', 'Automatic updates'), [
        choice(context, 'on', 'Ativar stable', 'Enable stable'), choice(context, 'beta', 'Ativar incluindo beta', 'Enable including beta'),
        choice(context, 'off', 'Desativar', 'Disable'), choice(context, 'back', 'Voltar', 'Back'),
      ]);
      if (operation === 'back') continue;
      if (operation === 'off') await autoUpdateCommand(context, ['off']);
      else {
        const schedule = await askCliText(context.locale, text('Horário diário (HH:MM)', 'Daily time (HH:MM)'), { defaultValue: '04:00' });
        await autoUpdateCommand(context, ['on', schedule, ...(operation === 'beta' ? ['--beta'] : [])]);
      }
    }
  }
}

export async function configurationMenu(context: CliContext): Promise<void> {
  while (true) {
    const action = await askCliChoice(context.locale, cliText(context.locale, 'Configuração', 'Configuration'), [
      choice(context, 'show', 'Mostrar configuração (segredos ocultos)', 'Show configuration (secrets hidden)'),
      choice(context, 'setup', 'Configurar conexão e identidade', 'Configure connection and identity'),
      choice(context, 'edit', 'Alterar uma configuração', 'Change a setting'),
      choice(context, 'updates', 'Atualizações', 'Updates'),
      choice(context, 'back', 'Voltar', 'Back'),
    ]);
    if (action === 'back') return;
    if (action === 'show') await configCommand(context, ['show']);
    else if (action === 'setup') await setupCommand(context, []);
    else if (action === 'updates') await updatesMenu(context);
    else {
      const config = readConfig(context);
      if (!config) { await setupCommand(context, []); continue; }
      const fields = [
        choice(context, 'botName', 'Nome do bot', 'Bot name'), choice(context, 'botDir', 'Pasta de trabalho', 'Working directory'),
        ...(config.mode === 'manual' ? [
          choice(context, 'serverUrl', 'Endereço do servidor', 'Server address'),
          choice(context, 'botToken', 'Token de vínculo Monky (não GitHub)', 'Monky link token (not GitHub)'),
          choice(context, 'tokenEnv', 'Nome da variável do token Monky', 'Monky token environment variable name'),
        ] : [
          choice(context, 'publicHost', 'IP ou domínio público', 'Public IP or domain'),
          choice(context, 'servePort', 'Porta do manifest', 'Manifest port'),
        ]),
        choice(context, 'back', 'Voltar', 'Back'),
      ];
      const key = await askCliChoice(context.locale, cliText(context.locale, 'Qual configuração?', 'Which setting?'), fields);
      if (key === 'back') continue;
      const value = await askCliText(context.locale, fields.find(field => field.value === key)!.label, { secret: key === 'botToken' });
      await configCommand(context, ['set', key, value]);
    }
  }
}

export async function botCliMenu(context: CliContext): Promise<void> {
  while (true) {
    const action = await askCliChoice(context.locale, context.displayName, [
      choice(context, 'setup', 'Configurar bot', 'Set up bot'), choice(context, 'start', 'Iniciar', 'Start'),
      choice(context, 'stop', 'Parar', 'Stop'), choice(context, 'restart', 'Reiniciar', 'Restart'),
      choice(context, 'status', 'Estado do bot', 'Bot status'), choice(context, 'logs', 'Logs recentes', 'Recent logs'),
      choice(context, 'config', 'Configuração', 'Configuration'), choice(context, 'language', 'Idioma / Language', 'Idioma / Language'),
      choice(context, 'exit', 'Sair do menu (mantém o bot)', 'Exit menu (keep the bot running)'),
    ]);
    if (action === 'exit') return;
    if (action === 'setup') await setupCommand(context, []);
    else if (action === 'start') await startCommand(context, []);
    else if (action === 'stop') stopCommand(context, []);
    else if (action === 'restart') await restartCommand(context, []);
    else if (action === 'status') statusCommand(context, []);
    else if (action === 'logs') logsCommand(context, ['--no-follow']);
    else if (action === 'config') await configurationMenu(context);
    else {
      context.locale = await chooseCliLocale(context.locale);
      saveCliLocale(context.homeDir, context.locale);
    }
  }
}
