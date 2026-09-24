import fs from 'fs';
import path from 'path';
import { LIMITS } from '@monky/shared';
import { PasswordService } from '../../infrastructure/security/PasswordService';
import {
  ANSI,
  color,
  CONFIG_KEYS,
  ConfigKey,
  DEFAULT_SERVER_NAME,
} from '../constants';
import { CliContext, readLocalConfig, writeLocalConfig } from '../context';
import { estimateHostCapacity, printCapacityEstimate } from '../capacity';
import { configKeyLabel, describeSfuPortProblem, describeTurnPortProblem, describeTurnUnavailability, formatBool, formatDate, parseBoolean, parseMemberLimit, parsePositiveInt, parseVoiceMode, printSfuPreflight, printVoiceModeComparisonTable, sfuPreflightSummary } from '../formatters';
import { t } from '../i18n/index';
import {
  getPm2ProcessName,
  isMonkyServerRunning,
  writeEcosystem,
} from '../pm2';
import { runSync } from '../process';
import { registerServer } from '../registry';
import { ask, askChoice, confirm, promptPassword } from '../prompts';
import { disableAutoUpdate, enableAutoUpdate, isAutoUpdateEnabled, AutoUpdateSchedule } from './update';
import { CoturnManager } from '../../infrastructure/turn/CoturnManager';
import { checkSfuPreflight } from '../../infrastructure/sfu/SfuPreflight';

/**
 * Warns, right where the value is shown, when the relay cannot actually run on
 * this host — an operator reading `turn: sim` deserves to know if nothing is
 * relaying because coturn is missing (#425).
 */
function turnStatusSuffix(): string {
  const reason = describeTurnUnavailability(CoturnManager.describeAvailability());
  return reason ? color(`  (${t('config.turnUnavailable', { reason })})`, ANSI.yellow) : '';
}

/**
 * Same intent as {@link turnStatusSuffix}: `voiceMode: sfu` is misleading when
 * the worker cannot run on this host, since the server starts anyway and
 * quietly relays nothing.
 */
function voiceModeStatusSuffix(voiceMode: string): string {
  if (voiceMode !== 'sfu') return '';
  const reason = sfuPreflightSummary(checkSfuPreflight());
  return reason ? color(`  (${t('config.sfuUnavailable', { reason })})`, ANSI.yellow) : '';
}

export async function showConfig(ctx: CliContext): Promise<void> {
  const server = await ctx.serverRepo.getServer();
  if (!server) {
    throw new Error(t('create.serverNotFound'));
  }

  const localConfig = readLocalConfig(ctx.dataDir);
  const owner = server.ownerUserId ? await ctx.userRepo.findById(server.ownerUserId) : null;
  console.log(color(t('config.title'), ANSI.bold));
  console.log(`${t('label.dataDir')}: ${ctx.dataDir}`);
  console.log(`${t('label.id')}: ${server.id}`);
  console.log(`${configKeyLabel('name')}: ${server.name}`);
  console.log(`${configKeyLabel('port')}: ${localConfig.port || LIMITS.DEFAULT_PORT}`);
  console.log(`${t('label.hasPassword')}: ${formatBool(Boolean(server.passwordHash))}`);
  console.log(`${configKeyLabel('maxUsers')}: ${server.maxUsers > LIMITS.MAX_USERS_UNLIMITED ? server.maxUsers : t('config.noLimit')}`);
  console.log(`${configKeyLabel('maxMessageLength')}: ${server.maxMessageLength === 0 ? t('config.noLimit') : server.maxMessageLength ?? LIMITS.MAX_MESSAGE_LENGTH}`);
  console.log(`${t('label.ownerUserId')}: ${server.ownerUserId ?? '-'}`);
  console.log(`${t('label.ownerNickname')}: ${owner?.nickname ?? '-'}`);
  console.log(`${configKeyLabel('allowSoundboard')}: ${formatBool(server.allowSoundboard !== false)}`);
  console.log(`${configKeyLabel('allowEveryoneMention')}: ${formatBool(server.allowEveryoneMention !== false)}`);
  console.log(`${configKeyLabel('showRoleBadgesToEveryone')}: ${formatBool(server.showRoleBadgesToEveryone !== false)}`);
  console.log(`${configKeyLabel('voiceMode')}: ${server.voiceMode || 'p2p'}${voiceModeStatusSuffix(server.voiceMode || 'p2p')}`);
  console.log(`${configKeyLabel('turn')}: ${formatBool(Boolean(server.turnEnabled))}${turnStatusSuffix()}`);
  console.log(`${t('label.iconPath')}: ${server.iconPath ?? '-'}`);
  console.log(`${configKeyLabel('maxAttachmentFileBytes')}: ${server.maxAttachmentFileBytes ?? '-'}`);
  console.log(`${configKeyLabel('maxAttachmentStorageBytes')}: ${server.maxAttachmentStorageBytes ?? '-'}`);
  console.log(`${configKeyLabel('autoUpdate')}: ${formatBool(isAutoUpdateEnabled(ctx.dataDir))}`);
  console.log(`${t('label.createdAt')}: ${formatDate(server.createdAt)}`);
}

export async function askConfigKey(): Promise<ConfigKey> {
  const labels = CONFIG_KEYS.map(configKeyLabel);
  const choice = await askChoice(t('config.whichKey'), labels);
  const key = CONFIG_KEYS[labels.indexOf(choice)];
  if (!key) throw new Error(t('config.unsupportedKey', { key: choice }));
  return key;
}

/**
 * `skipSfuDiagnostics` is set by `monky create`, which already probed the
 * ports, printed the capacity report and ran the preflight before the operator
 * confirmed. Without it the SFU branch below would repeat all three — asking
 * for the upload bandwidth a second time — and, worse, `throw` on a port
 * problem that `create` had deliberately downgraded to a warning, aborting
 * after the database was already bootstrapped (#515).
 */
export async function setConfig(
  ctx: CliContext,
  key: string,
  value?: string,
  options: { skipSfuDiagnostics?: boolean } = {}
): Promise<void> {
  const requestedKey = key.trim() || (await askConfigKey());
  const normalizedKey = CONFIG_KEYS.find((candidate) => candidate === requestedKey);
  if (!normalizedKey) throw new Error(t('config.unsupportedKey', { key: requestedKey }));
  const server = await ctx.serverRepo.getServer();
  if (!server) {
    throw new Error(t('create.serverNotFound'));
  }

  const localConfig = readLocalConfig(ctx.dataDir);

  const currentValues: Record<ConfigKey, string> = {
    name: server.name,
    password: '',
    port: String(localConfig.port || LIMITS.DEFAULT_PORT),
    icon: server.iconPath ?? '',
    maxUsers: String(server.maxUsers),
    maxMessageLength: String(server.maxMessageLength ?? LIMITS.MAX_MESSAGE_LENGTH),
    allowSoundboard: String(server.allowSoundboard !== false),
    allowEveryoneMention: String(server.allowEveryoneMention !== false),
    showRoleBadgesToEveryone: String(server.showRoleBadgesToEveryone !== false),
    voiceMode: server.voiceMode || 'p2p',
    maxAttachmentFileBytes: String(server.maxAttachmentFileBytes ?? ''),
    maxAttachmentStorageBytes: String(server.maxAttachmentStorageBytes ?? ''),
    autoUpdate: String(isAutoUpdateEnabled(ctx.dataDir)),
    turn: String(Boolean(server.turnEnabled)),
  };

  let nextValue = value;
  if (nextValue === undefined) {
    switch (normalizedKey) {
      case 'name':
        nextValue = await ask(t('config.askName'), currentValues.name);
        break;
      case 'password':
        nextValue = await promptPassword(t('config.askPassword'));
        break;
      case 'port':
        nextValue = await ask(t('config.askPort'), currentValues.port);
        break;
      case 'icon':
        nextValue = await ask(t('config.askIcon'));
        break;
      case 'allowSoundboard':
      case 'allowEveryoneMention':
      case 'showRoleBadgesToEveryone':
      case 'autoUpdate':
      case 'turn':
        nextValue = await askChoice(t('config.askBoolean'), ['true', 'false']);
        break;
      case 'voiceMode':
        printVoiceModeComparisonTable();
        nextValue = await askChoice(t('config.askVoiceMode'), ['p2p', 'sfu']);
        break;
      case 'maxUsers':
        nextValue = await ask(t('config.askMaxUsers'), currentValues.maxUsers);
        break;
      case 'maxAttachmentFileBytes':
      case 'maxMessageLength':
      case 'maxAttachmentStorageBytes':
        nextValue = await ask(t('config.askValue', { key: configKeyLabel(normalizedKey) }), currentValues[normalizedKey]);
        break;
      default:
        nextValue = await ask(t('config.askValue', { key: normalizedKey }));
    }
  }

  switch (normalizedKey) {
    case 'name': {
      const nextName = nextValue.trim();
      if (nextName.length < 2) {
        throw new Error(t('config.nameTooShort'));
      }
      await ctx.serverRepo.updateServer({ name: nextName });
      registerServer(ctx.dataDir, { name: nextName });
      break;
    }
    case 'password': {
      const normalizedValue = nextValue.trim().toLowerCase();
      const shouldClear = !nextValue.trim() || ['clear', 'none', 'null', 'empty', 'remove'].includes(normalizedValue);
      await ctx.serverRepo.updateServer({
        passwordHash: shouldClear ? '' : PasswordService.hashPassword(nextValue),
      });
      break;
    }
    case 'port': {
      const portNum = parsePositiveInt('port', nextValue);
      const config = readLocalConfig(ctx.dataDir);
      config.port = portNum;
      writeLocalConfig(ctx.dataDir, config);

      const processName = getPm2ProcessName(ctx.dataDir);
      if (isMonkyServerRunning(processName)) {
        const shouldRestart = await confirm(t('config.restartForPort'), true);
        if (shouldRestart) {
          const ecosystemPath = writeEcosystem({
            dataDir: ctx.dataDir,
            port: portNum,
            serverName: (await ctx.serverRepo.getServer())?.name || DEFAULT_SERVER_NAME,
          });
          runSync('pm2', ['startOrRestart', ecosystemPath], { stdio: 'inherit' });
          console.log(color(t('config.portRestarted'), ANSI.green));
        } else {
          console.log(color(t('config.portNextStartOrRestart'), ANSI.dim));
        }
      } else {
        console.log(color(t('config.portNextStart'), ANSI.dim));
      }
      registerServer(ctx.dataDir, { port: portNum });
      break;
    }
    case 'icon': {
      const iconValue = nextValue.trim();
      if (!iconValue || ['clear', 'none', 'remove'].includes(iconValue.toLowerCase())) {
        await ctx.serverRepo.updateServer({ iconPath: null });
        console.log(color(t('config.iconRemoved'), ANSI.dim));
      } else {
        const resolvedPath = path.resolve(iconValue);
        if (!fs.existsSync(resolvedPath)) {
          throw new Error(t('config.fileNotFound', { path: resolvedPath }));
        }
        const destDir = path.join(ctx.dataDir, 'icons');
        await fs.promises.mkdir(destDir, { recursive: true });
        const ext = path.extname(resolvedPath);
        const destPath = path.join(destDir, `server-icon${ext}`);
        await fs.promises.copyFile(resolvedPath, destPath);
        await ctx.serverRepo.updateServer({ iconPath: destPath });
      }
      break;
    }
    case 'maxUsers': {
      const nextMax = parseMemberLimit(normalizedKey, nextValue);
      // Mirrors the rule enforced over the wire (#403): never leave the server
      // above its own cap, since the only way out would be kicking members.
      if (nextMax > LIMITS.MAX_USERS_UNLIMITED) {
        const memberCount = await ctx.userRepo.count();
        if (nextMax < memberCount) {
          throw new Error(t('config.tooManyMembers', { count: memberCount }));
        }
      }
      await ctx.serverRepo.updateServer({ maxUsers: nextMax });
      break;
    }
    case 'maxMessageLength': {
      if (!/^\d+$/.test(nextValue.trim()) || !Number.isSafeInteger(Number(nextValue))) {
        throw new Error(t('config.invalidMessageLimit'));
      }
      await ctx.serverRepo.updateServer({ maxMessageLength: Number(nextValue) });
      break;
    }
    case 'allowSoundboard':
      await ctx.serverRepo.updateServer({ allowSoundboard: parseBoolean(nextValue) });
      break;
    case 'allowEveryoneMention':
      await ctx.serverRepo.updateServer({ allowEveryoneMention: parseBoolean(nextValue) });
      break;
    case 'showRoleBadgesToEveryone':
      await ctx.serverRepo.updateServer({ showRoleBadgesToEveryone: parseBoolean(nextValue) });
      break;
    case 'voiceMode': {
      const mode = parseVoiceMode(nextValue);

      if (mode === 'sfu' && !options.skipSfuDiagnostics) {
        // Refuse before persisting: the desktop path already blocks the switch
        // when the range is unusable, and the CLI accepting it would be the
        // only way left to end up with a mode the host cannot serve (#515).
        const { SfuManager } = await import('../../infrastructure/sfu/SfuManager');
        const portProblem = await new SfuManager().checkPortAvailability();
        if (portProblem) {
          throw new Error(describeSfuPortProblem(portProblem));
        }
        console.log(color(t('config.sfuPortOk'), ANSI.green));
      }

      await ctx.serverRepo.updateServer({ voiceMode: mode });

      // The SFU is the relay in this mode, so coturn is turned off rather than
      // left running and unused (#515).
      if (mode === 'sfu' && server.turnEnabled) {
        await ctx.serverRepo.updateServer({ turnEnabled: false });
        console.log(color(t('config.turnDisabledBySfu'), ANSI.yellow));
      }

      if (mode === 'sfu' && !options.skipSfuDiagnostics) {
        const report = await estimateHostCapacity();
        printCapacityEstimate(report);
        printSfuPreflight(checkSfuPreflight());
      }

      // Same caveat as `turn`: the running process decided its voice mode at
      // startup, so the new value only takes effect after a reload. Without
      // this the operator sees `voiceMode: sfu` in `monky config` while the
      // server keeps serving P2P (#515).
      if (isMonkyServerRunning(getPm2ProcessName(ctx.dataDir))) {
        console.log(color(t('config.voiceModeRestartNeeded'), ANSI.yellow));
      }
      break;
    }
    case 'turn': {
      const enabled = parseBoolean(nextValue);
      // The SFU already relays every stream, so a second relay would only add
      // cost and fight it for UDP ports. Refused here as well as on the server
      // so neither entry point can produce the combination (#515).
      if (enabled && (server.voiceMode || 'p2p') === 'sfu') {
        throw new Error(t('config.turnBlockedBySfu'));
      }
      if (enabled && !CoturnManager.isInstalled()) {
        // Same intent as the desktop toggle: asking is enough, the server does
        // the installing (#431).
        if (!CoturnManager.isSupportedPlatform()) {
          throw new Error(t('config.turnLinuxOnly'));
        }
        console.log(t('config.installingCoturn'));
        const outcome = await CoturnManager.ensureInstalled();
        if (!outcome.ok) {
          switch (outcome.reason) {
            case 'no-privileges':
              throw new Error(t('config.coturnNoPrivileges'));
            case 'unknown-package-manager':
              throw new Error(t('config.coturnNoPackageManager'));
            default:
              throw new Error(t('config.coturnInstallFailed', { detail: outcome.detail ?? t('common.unknownError') }));
          }
        }
        if (!outcome.alreadyInstalled) {
          console.log(color(t('config.coturnInstalled'), ANSI.green));
        }
      }
      const updates: { turnEnabled: boolean; turnSecret?: string } = { turnEnabled: enabled };
      // Minted once and kept: rotating the secret would invalidate every
      // credential already issued and drop the calls being relayed (#425).
      if (enabled && !server.turnSecret) {
        updates.turnSecret = CoturnManager.generateSecret();
      }
      await ctx.serverRepo.updateServer(updates);

      // The running process holds its own copy of this setting, so the change
      // only takes effect once it reloads.
      if (isMonkyServerRunning(getPm2ProcessName(ctx.dataDir))) {
        console.log(color(t('config.turnRestartNeeded'), ANSI.yellow));
      }
      if (enabled) {
        // Run a real port check instead of a static reminder.
        const portProblem = await CoturnManager.checkPortReachability(describeTurnPortProblem);
        if (portProblem) {
          console.log(color('⚠ ' + portProblem, ANSI.yellow));
        } else {
          console.log(color(t('config.turnPortOk'), ANSI.green));
        }
      }
      break;
    }
    case 'maxAttachmentFileBytes':
      await ctx.serverRepo.updateServer({ maxAttachmentFileBytes: parsePositiveInt(normalizedKey, nextValue) });
      break;
    case 'maxAttachmentStorageBytes':
      await ctx.serverRepo.updateServer({ maxAttachmentStorageBytes: parsePositiveInt(normalizedKey, nextValue) });
      break;
    case 'autoUpdate': {
      const enabled = parseBoolean(nextValue);
      if (enabled) {
        let schedule: AutoUpdateSchedule = { type: 'daily', value: '04:00' };
        if (process.stdin.isTTY) {
          const dailyOption = t('config.autoUpdateDaily');
          const intervalOption = t('config.autoUpdateInterval');
          const scheduleMode = await askChoice(t('config.autoUpdateScheduleType'), [
            dailyOption,
            intervalOption,
          ]);
          if (scheduleMode === intervalOption) {
            const hoursStr = await ask(t('config.autoUpdateHoursInterval'), '2');
            const hours = Math.max(1, parseInt(hoursStr, 10) || 2);
            schedule = { type: 'interval', value: hours };
          } else {
            const timeStr = await ask(t('config.autoUpdateDailyTime'), '04:00');
            schedule = { type: 'daily', value: timeStr.trim() || '04:00' };
          }
        }
        await enableAutoUpdate(ctx.dataDir, schedule);
      } else {
        await disableAutoUpdate(ctx.dataDir);
      }
      break;
    }
    default:
      throw new Error(t('config.unsupportedKey', { key }));
  }

  console.log(color(t('config.updated', { key: normalizedKey }), ANSI.green));
}
