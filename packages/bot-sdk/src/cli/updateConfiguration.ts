import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  isRecord, releaseSource, updateSource, type BotPackageDefinition, type BotProject,
} from '../tooling/config';
import type { CliContext } from './config';
import { readJsonFile, writePrivateJson } from './fs';
import { CliError, cliText } from './locale';

type UpdateConfiguration = Pick<BotPackageDefinition, 'releases' | 'updateSource'>;

function preferenceFile(context: CliContext): string {
  return path.join(context.homeDir, 'update-source.json');
}

function invalidSource(): CliError {
  return new CliError(
    'Origem de atualização inválida. Use github com uma URL de repositório, https com uma URL .tgz sem credenciais ou file com um caminho .tgz. Tokens devem ser indicados somente pelo nome da variável de ambiente.',
    'Invalid update source. Use github with a repository URL, https with a credential-free .tgz URL, or file with a .tgz path. Supply tokens only through a named environment variable.',
  );
}

function validateConfiguration(value: unknown, cliName: string): UpdateConfiguration {
  if (!isRecord(value) || Object.keys(value).length !== 1) throw invalidSource();
  try {
    if (value.releases !== undefined) {
      const releases = releaseSource(value.releases, cliName);
      if (releases) return { releases };
    } else if (value.updateSource !== undefined) {
      const source = updateSource(value.updateSource);
      if (source) return { updateSource: source };
    }
  } catch {
    throw invalidSource();
  }
  throw invalidSource();
}

function serializedConfiguration(configuration: UpdateConfiguration): Record<string, unknown> {
  const releases = configuration.releases;
  return releases ? {
    releases: { url: releases.url, assetName: releases.assetName, tokenEnv: releases.tokenEnv },
  } : { updateSource: configuration.updateSource };
}

function readPreference(context: CliContext): UpdateConfiguration | undefined {
  try {
    return validateConfiguration(readJsonFile(preferenceFile(context), 'Update source', 8192), context.cliName);
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw new CliError(
      `Não foi possível ler a origem de atualização salva. Nenhuma origem alternativa será usada. Corrija-a com ${context.cliName} config update-source ou use reset para voltar ao padrão do pacote.`,
      `Could not read the saved update source. No fallback source will be used. Correct it with ${context.cliName} config update-source or use reset to restore the package default.`,
    );
  }
}

export function projectForUpdates(context: CliContext): BotProject {
  const preference = readPreference(context);
  if (!preference) return context.project;
  const { releases, updateSource: source, ...definition } = context.project.definition;
  return { ...context.project, definition: { ...definition, ...preference } };
}

function parseSource(context: CliContext, args: string[]): UpdateConfiguration {
  const [type, location, ...options] = args;
  if (!['github', 'https', 'file'].includes(type) || !location || location.startsWith('--')) throw invalidSource();
  const fields: Record<string, string> = {};
  for (let index = 0; index < options.length; index += 2) {
    const option = options[index];
    const key = option === '--token-env' && type !== 'file' ? 'tokenEnv'
      : option === '--asset-name' && type === 'github' ? 'assetName' : undefined;
    const value = options[index + 1];
    if (!key || !value || value.startsWith('--') || fields[key] !== undefined) throw invalidSource();
    fields[key] = value;
  }
  const configuration = validateConfiguration(type === 'github'
    ? { releases: { url: location, ...fields } }
    : { updateSource: { type, ...(type === 'file' ? { path: location } : { url: location }), ...fields } },
  context.cliName);
  if (configuration.updateSource?.type === 'file') {
    // Operator paths are fixed now, not reinterpreted from a later npm/PM2 working directory.
    configuration.updateSource.path = path.resolve(configuration.updateSource.path);
  }
  return configuration;
}

export function updateSourceConfigCommand(context: CliContext, args: string[]): void {
  const action = args[0] ?? 'show';
  if (action === 'show' || action === 'reset') {
    if (args.length > 1) throw invalidSource();
    if (action === 'reset') {
      try {
        fs.rmSync(preferenceFile(context), { force: true });
      } catch {
        throw new CliError('Não foi possível remover a origem salva.', 'Could not remove the saved update source.');
      }
      console.log(cliText(context.locale, 'Origem padrão do pacote restaurada.', 'Package update source restored.'));
    }
    const preference = readPreference(context);
    const configuration = preference ?? context.project.definition;
    console.log(cliText(context.locale,
      preference ? 'Origem de atualização deste perfil:' : 'Origem de atualização padrão do pacote:',
      preference ? 'Update source for this profile:' : 'Package default update source:'));
    if (!configuration.releases && !configuration.updateSource) {
      console.log(cliText(context.locale, 'Nenhuma origem configurada.', 'No update source configured.'));
    } else {
      console.log(JSON.stringify(serializedConfiguration(configuration), null, 2));
    }
    return;
  }
  const configuration = parseSource(context, args);
  const pending = path.join(context.homeDir, `.update-source-${randomUUID()}.pending`);
  try {
    writePrivateJson(pending, serializedConfiguration(configuration));
    fs.renameSync(pending, preferenceFile(context));
  } catch {
    throw new CliError('Não foi possível salvar a origem; a configuração anterior foi preservada.',
      'Could not save the update source; the previous configuration was preserved.');
  } finally {
    fs.rmSync(pending, { force: true });
  }
  console.log(cliText(context.locale,
    'Origem salva para update e autoupdate, sem alterar o pacote, o perfil do bot ou o canal. Use update --check para verificar.',
    'Source saved for update and autoupdate without changing the package, bot profile, or channel. Use update --check to verify.'));
}
