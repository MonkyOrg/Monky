import type { GlobalArgs } from '../context';
import { withContext } from '../context';
import { resolveTargetServer } from '../target';
import { askChoice } from '../prompts';
import {
  getCliLanguage, normalizeCliLanguage, persistLanguage, setCliLanguage, SUPPORTED_CLI_LANGUAGES, t,
} from '../i18n';
import { showConfig } from './config';

export async function cliLanguageCommand(args: string[]): Promise<void> {
  if (args.length > 1 || (args.length === 1 && !normalizeCliLanguage(args[0]))) {
    throw new Error(t('language.configUsage'));
  }
  let selected = args.length ? normalizeCliLanguage(args[0]) : null;
  if (!args.length && process.stdin.isTTY && process.stdout.isTTY && !process.env.CI) {
    const label = await askChoice(t('language.selectPrompt'), SUPPORTED_CLI_LANGUAGES.map(language => language.label));
    selected = SUPPORTED_CLI_LANGUAGES.find(language => language.label === label)?.code ?? null;
    if (!selected) throw new Error(t('language.invalidSelection'));
  }
  if (selected) {
    persistLanguage(selected);
    setCliLanguage(selected);
    process.env.MONKY_LANG = selected;
  }
  console.log(t(selected ? 'language.saved' : 'language.current', {
    language: getCliLanguage() === 'en' ? 'en-US' : 'pt-BR',
  }));
}

export async function cliSettingsMenu(globalArgs: GlobalArgs): Promise<void> {
  while (true) {
    const options = [
      { id: 'language', label: t('cliSettings.language') },
      { id: 'server', label: t('cliSettings.server') },
      { id: 'back', label: t('cliSettings.back') },
    ];
    const selected = await askChoice(t('cliSettings.title'), options.map(option => option.label));
    const action = options.find(option => option.label === selected)?.id;
    if (action === 'back') return;
    if (action === 'language') await cliLanguageCommand([]);
    else if (action === 'server') {
      const target = await resolveTargetServer(globalArgs, t('action.manage'));
      await withContext(target.dataDir, showConfig);
    } else throw new Error(t('prompt.invalidOption'));
  }
}
