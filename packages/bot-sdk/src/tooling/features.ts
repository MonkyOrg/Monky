import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { botFormSchema, LIMITS, selectionChoicesSchema, type BotFormField, type BotLocale } from '@monky/shared';
import { askCliChoice, askCliValue } from '../cli/prompts';
import { CliError, cliText, isInteractiveCliAccess } from '../cli/locale';
import { isRecord, loadBotProject } from './config';
import { FEATURE_KINDS, featureFile, featureRegistry, featureSource, type BotFeature, type FeatureKind } from './featureTemplates';

export { FEATURE_KINDS, type BotFeature, type FeatureKind } from './featureTemplates';
const REGISTRY = 'src/bot.generated.ts';

export function validateFeatureName(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(value) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|constructor|prototype)$/i.test(value)) {
    throw new CliError('Use um nome de 1 a 32 letras minúsculas, números, hífen ou sublinhado, começando por uma letra; nomes reservados não são aceitos.',
      'Use 1–32 lowercase letters, digits, hyphens or underscores, starting with a letter; reserved names are not allowed.');
  }
  return value;
}

export function validateFeature(value: unknown): BotFeature {
  if (!isRecord(value)) throw new CliError('Funcionalidade inválida.', 'Invalid feature.');
  const name = validateFeatureName(value.name);
  const allowed = value.kind === 'form' ? ['kind', 'name', 'fields']
    : value.kind === 'selector' ? ['kind', 'name', 'choices', 'public'] : ['kind', 'name'];
  if (Object.keys(value).some(key => !allowed.includes(key))) {
    throw new CliError('A funcionalidade contém uma propriedade desconhecida.', 'The feature contains an unknown property.');
  }
  switch (value.kind) {
    case 'command': case 'screen': case 'settings': return { kind: value.kind, name };
    case 'form': {
      const form = botFormSchema.safeParse({ title: name, fields: value.fields });
      if (!form.success) throw new CliError('Campos do formulário inválidos; confira nomes, tipos, limites e escolhas.',
        'Invalid form fields; check names, types, limits and choices.');
      return { kind: 'form', name, fields: form.data.fields };
    }
    case 'selector': {
      const choices = selectionChoicesSchema.min(1).max(LIMITS.MAX_BOT_FORM_CHOICES).safeParse(value.choices);
      if (!choices.success || typeof value.public !== 'boolean' ||
          new Set(choices.data.map(choice => choice.value)).size !== choices.data.length) {
        throw new CliError('Opções do seletor inválidas; use valores únicos e uma visibilidade explícita.',
          'Invalid selector choices; use unique values and explicit visibility.');
      }
      return { kind: 'selector', name, choices: choices.data, public: value.public };
    }
    default: throw new CliError('Tipo desconhecido. Use command, form, selector, settings ou screen.',
      'Unknown feature kind. Use command, form, selector, settings or screen.');
  }
}

export function validateFeatures(value: unknown): BotFeature[] {
  if (!Array.isArray(value) || value.length > LIMITS.MAX_COMMANDS_PER_BOT + 1) {
    throw new CliError('Lista de funcionalidades inválida ou acima do limite.', 'Invalid feature list or feature limit exceeded.');
  }
  const features = value.map(validateFeature);
  if (new Set(features.map(feature => feature.name)).size !== features.length ||
      features.filter(feature => feature.kind === 'settings').length > 1 ||
      features.filter(feature => feature.kind !== 'settings').length > LIMITS.MAX_COMMANDS_PER_BOT) {
    throw new CliError('Nomes de funcionalidades devem ser únicos; apenas um módulo de configurações é permitido.',
      'Feature names must be unique; only one settings module is allowed.');
  }
  return features;
}

export function featureProjectFiles(features: readonly BotFeature[]): Record<string, string> {
  return Object.fromEntries([
    [REGISTRY, featureRegistry(features)],
    ...features.map(feature => [featureFile(feature), featureSource(feature)]),
  ]);
}

function safePath(root: string, relative: string): string {
  let current = root;
  const parts = relative.split('/');
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
        throw new CliError('O gerador não altera links ou caminhos de tipo inesperado.', 'The generator does not modify links or unexpected path types.');
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
  return current;
}

function replaceFile(file: string, content: string): void {
  const pending = path.join(path.dirname(file), `.monky-sdk-${randomUUID()}.pending`);
  const descriptor = fs.openSync(pending, 'wx', fs.statSync(file).mode & 0o777);
  let replaced = false;
  try {
    try { fs.writeFileSync(descriptor, content); } finally { fs.closeSync(descriptor); }
    fs.renameSync(pending, file);
    replaced = true;
  } finally {
    if (!replaced) fs.rmSync(pending, { force: true });
  }
}

export function addBotFeature(root: string, input: BotFeature): string {
  const project = loadBotProject(root);
  const manifestFile = safePath(project.root, 'package.json');
  const registryFile = safePath(project.root, REGISTRY);
  const metadata = project.manifest.monkyBotDevelopment;
  if (!isRecord(metadata) || metadata.version !== 1 ||
      Object.keys(metadata).some(key => !['version', 'features'].includes(key))) {
    throw new CliError('Este projeto não possui o registro gerenciado desta versão do SDK. Use create para um projeto novo; projetos manuais continuam aceitando build e cli, sem migração automática.',
      'This project has no managed registry for this SDK version. Use create for a new project; manual projects still support build and cli, without automatic migration.');
  }
  const previous = validateFeatures(metadata.features);
  for (const existing of previous) {
    if (!fs.existsSync(safePath(project.root, featureFile(existing)))) {
      throw new CliError('Um módulo já registrado está ausente. Restaure o arquivo antes de adicionar funcionalidades.',
        'A registered module is missing. Restore it before adding features.');
    }
  }
  const feature = validateFeature(input);
  const features = validateFeatures([...previous, feature]);
  const destination = safePath(project.root, featureFile(feature));
  if (fs.existsSync(destination)) throw new CliError('O arquivo da funcionalidade já existe; nenhum arquivo foi alterado.',
    'The feature file already exists; no files were changed.');
  const registryBefore = fs.readFileSync(registryFile, 'utf8');
  if (registryBefore.replace(/\r\n/g, '\n') !== featureRegistry(previous)) {
    throw new CliError('O registro src/bot.generated.ts foi editado fora do gerador. Preserve suas mudanças antes de restaurar o registro; nenhum arquivo foi alterado.',
      'The src/bot.generated.ts registry was edited outside the generator. Preserve your changes before restoring the registry; no files were changed.');
  }
  const manifestBefore = fs.readFileSync(manifestFile, 'utf8');
  if (JSON.stringify(JSON.parse(manifestBefore)) !== JSON.stringify(project.manifest)) {
    throw new CliError('O projeto mudou durante a operação; execute novamente.', 'The project changed during this operation; run it again.');
  }
  const registryAfter = featureRegistry(features);
  const manifestAfter = JSON.stringify({
    ...project.manifest, monkyBotDevelopment: { version: 1, features },
  }, null, 2) + '\n';
  const lockFile = path.join(project.root, '.monky-sdk-add.lock');
  let lock: number;
  try { lock = fs.openSync(lockFile, 'wx', 0o600); } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw new CliError('Já existe uma operação do gerador. Confira .monky-sdk-add.lock antes de tentar novamente.',
        'A generator operation already exists. Check .monky-sdk-add.lock before trying again.');
    }
    throw error;
  }
  const createdDirectories: string[] = [];
  let created = false, registryChanged = false;
  try {
    fs.writeFileSync(lock, `${process.pid}\n`);
    if (fs.readFileSync(manifestFile, 'utf8') !== manifestBefore || fs.readFileSync(registryFile, 'utf8') !== registryBefore) {
      throw new CliError('O projeto mudou durante a operação; execute novamente.', 'The project changed during this operation; run it again.');
    }
    const directory = path.dirname(destination);
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory);
      createdDirectories.push(directory);
    }
    const descriptor = fs.openSync(destination, 'wx', 0o644);
    created = true;
    try { fs.writeFileSync(descriptor, featureSource(feature)); } finally { fs.closeSync(descriptor); }
    replaceFile(registryFile, registryAfter);
    registryChanged = true;
    replaceFile(manifestFile, manifestAfter);
  } catch (error) {
    const failures = [error instanceof Error ? error.message : String(error)];
    try {
      if (registryChanged) {
        if (fs.readFileSync(registryFile, 'utf8') !== registryAfter) throw new Error('Registry changed concurrently; automatic rollback refused.');
        replaceFile(registryFile, registryBefore);
      }
      if (created) fs.unlinkSync(destination);
      for (const directory of createdDirectories.reverse()) {
        if (fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
      }
    } catch (rollbackError) {
      failures.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
    }
    throw new CliError(`Não foi possível adicionar a funcionalidade: ${failures.join('; ')}`,
      `Could not add the feature: ${failures.join('; ')}`);
  } finally {
    fs.closeSync(lock);
    fs.unlinkSync(lockFile);
  }
  return destination;
}

function fieldFromArgument(value: string): BotFormField {
  const [name, type, ...extra] = value.split(':');
  if (extra.length && type !== 'select') throw new CliError('Use --field nome:text|integer|boolean|string-list ou nome:select:A,B.',
    'Use --field name:text|integer|boolean|string-list or name:select:A,B.');
  validateFeatureName(name);
  switch (type) {
    case 'text': return { name, type, label: name, required: true, maxLength: 200 };
    case 'integer': return { name, type, label: name, required: true, min: 0, max: 100 };
    case 'boolean': return { name, type, label: name, defaultValue: false };
    case 'string-list': return { name, type, label: name, required: true, minItems: 1, maxItems: 5, maxLength: 80 };
    case 'select': return { name, type, label: name, required: true, choices: extra.join(':').split(',')
      .map(label => label.trim()).filter(Boolean).map((label, index) => ({ label, value: `option${index + 1}` })) };
    default: throw new CliError('Tipo de campo inválido. Use text, integer, boolean, string-list ou select.',
      'Invalid field type. Use text, integer, boolean, string-list or select.');
  }
}

export async function askBotFeature(
  args: string[], locale: BotLocale, existingNames: readonly string[] = [],
): Promise<BotFeature> {
  const text = (pt: string, en: string): string => cliText(locale, pt, en);
  const positional: string[] = [], fields: BotFormField[] = [], labels: string[] = [];
  let isPublic = false, visibilitySpecified = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (['--non-interactive', '--yes', '-y'].includes(argument)) continue;
    if (argument === '--public' || argument === '--private') {
      if (visibilitySpecified) throw new CliError('Informe a visibilidade apenas uma vez.', 'Specify visibility only once.');
      isPublic = argument === '--public';
      visibilitySpecified = true;
    } else if (argument === '--field' || argument === '--choice') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new CliError('A opção precisa de um valor.', 'The option requires a value.');
      if (argument === '--field') fields.push(fieldFromArgument(value));
      else labels.push(value);
    } else if (!argument.startsWith('-')) positional.push(argument);
    else throw new CliError('Opção de add desconhecida.', 'Unknown add option.');
  }
  if (positional.length > 2) throw new CliError('Use add [tipo] [nome].', 'Use add [kind] [name].');
  const interactive = isInteractiveCliAccess(args);
  let kind: string | undefined = positional[0], name = positional[1];
  if (!kind && interactive) {
    kind = await askCliChoice(locale, text('Qual funcionalidade?', 'Which feature?'), [
      { value: 'command', label: text('Comando', 'Command') },
      { value: 'form', label: text('Formulário privado', 'Private form') },
      { value: 'selector', label: text('Seletor ou votação', 'Selector or poll') },
      { value: 'settings', label: text('Configurações do bot', 'Bot settings') },
      { value: 'screen', label: text('Miniapp no palco de voz', 'Voice-stage miniapp') },
    ]);
  }
  if (!FEATURE_KINDS.some(value => value === kind)) throw new CliError('Escolha command, form, selector, settings ou screen.',
    'Choose command, form, selector, settings or screen.');
  if (kind === 'settings') name ??= 'settings';
  if (!name && interactive) {
    name = await askCliValue(locale, text('Nome da funcionalidade/comando', 'Feature/command name'), value => {
      const valid = validateFeatureName(value);
      if (existingNames.includes(valid)) throw new CliError('Este nome já existe.', 'This name already exists.');
      return valid;
    });
  }
  name = validateFeatureName(name);
  if ((fields.length && kind !== 'form') || (labels.length && kind !== 'selector') ||
      (visibilitySpecified && kind !== 'selector')) {
    throw new CliError('As opções informadas não pertencem a este tipo de funcionalidade.',
      'The supplied options do not belong to this feature kind.');
  }
  if (kind === 'form') {
    if (!fields.length && interactive) {
      let more = true;
      while (more && fields.length < LIMITS.MAX_BOT_FORM_FIELDS) {
        const fieldName = await askCliValue(locale, text('Nome do campo', 'Field name'), value => {
          const valid = validateFeatureName(value);
          if (fields.some(field => field.name === valid)) throw new CliError('O campo já existe.', 'The field already exists.');
          return valid;
        }, { defaultValue: fields.length ? `field${fields.length + 1}` : 'message' });
        const type = await askCliChoice(locale, text('Tipo do campo', 'Field type'), [
          { value: 'text', label: text('Texto', 'Text') }, { value: 'integer', label: text('Número inteiro', 'Integer') },
          { value: 'boolean', label: text('Liga/desliga', 'On/off') }, { value: 'string-list', label: text('Lista de textos', 'Text list') },
          { value: 'select', label: text('Lista de escolhas', 'Choice list') },
        ]);
        const choices = type === 'select' ? await askCliValue(locale,
          text('Opções separadas por vírgula', 'Comma-separated choices'), value => {
            const field = fieldFromArgument(`${fieldName}:select:${value}`);
            validateFeature({ kind: 'form', name, fields: [field] });
            return value;
          }) : undefined;
        fields.push(fieldFromArgument(`${fieldName}:${type}${choices ? `:${choices}` : ''}`));
        more = fields.length < LIMITS.MAX_BOT_FORM_FIELDS && await askCliChoice(locale, text('Adicionar outro campo?', 'Add another field?'), [
          { value: 'no', label: text('Concluir formulário', 'Finish form') }, { value: 'yes', label: text('Adicionar campo', 'Add field') },
        ]) === 'yes';
      }
    }
    if (!fields.length) fields.push(fieldFromArgument('message:text'));
    return validateFeature({ kind, name, fields });
  }
  if (kind === 'selector') {
    if (interactive && !visibilitySpecified) {
      isPublic = await askCliChoice(locale, text('Quem vê o seletor?', 'Who sees the selector?'), [
        { value: 'private', label: text('Somente quem chamou', 'Only the caller') },
        { value: 'public', label: text('Público no canal; requer capacidades aprovadas', 'Public in the channel; requires approved capabilities') },
      ]) === 'public';
    }
    if (!labels.length && interactive) {
      labels.push(...await askCliValue(locale, text('Opções separadas por vírgula', 'Comma-separated choices'), value => {
        const entries = value.split(',').map(label => label.trim()).filter(Boolean);
        if (!entries.length || entries.length > LIMITS.MAX_BOT_FORM_CHOICES) {
          throw new CliError('Informe de 1 a 20 opções.', 'Enter 1–20 choices.');
        }
        return entries;
      }));
    }
    if (!labels.length) labels.push(text('Primeira opção', 'First option'), text('Segunda opção', 'Second option'));
    return validateFeature({ kind, name, public: isPublic, choices: labels.map((label, index) => ({ value: `option${index + 1}`, label })) });
  }
  return validateFeature({ kind, name });
}

export async function addFeatureCommand(args: string[], locale: BotLocale, root = process.cwd()): Promise<void> {
  const project = loadBotProject(root);
  const metadata = project.manifest.monkyBotDevelopment;
  if (!isRecord(metadata) || metadata.version !== 1) {
    throw new CliError('Use add dentro de um projeto criado por esta versão do SDK; nenhum arquivo foi alterado.',
      'Run add in a project created by this SDK version; no files were changed.');
  }
  const features = validateFeatures(metadata.features);
  const feature = await askBotFeature(args, locale, features.map(value => value.name));
  const file = addBotFeature(root, feature);
  console.log(cliText(locale, `Funcionalidade integrada: ${file}`, `Feature registered: ${file}`));
  console.log(cliText(locale, 'Edite esse módulo; depois execute npm run build e monky-bot-sdk doctor.',
    'Edit this module; then run npm run build and monky-bot-sdk doctor.'));
  if (feature.kind === 'screen' || (feature.kind === 'selector' && feature.public)) {
    console.log(cliText(locale, 'As capacidades foram solicitadas, não concedidas. Revise a aprovação no servidor antes de usar.',
      'Capabilities were requested, not granted. Review server approval before use.'));
  }
}
