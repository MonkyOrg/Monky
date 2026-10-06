import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BotProject } from '../tooling/config';
import { isRecord } from '../tooling/config';
import { type CliContext, validateTokenEnv } from './config';
import { CliError, cliText } from './locale';
import { askCliValue } from './prompts';
import { readJsonFile, writePrivateJson } from './fs';
import { projectForUpdates } from './updateConfiguration';
import { validateUpdateToken, GITHUB_TOKEN_CREATION_URL } from './updateReleases';

function credentialFile(context: CliContext): string { return path.join(context.homeDir, 'update-credentials.json'); }

function savedToken(context: CliContext): { repository: string; token: string } | undefined {
  try {
    const file = credentialFile(context);
    if (!fs.lstatSync(file).isFile()) throw new Error('Not a regular credential file.');
    const value = readJsonFile(file, 'Update credential', 16_384);
    if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'repository,token' ||
        typeof value.repository !== 'string' || !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(value.repository)) {
      throw new Error('Invalid update credential.');
    }
    return { repository: value.repository, token: validateUpdateToken(value.token) };
  } catch (error: unknown) {
    if (isRecord(error) && error.code === 'ENOENT') return undefined;
    throw new CliError('Não foi possível ler a credencial de atualização. Use config update-token para substituir ou --clear para remover.',
      'Could not read the update credential. Use config update-token to replace it or --clear to remove it.');
  }
}

export function updateEnvironment(
  context: CliContext, project: BotProject, env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const source = project.definition.releases;
  if (!source) return env;
  const saved = savedToken(context);
  if (!saved || saved.repository.toLowerCase() !== source.repository.toLowerCase() ||
      env[source.tokenEnv]?.trim() || (source.tokenEnv === 'GH_TOKEN' && env.GITHUB_TOKEN?.trim())) return env;
  return { ...env, [source.tokenEnv]: saved.token };
}

export function saveUpdateCredential(context: CliContext, project: BotProject, value: string): void {
  const source = project.definition.releases;
  if (!source) throw new CliError('Configure uma origem GitHub antes de salvar o token.', 'Configure a GitHub source before saving a token.');
  const token = validateUpdateToken(value);
  const pending = path.join(context.homeDir, `.update-credentials-${randomUUID()}.pending`);
  try {
    writePrivateJson(pending, { repository: source.repository, token });
    fs.renameSync(pending, credentialFile(context));
  } catch {
    throw new CliError('Não foi possível salvar a credencial de atualização.', 'Could not save the update credential.');
  } finally {
    fs.rmSync(pending, { force: true });
  }
}

export async function updateCredentialCommand(context: CliContext, args: string[]): Promise<void> {
  const text = (pt: string, en: string): string => cliText(context.locale, pt, en);
  if (args.length === 1 && args[0] === '--clear') {
    fs.rmSync(credentialFile(context), { force: true });
    console.log(text('Credencial salva removida; variáveis de ambiente não foram alteradas.',
      'Saved credential removed; environment variables were not changed.'));
    return;
  }
  if (args.length === 1 && args[0] === '--status') {
    const saved = savedToken(context);
    console.log(saved ? text(`Credencial salva para ${saved.repository}.`, `Credential saved for ${saved.repository}.`)
      : text('Nenhuma credencial salva neste perfil.', 'No credential saved in this profile.'));
    return;
  }
  const project = projectForUpdates(context);
  const source = project.definition.releases;
  if (!source) throw new CliError('Use config update-source github <URL> antes de configurar o token.',
    'Use config update-source github <URL> before configuring a token.');
  let token: string;
  if (args.length === 2 && args[0] === '--from-env') {
    token = validateUpdateToken(process.env[validateTokenEnv(args[1])]);
  } else if (!args.length) {
    console.log(text(
      `Token GitHub para ${source.repository}, não o token de vínculo do bot. Crie um fine-grained token com acesso somente a esse repositório e Contents: Read-only. Organizações podem exigir aprovação.`,
      `GitHub token for ${source.repository}, not the bot link token. Create a fine-grained token limited to that repository with Contents: Read-only. Organizations may require approval.`));
    console.log(GITHUB_TOKEN_CREATION_URL);
    console.log(text(`Alternativa: defina ${source.tokenEnv} no ambiente. --token-env recebe o nome da variável, nunca o token.`,
      `Alternatively, set ${source.tokenEnv} in the environment. --token-env takes a variable name, never the token itself.`));
    token = await askCliValue(context.locale, text('Cole o token GitHub (entrada oculta)', 'Paste the GitHub token (hidden input)'),
      validateUpdateToken, { secret: true });
  } else {
    throw new CliError('Use config update-token, --from-env NOME, --status ou --clear. Nunca passe o token como argumento.',
      'Use config update-token, --from-env NAME, --status or --clear. Never pass a token as an argument.');
  }
  saveUpdateCredential(context, project, token);
  console.log(text('Credencial salva fora do pacote, somente para esse repositório. Use update --check para verificar o acesso.',
    'Credential saved outside the package, only for that repository. Use update --check to verify access.'));
}
