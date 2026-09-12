#!/usr/bin/env node
import path from 'node:path';
import { buildBotPackage, parseBuildArguments } from './tooling/build';
import { loadBotProject } from './tooling/config';

export { parseBuildArguments } from './tooling/build';

export async function runSdkTools(args = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = args;
  if (command === '--version' || command === '-v' || command === 'version') {
    console.log(`monky-bot-sdk ${loadBotProject(path.resolve(__dirname, '..')).manifest.version}`);
    return;
  }
  if (!command || ['--help', '-h', 'help'].includes(command)) {
    console.log(`monky-bot-sdk - bot build and CLI tooling

  monky-bot-sdk build [--out DIR] [--version VERSION] [--skip-build]
  monky-bot-sdk cli <command> [options]

build runs the project's compiler script and creates a self-contained .tgz
with a generated management CLI. Configure it in package.json.monkyBot.
cli runs the same management CLI from the current bot project.`);
    return;
  }
  if (command === 'build') {
    const result = buildBotPackage(parseBuildArguments(rest));
    console.log(`[bot build] ${result.file}`);
    console.log(`[bot build] CLI ${result.cliName}; protocol ${result.protocolVersion}; ${result.packageCount} bundled packages`);
    return;
  }
  if (command === 'cli') {
    const { runBotCli } = await import('./cli');
    await runBotCli(process.cwd(), rest);
    return;
  }
  throw new Error('Unknown SDK tool command. Use monky-bot-sdk --help.');
}

if (require.main === module) {
  void runSdkTools().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'SDK tooling failed.');
    process.exitCode = 1;
  });
}
