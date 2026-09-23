import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const entry = path.join(root, 'packages', 'bot-sdk', 'src', 'index.ts');
const check = process.argv.includes('--check');
if (process.argv.slice(2).some(argument => argument !== '--check')) {
  throw new Error('Usage: node docs-site\\scripts\\generate-bot-reference.mjs [--check]');
}

const configFile = path.join(root, 'packages', 'bot-sdk', 'tsconfig.json');
const config = ts.readConfigFile(configFile, ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configFile));
if (parsed.errors.length) throw new Error(parsed.errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
const program = ts.createProgram([entry], {
  ...parsed.options,
  noEmit: true,
  baseUrl: root,
  paths: { '@monky/shared': ['packages/shared/src/index.ts'] },
});
const checker = program.getTypeChecker();
const source = program.getSourceFile(entry);
const moduleSymbol = source && checker.getSymbolAtLocation(source);
if (!moduleSymbol) throw new Error('The public SDK entry point could not be loaded.');
const exports = checker.getExportsOfModule(moduleSymbol);
const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: false });
const format = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias;
const guideTitles = {
  'bots-conexao': ['Conexão', 'Connection'],
  'bots-comandos': ['Comandos', 'Commands'],
  'bots-permissoes': ['Permissões', 'Permissions'],
  'bots-interacoes': ['Interações', 'Interactions'],
  'bots-configuracao': ['Configurações', 'Settings'],
  'bots-audio': ['Áudio', 'Audio'],
  'bots-voz': ['Voz', 'Voice'],
  'bots-miniapps': ['Miniapps', 'Miniapps'],
  'bots-execucao-local': ['Execução local', 'Local execution'],
  'bots-distribuicao': ['Distribuição', 'Distribution'],
};

const groups = {
  client: {
    file: 'bots-api-cliente',
    titles: ['BotClient e contextos', 'BotClient and contexts'],
    guides: ['bots-conexao', 'bots-comandos', 'bots-permissoes'],
    items: [],
  },
  interactions: {
    file: 'bots-api-interacoes',
    titles: ['Tipos de comandos e interações', 'Command and interaction types'],
    guides: ['bots-interacoes', 'bots-configuracao', 'bots-audio'],
    items: [],
  },
  media: {
    file: 'bots-api-midia',
    titles: ['Tipos de mídia e execução local', 'Media and local execution types'],
    guides: ['bots-voz', 'bots-miniapps', 'bots-execucao-local'],
    items: [],
  },
  tools: {
    file: 'bots-api-ferramentas',
    titles: ['CLI, utilitários e constantes', 'CLI, utilities and constants'],
    guides: ['bots-distribuicao'],
    items: [],
  },
};

function groupFor(name, declaration) {
  const file = declaration.getSourceFile().fileName;
  if (/^[A-Z_]+$/.test(name)) return groups.tools;
  if (/managedTools|[\\/]cli[\\/]|[\\/]tooling[\\/]|[\\/]constants\.ts|[\\/]protocol\.ts/.test(file)
    && !['BotManifest', 'CommandResponsePayload'].includes(name)) return groups.tools;
  if (/^(BotVoice|BotScreen|Local)/.test(name)) return groups.media;
  if (path.resolve(file) === entry || ['BotCapability', 'BotPermissions', 'BotManifest'].includes(name)) return groups.client;
  return groups.interactions;
}

function typeText(type, declaration) {
  if (type.flags & ts.TypeFlags.Any) throw new Error(`Unresolved public type at ${declaration.getSourceFile().fileName}:${declaration.pos}`);
  return checker.typeToString(type, declaration, format);
}

function signature(node, name) {
  const parameters = node.parameters.map((parameter, index) => {
    const optional = parameter.questionToken || parameter.initializer;
    const type = parameter.type?.getText()
      ?? checker.typeToString(checker.getTypeAtLocation(parameter), parameter, ts.TypeFormatFlags.NoTruncation);
    const name = ts.isIdentifier(parameter.name) ? parameter.name.getText() : `argument${index}`;
    return `${parameter.dotDotDotToken ? '...' : ''}${name}${optional ? '?' : ''}: ${type}`;
  }).join(', ');
  const generics = node.typeParameters?.length
    ? `<${node.typeParameters.map(parameter => parameter.getText()).join(', ')}>` : '';
  const resolved = checker.getSignatureFromDeclaration(node);
  if (!resolved) throw new Error(`Cannot resolve public signature: ${name}`);
  const result = node.type?.getText()
    ?? typeText(checker.getReturnTypeOfSignature(resolved), node);
  return `${name}${generics}(${parameters})${ts.isConstructorDeclaration(node) || ts.isSetAccessorDeclaration(node) ? '' : `: ${result}`};`;
}

function classText(name, declaration) {
  const members = [];
  for (const member of declaration.members) {
    if (member.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.PrivateKeyword
      || modifier.kind === ts.SyntaxKind.ProtectedKeyword)
      || (member.name && ts.isPrivateIdentifier(member.name))) continue;
    const prefix = member.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword) ? 'static ' : '';
    if (ts.isConstructorDeclaration(member)) {
      members.push(signature(member, 'constructor'));
      for (const parameter of member.parameters) {
        if (!parameter.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.PublicKeyword
          || modifier.kind === ts.SyntaxKind.ReadonlyKeyword)
          || parameter.modifiers.some(modifier => modifier.kind === ts.SyntaxKind.PrivateKeyword
            || modifier.kind === ts.SyntaxKind.ProtectedKeyword)) continue;
        const readonly = parameter.modifiers.some(modifier => modifier.kind === ts.SyntaxKind.ReadonlyKeyword) ? 'readonly ' : '';
        members.push(`${readonly}${parameter.name.getText()}: ${parameter.type?.getText()
          ?? typeText(checker.getTypeAtLocation(parameter), parameter)};`);
      }
    }
    else if (ts.isMethodDeclaration(member)) members.push(signature(member, `${prefix}${member.name.getText()}${member.questionToken ? '?' : ''}`));
    else if (ts.isGetAccessorDeclaration(member)) members.push(signature(member, `${prefix}get ${member.name.getText()}`));
    else if (ts.isSetAccessorDeclaration(member)) members.push(signature(member, `${prefix}set ${member.name.getText()}`));
    else if (ts.isPropertyDeclaration(member)) {
      const readonly = member.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ReadonlyKeyword) ? 'readonly ' : '';
      members.push(`${prefix}${readonly}${member.name.getText()}${member.questionToken ? '?' : ''}: ${
        member.type?.getText() ?? typeText(checker.getTypeAtLocation(member), member)
      };`);
    }
    else if (!ts.isSemicolonClassElement(member)) throw new Error(`Unsupported public class member in ${name}: ${ts.SyntaxKind[member.kind]}`);
  }
  const heritage = declaration.heritageClauses?.map(clause => clause.getText()).join(' ') ?? '';
  return `export class ${name}${heritage ? ` ${heritage}` : ''} {\n${members.map(member => `  ${member}`).join('\n')}\n}`;
}

function declarationText(name, symbol, declaration) {
  if (ts.isClassDeclaration(declaration)) return classText(name, declaration);
  if (ts.isFunctionDeclaration(declaration)) return `export function ${signature(declaration, name)}`;
  if (ts.isEnumDeclaration(declaration)) return declaration.getText();
  if (ts.isInterfaceDeclaration(declaration)) {
    if (!declaration.heritageClauses?.length) return declaration.getText();
    const type = checker.getDeclaredTypeOfSymbol(symbol);
    const fields = checker.getPropertiesOfType(type).map(property => {
      const location = property.valueDeclaration ?? property.declarations?.[0] ?? declaration;
      const readonly = location.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ReadonlyKeyword) ? 'readonly ' : '';
      const optional = property.flags & ts.SymbolFlags.Optional ? '?' : '';
      const value = checker.typeToString(checker.getTypeOfSymbolAtLocation(property, location), location, ts.TypeFormatFlags.NoTruncation);
      const propertyName = location.name && ts.isComputedPropertyName(location.name) ? location.name.getText() : property.name;
      return `  ${readonly}${propertyName}${optional}: ${value};`;
    });
    return `export interface ${name} {\n${fields.join('\n')}\n}`;
  }
  if (ts.isTypeAliasDeclaration(declaration)) {
    const type = checker.getDeclaredTypeOfSymbol(symbol);
    const generics = declaration.typeParameters?.length
      ? `<${declaration.typeParameters.map(parameter => parameter.getText()).join(', ')}>` : '';
    return `export type ${name}${generics} = ${typeText(type, declaration)};`;
  }
  if (ts.isVariableDeclaration(declaration)) {
    const type = checker.getTypeOfSymbolAtLocation(symbol, declaration);
    if (name.endsWith('Schema')) {
      const input = type.getProperty('_input');
      const output = type.getProperty('_output');
      if (!input || !output) throw new Error(`Missing Zod input/output contracts: ${name}`);
      return `type Input = ${typeText(checker.getTypeOfSymbolAtLocation(input, declaration), declaration)};\n\ntype Output = ${
        typeText(checker.getTypeOfSymbolAtLocation(output, declaration), declaration)
      };`;
    }
    if (declaration.initializer && /^[A-Z_]+$/.test(name)) return `export const ${name} = ${declaration.initializer.getText()};`;
    return `export const ${name}: ${typeText(type, declaration)};`;
  }
  throw new Error(`Unsupported public declaration ${name}: ${ts.SyntaxKind[declaration.kind]}`);
}

function formatted(code, name) {
  const file = ts.createSourceFile('reference.ts', code, ts.ScriptTarget.Latest, true);
  if (file.parseDiagnostics.length) throw new Error(`Invalid public reference for ${name}:\n` + file.parseDiagnostics.map(error =>
    ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
  function rejectUnresolvedTypes(node) {
    if (node.kind === ts.SyntaxKind.AnyKeyword) throw new Error(`The public signature for ${name} contains an unresolved any type.`);
    ts.forEachChild(node, rejectUnresolvedTypes);
  }
  rejectUnresolvedTypes(file);
  return printer.printFile(file).trim();
}

const seen = new Set();
for (const exported of exports) {
  const name = exported.getName();
  if (seen.has(name)) throw new Error(`Duplicate public export: ${name}`);
  seen.add(name);
  const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
  const declaration = symbol.declarations?.find(node => !ts.isExportSpecifier(node));
  if (!declaration) throw new Error(`No source declaration for ${name}`);
  const file = declaration.getSourceFile();
  const line = file.getLineAndCharacterOfPosition(declaration.getStart()).line + 1;
  const relative = path.relative(root, file.fileName).split(path.sep).join('/');
  if (relative.startsWith('../') || relative.includes('node_modules/')) throw new Error(`Unexpected SDK export origin: ${name}`);
  groupFor(name, declaration).items.push({
    name,
    code: formatted(declarationText(name, symbol, declaration), name),
    url: `https://github.com/MonkyOrg/Monky/blob/main/${relative}#L${line}`,
    schema: name.endsWith('Schema'),
  });
}

let outdated = false;
for (const group of Object.values(groups)) {
  group.items.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const [language, directory] of [[0, ''], [1, 'en']]) {
    const en = language === 1;
    const prefix = en ? '/en' : '';
    const lead = en
      ? 'Complete public signatures of the Monky bot SDK, generated from the TypeScript entry point of `@monky/bot-sdk`. Optional fields use `?`; `readonly` fields must not be mutated. The source links include validation rules and implementation details.'
      : 'Assinaturas públicas completas do SDK de bots do Monky, geradas da entrada TypeScript de `@monky/bot-sdk`. Campos opcionais usam `?`; campos `readonly` não devem ser alterados. Os links de origem incluem regras de validação e detalhes da implementação.';
    const guides = group.guides.map(page => `[${guideTitles[page][language]}](${prefix}/${page})`).join(' · ');
    const sections = group.items.map(item => {
      const schema = item.schema
        ? en
          ? '\nThis is a Zod validator. `parse(value)` returns `Output` or throws; `safeParse(value)` returns a discriminated success/error result. `Input` describes the accepted structural shape; the source also enforces refinements and size limits.\n'
          : '\nEste é um validador Zod. `parse(valor)` retorna `Output` ou lança erro; `safeParse(valor)` retorna um resultado discriminado de sucesso/erro. `Input` descreve a estrutura aceita; a origem também aplica refinamentos e limites de tamanho.\n'
        : '';
      return `## \`${item.name}\` {#${item.name.toLowerCase()}}\n\n[${en ? 'Source and validation' : 'Origem e validação'}](${item.url})\n${schema}\n\`\`\`ts\n${item.code}\n\`\`\``;
    }).join('\n\n');
    const content = `---\noutline: 2\n---\n<!-- Generated by docs-site/scripts/generate-bot-reference.mjs. Do not edit by hand. -->\n\n# ${group.titles[language]}\n\n${lead}\n\n[${en ? 'Bot SDK overview and events' : 'Visão geral do SDK de bots e eventos'}](${prefix}/bots-api) · ${guides}\n\n${sections}\n`;
    const filename = path.join(root, 'docs-site', directory, `${group.file}.md`);
    if (check) {
      if (!fs.existsSync(filename) || fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n') !== content) {
        console.error(`Outdated SDK reference: ${path.relative(root, filename)}`);
        outdated = true;
      }
    } else {
      fs.writeFileSync(filename, content);
    }
  }
}
if (outdated) process.exitCode = 1;
else console.log(`${check ? 'Verified' : 'Generated'} ${seen.size} SDK exports in ${Object.keys(groups).length} PT/EN reference pairs.`);
