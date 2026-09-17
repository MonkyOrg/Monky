#!/usr/bin/env node

/**
 * Helper script para automação do fluxo de revisão de PRs no Monky.
 *
 * Comandos:
 *   node pr-helper.js list                 - Lista os PRs abertos
 *   node pr-helper.js checkout <pr_number> - Faz checkout da branch do PR e analisa as mudanças
 *   node pr-helper.js start <target> [scenario] [QA options] - Compila e inicia QA preparado
 */

import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseQaArguments, runQa, scenarios } from '../../../../scripts/qa.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

const args = process.argv.slice(2);
const command = args[0];

// Garantir que diretórios padrão do GitHub CLI e Git estejam no PATH no Windows
function getEnv() {
  const env = { ...process.env };
  const extraPaths = [
    'C:\\Program Files\\GitHub CLI',
    'C:\\Program Files\\Git\\cmd',
    'C:\\Program Files\\Git\\bin',
    `${process.env.LOCALAPPDATA || ''}\\Programs\\GitHub CLI`,
  ].filter(Boolean);

  const currentPath = env.PATH || env.Path || '';
  env.PATH = `${extraPaths.join(path.delimiter)}${path.delimiter}${currentPath}`;
  return env;
}

function run(cmd, inheritStdio = true) {
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      env: getEnv(),
      cwd: repository,
      stdio: inheritStdio ? 'inherit' : 'pipe',
    });
  } catch (error) {
    if (!inheritStdio && error.stderr) {
      console.error(error.stderr);
    }
    throw error;
  }
}

switch (command) {
  case 'list': {
    console.log('\n🔍 Buscando Pull Requests em aberto no Monky...\n');
    try {
      const output = execSync(
        'gh pr list --state open --json number,title,headRefName,author,updatedAt --template "{{range .}}#{{.number}} | {{.title}} | Branch: {{.headRefName}} | Autor: {{.author.login}}{{\\"\\n\\"}}{{end}}"',
        { encoding: 'utf-8', env: getEnv(), cwd: repository }
      );
      if (!output.trim()) {
        console.log('Nenhum Pull Request aberto encontrado.');
      } else {
        console.log(output);
      }
    } catch (err) {
      console.error('Erro ao listar PRs com gh CLI:', err.message);
    }
    break;
  }

  case 'checkout': {
    const prNumber = args[1];
    if (!prNumber) {
      console.error('Uso: node pr-helper.js checkout <numero_do_pr>');
      process.exit(1);
    }

    console.log(`\n🔄 Fazendo checkout do PR #${prNumber}...\n`);
    run(`gh pr checkout ${prNumber}`);

    console.log('\n📂 Analisando arquivos alterados...');
    try {
      const diffFiles = execSync('git --no-pager diff main...HEAD --name-only', { encoding: 'utf-8', env: getEnv(), cwd: repository })
        .split('\n')
        .map((f) => f.trim())
        .filter(Boolean);

      const hasClient = diffFiles.some((f) => f.startsWith('apps/client'));
      const hasServer = diffFiles.some((f) => f.startsWith('apps/server'));
      const hasShared = diffFiles.some((f) => f.startsWith('packages/shared'));
      const hasDocs = diffFiles.some((f) => f.startsWith('docs-site') || f.startsWith('docs'));
      const hasNative = diffFiles.some((f) => f.includes('screen-audio') || f.endsWith('.cpp') || f.endsWith('.h'));

      console.log(`Arquivos modificados (${diffFiles.length}):`);
      diffFiles.forEach((f) => console.log(`  - ${f}`));

      console.log('\n📦 Escopo Detectado:');
      if (hasShared) console.log('  • Contratos compartilhados (@monky/shared)');
      if (hasClient) console.log('  • Cliente Desktop (@monky/client)');
      if (hasServer) console.log('  • Servidor (@monky/server)');
      if (hasDocs) console.log('  • Documentação (docs-site)');
      if (hasNative) console.log('  • Módulo Nativo C++ (@monky/screen-audio)');

      console.log('\n💡 Comandos sugeridos para teste rápido:');
      if (hasShared || hasClient) {
        console.log('  npm run qa -- connected');
      } else if (hasServer) {
        console.log('  npm run qa -- server-settings');
      } else if (hasDocs) {
        console.log('  npm run docs:dev');
      } else {
        console.log('  npm test');
      }
      if (hasShared || hasClient || hasServer) {
        console.log('  Escolha home/login/bot-install/tool-consent quando essa etapa for o alvo; nunca pule o teste.');
        console.log('  Música exige --bot-root explícito; voice usa uma fixture SDK identificada, não MonkyBot.');
      }
    } catch (e) {
      console.error('Não foi possível obter o diff detalhado:', e.message);
    }
    break;
  }

  case 'start': {
    const target = args[1] || 'client';
    console.log(`\n🚀 Preparando e iniciando: ${target}...\n`);

    if (target === 'client' || target === 'server') {
      try {
        const qaArgs = args.slice(2);
        if (target === 'server' && !qaArgs.some(argument => scenarios.includes(argument))) qaArgs.unshift('server-settings');
        const options = parseQaArguments(qaArgs);
        console.log(`🔨 Compilando esta branch para QA ${options.scenario}...`);
        run('npm run build');
        await runQa(options, { log: console.log });
      } catch (error) {
        console.error('QA não ficou pronto:', error);
        process.exitCode = 1;
      }
    } else if (target === 'docs') {
      console.log('✨ Iniciando servidor de docs...');
      run('npm run docs:dev');
    } else {
      console.log(`Alvo desconhecido: ${target}. Opções: client, server, docs`);
    }
    break;
  }

  default:
    console.log(`
Uso do PR Helper:
  node pr-helper.js list                 - Lista os PRs abertos
  node pr-helper.js checkout <pr_number> - Checkout do PR e análise de escopo
  node pr-helper.js start client [scenario] [--bot=fixture | --bot-root <checkout>] [--smoke]
  node pr-helper.js start server [scenario] - QA real; padrão server-settings
  node pr-helper.js start docs              - Inicia VitePress

Cenários: ${scenarios.join(', ')}
Só entregue o ambiente após QA_READY. Não use preparação para pular a etapa sob teste.
`);
    break;
}
