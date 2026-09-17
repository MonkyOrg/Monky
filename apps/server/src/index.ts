import path from 'path';
import { LIMITS, type ServerShutdownReason } from '@monky/shared';
import { MonkyServer, ServerConfig } from './server';
import { Logger } from './infrastructure/logger/Logger';
import { getLocalVersion } from './cli/commands/update';
import { consumeUpdateRestart } from './infrastructure/lifecycle/updateRestart';

function parseArgs(): ServerConfig {
  const args = process.argv.slice(2);
  const config: ServerConfig = {
    port: LIMITS.DEFAULT_PORT,
    dataDir: path.join(process.cwd(), 'data'),
    version: getLocalVersion(),
    serverName: 'Servidor dos Amigos',
    password: '',
    maxUsers: LIMITS.MAX_USERS_DEFAULT,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--port' && args[i + 1]) {
      config.port = parseInt(args[++i], 10);
    } else if (arg === '--data' && args[i + 1]) {
      config.dataDir = path.resolve(args[++i]);
    } else if (arg === '--name' && args[i + 1]) {
      config.serverName = args[++i];
    } else if (arg === '--password' && args[i + 1]) {
      config.password = args[++i];
    } else if (arg === '--max-users' && args[i + 1]) {
      config.maxUsers = parseInt(args[++i], 10);
    } else if (arg === '--voice-channel' && args[i + 1]) {
      config.initialVoiceChannel = args[++i];
    } else if (arg === '--text-channel' && args[i + 1]) {
      config.initialTextChannel = args[++i];
    }
  }

  return config;
}

async function main() {
  const config = parseArgs();
  const server = await MonkyServer.create(config);

  let shutdown: Promise<void> | undefined;
  const stop = (signal: string): void => {
    if (shutdown) return;
    Logger.info('INFO', `Received ${signal}, shutting down server...`);
    let reason: ServerShutdownReason = 'stopped';
    try { reason = consumeUpdateRestart(config.dataDir); }
    catch (error) { Logger.error('ERROR', 'Could not read the update restart intent.', error); }
    shutdown = server.stop(reason).then(() => { process.exit(0); }, (error: unknown) => {
      Logger.error('ERROR', 'Server shutdown failed.', error);
      process.exit(1);
    });
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('message', (message: unknown) => {
    if (message === 'shutdown') stop('PM2 shutdown');
  });

  await server.start();
}

if (require.main === module) {
  main().catch((err) => {
    Logger.error('ERROR', 'Fatal server crash', err);
    process.exit(1);
  });
}

export { MonkyServer, ServerConfig };
export { Logger } from './infrastructure/logger/Logger';
export type { LogListener } from './infrastructure/logger/Logger';
