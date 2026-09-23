import fs from 'fs';
import { ANSI, color } from '../constants';
import { GlobalArgs } from '../context';
import {
  findLegacyProcessFor,
  getPm2ProcessName,
  getUpdaterProcessName,
  isPm2Available,
  LEGACY_PM2_PROCESS_NAME,
} from '../pm2';
import { runSync } from '../process';
import { unregisterServer } from '../registry';
import { resolveTargetServer } from '../target';
import { ask, confirm } from '../prompts';
import { countOnlineUsers, resolveServerPort } from '../onlineUsers';
import { t } from '../i18n/index';

export async function destroyCommand(globalArgs: GlobalArgs): Promise<void> {
  // resolveTargetServer only returns directories that actually hold a Monky
  // database, which keeps this "rm -rf" from ever pointing at an arbitrary
  // folder someone typed by mistake.
  const target = await resolveTargetServer(globalArgs, t('action.destroy'));
  const dataDir = target.dataDir;

  console.log(color(t('destroy.warning'), ANSI.red));
  console.log(color(t('destroy.allDataWillBeDeleted', { dataDir }), ANSI.red));
  console.log(t('destroy.database'));
  console.log(t('destroy.attachments'));
  console.log(t('destroy.avatars'));
  console.log(t('destroy.settings'));
  console.log();

  // Warn about live sessions before the typed confirmation, so the owner knows
  // what is at stake while deciding (#334).
  const onlineUsers = await countOnlineUsers(resolveServerPort(target));
  if (onlineUsers !== null && onlineUsers > 0) {
    console.log(
      color(onlineUsers === 1 ? t('destroy.onlineOne') : t('destroy.onlineMany', { count: onlineUsers }), ANSI.yellow)
    );
    console.log();
  }

  const confirmText = await ask(t('destroy.typeDestroy'));
  if (confirmText !== 'DESTROY') {
    console.log(color(t('prompt.cancelled'), ANSI.yellow));
    return;
  }

  const doubleConfirm = await confirm(t('destroy.doubleConfirm'), false);
  if (!doubleConfirm) {
    console.log(color(t('prompt.cancelled'), ANSI.yellow));
    return;
  }

  if (isPm2Available()) {
    const names = [getPm2ProcessName(dataDir), getUpdaterProcessName(dataDir)];
    // The pre-registry process is only removed when it belongs to this data
    // directory — another server could be the one still using the old name.
    if (findLegacyProcessFor(dataDir)) {
      names.push(LEGACY_PM2_PROCESS_NAME);
    }
    for (const name of names) {
      runSync('pm2', ['delete', name], { stdio: 'ignore' });
    }
    runSync('pm2', ['save'], { stdio: 'ignore' });
  }

  await fs.promises.rm(dataDir, { recursive: true, force: true });
  unregisterServer(dataDir);

  console.log(color(t('destroy.success'), ANSI.green));
}
