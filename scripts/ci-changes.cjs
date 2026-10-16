'use strict';

// Decides whether a pull request changes only documentation, so CI can skip the build, package,
// native and DOM lanes and report their required checks as not applicable. Only files positively
// known to be documentation qualify: a wrong "docs only" merges untested code, while a wrong
// "code" only costs CI minutes.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const DOCUMENTATION = [
  /^[^/]+\.md$/u,
  /^docs\/.+\.md$/u,
  // No CI job builds the site; its theme, generators and installers are code.
  /^docs-site\/(?!\.vitepress\/|scripts\/).+\.(?:md|mmd|png|jpe?g|gif|webp|svg)$/u,
];

// Pages that ship as package READMEs (scripts/pack-bot-sdk.js, scripts/pack-cli.js), which the
// "Bot interactions and SDK package" job packs and installs.
const PACKAGED_PAGES = new Set([
  'docs-site/bots-desenvolvimento.md',
  'docs-site/en/bots-desenvolvimento.md',
  'docs-site/cli.md',
]);

function isDocumentation(file) {
  return !PACKAGED_PAGES.has(file) && DOCUMENTATION.some(pattern => pattern.test(file));
}

function docsOnly(files) {
  return files.length > 0 && files.every(isDocumentation);
}

// A pull_request run checks out the PR merged into its base, and the first parent is that base.
function changedFiles(git = args => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) {
  git(['rev-parse', '--verify', 'HEAD^2']);
  return git(['--no-pager', 'diff', '--no-renames', '--name-only', '-z', 'HEAD^1', 'HEAD', '--'])
    .split('\0').filter(Boolean);
}

function main() {
  let result = false;
  try {
    const files = changedFiles();
    for (const file of files) console.log(`${isDocumentation(file) ? 'documentação' : 'código      '}  ${file}`);
    result = docsOnly(files);
  } catch (error) {
    console.log(`::warning::Não foi possível ler o diff do PR (${error.message.trim()}). Todas as lanes vão rodar.`);
  }
  console.log(result
    ? 'PR só de documentação: as demais lanes são marcadas como não aplicáveis.'
    : 'O PR muda mais do que documentação: todas as lanes rodam.');
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `docs-only=${result}\n`);
}

module.exports = { isDocumentation, docsOnly, changedFiles, PACKAGED_PAGES };
if (require.main === module) main();
