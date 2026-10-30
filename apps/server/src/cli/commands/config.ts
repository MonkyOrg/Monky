import fs from 'fs';
import path from 'path';
import { LIMITS } from '@monky/shared';
import { PasswordService } from '../../infrastructure/security/PasswordService';
import {
  ANSI,
  color,
  CONFIG_KEYS,
  ConfigKey,
} from '../constants';
import { CliContext, GlobalArgs, readLocalConfig, withWritableContext, writeLocalConfig } from '../context';
import { estimateHostCapacity, printCapacityEstimate } from '../capacity';
import { configKeyLabel, describeSfuPortProblem, describeTurnPortProblem, describeTurnUnavailability, formatBool, formatDate, parseBoolean, parseMemberLimit, parsePositiveInt, parseVoiceMode, printSfuPreflight, printVoiceModeComparisonTable, sfuPreflightSummary } from '../formatters';
import { t } from '../i18n/index';
import { RegisteredServer, registerServer } from '../registry';
import { ask, askChoice, confirm, promptPassword } from '../prompts';
import { askAutoUpdateSchedule, disableAutoUpdate, enableAutoUpdate, isAutoUpdateEnabled } from '../autoUpdate';
import { findOnlinePm2Process } from '../runningServer';
import { resolveTargetServer } from '../target';
import { restartServerCommand } from './serverLifecycle';
import { CoturnManager } from '../../infrastructure/turn/CoturnManager';
import { checkSfuPreflight } from '../../infrastructure/sfu/SfuPreflight';

/** Settings kept outside `server.db`, so changing them never conflicts with a running server. */
type DatabaseConfigKey = Exclude<ConfigKey, 'port' | 'autoUpdate'>;

function isDatabaseConfigKey(key: ConfigKey): key is DatabaseConfigKey {
  return key !== 'port' && key !== 'autoUpdate';
}

function parseConfigKey(value: string): ConfigKey {
  const key = CONFIG_KEYS.find((candidate) => candidate === value);
  if (!key) throw new Error(t('config.unsupportedKey', { key: value }));
  return key;
}

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
  console.log(`${configKeyLabel('messageDeleteUndoSeconds')}: ${server.messageDeleteUndoSeconds ?? LIMITS.MESSAGE_DELETE_UNDO_SECONDS}`);
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
  console.log(`${configKeyLabel('autoUpdate')}: ${formatBool(isAutoUpdateEnabled())}`);
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
 * `monky config set`. Settings stored in `server.db` need the server stopped
 * (see `withWritableContext`); the port and the auto-updater live outside the
 * database and can change while it runs.
 */
export async function setConfigCommand(globalArgs: GlobalArgs, rawKey: string, value?: string): Promise<void> {
  const requestedKey = rawKey.trim() ? parseConfigKey(rawKey.trim()) : null;
  // The updater is shared by every server on this machine, so it targets none.
  if (requestedKey === 'autoUpdate') {
    await setAutoUpdateCommand(value);
    return;
  }
  const target = await resolveTargetServer(globalArgs, t('action.manage'));
  const key = requestedKey ?? (await askConfigKey());
  if (key === 'autoUpdate') {
    await setAutoUpdateCommand(value);
    return;
  }
  if (key === 'port') {
    await setPortCommand(target, value);
    return;
  }
  await withWritableContext(target.dataDir, (ctx) => setConfig(ctx, key, value));
}

/**
 * Applies a new port through the regular restart, which warns people in
 * voice, repairs a stale PM2 registration and runs `pm2 save`. Restarting
 * PM2 directly skipped all of that: a reboot brought the old port back, and a
 * failed restart was still reported as done.
 */
async function setPortCommand(target: RegisteredServer, value?: string): Promise<void> {
  const config = readLocalConfig(target.dataDir);
  const runningPort = target.port ?? config.port ?? LIMITS.DEFAULT_PORT;
  const port = parsePositiveInt('port', value ?? (await ask(t('config.askPort'), String(config.port || LIMITS.DEFAULT_PORT))));
  writeLocalConfig(target.dataDir, { ...config, port });
  console.log(color(t('config.updated', { key: 'port' }), ANSI.green));

  if (!findOnlinePm2Process(target.dataDir)) {
    registerServer(target.dataDir, { port });
    console.log(color(t('config.portNextStart'), ANSI.dim));
    return;
  }
  // The registry keeps the port the server runs on until the restart
  // registers the new one, so the voice warning probes the live server.
  if (target.port === undefined) registerServer(target.dataDir, { port: runningPort });
  if (await confirm(t('config.restartForPort'), true) &&
      await restartServerCommand({ args: [], dataDir: target.dataDir, dataDirSpecified: true })) {
    return;
  }
  console.log(color(t('config.portNextStartOrRestart'), ANSI.dim));
}

async function setAutoUpdateCommand(value?: string): Promise<void> {
  const enabled = parseBoolean(value ?? (await askChoice(t('config.askBoolean'), ['true', 'false'])));
  if (enabled) {
    await enableAutoUpdate(await askAutoUpdateSchedule());
  } else {
    await disableAutoUpdate();
  }
  console.log(color(t('config.updated', { key: 'autoUpdate' }), ANSI.green));
}

/**
 * Changes one setting stored in `server.db`, through a context the caller
 * opened for writing.
 *
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
  const requestedKey = key.trim();
  const configKey = CONFIG_KEYS.find((candidate) => candidate === requestedKey);
  if (!configKey || !isDatabaseConfigKey(configKey)) throw new Error(t('config.unsupportedKey', { key: requestedKey }));
  const normalizedKey: DatabaseConfigKey = configKey;
  const server = await ctx.serverRepo.getServer();
  if (!server) {
    throw new Error(t('create.serverNotFound'));
  }

  const currentValues: Record<DatabaseConfigKey, string> = {
    name: server.name,
    password: '',
    icon: server.iconPath ?? '',
    maxUsers: String(server.maxUsers),
    maxMessageLength: String(server.maxMessageLength ?? LIMITS.MAX_MESSAGE_LENGTH),
    messageDeleteUndoSeconds: String(server.messageDeleteUndoSeconds ?? LIMITS.MESSAGE_DELETE_UNDO_SECONDS),
    allowSoundboard: String(server.allowSoundboard !== false),
    allowEveryoneMention: String(server.allowEveryoneMention !== false),
    showRoleBadgesToEveryone: String(server.showRoleBadgesToEveryone !== false),
    voiceMode: server.voiceMode || 'p2p',
    maxAttachmentFileBytes: String(server.maxAttachmentFileBytes ?? ''),
    maxAttachmentStorageBytes: String(server.maxAttachmentStorageBytes ?? ''),
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
      case 'icon':
        nextValue = await ask(t('config.askIcon'));
        break;
      case 'allowSoundboard':
      case 'allowEveryoneMention':
      case 'showRoleBadgesToEveryone':
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
      case 'messageDeleteUndoSeconds':
      case 'maxAttachmentStorageBytes':
        nextValue = await ask(t('config.askValue', { key: configKeyLabel(normalizedKey) }), currentValues[normalizedKey]);
        break;
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
    case 'messageDeleteUndoSeconds': {
      const seconds = Number(nextValue);
      if (!/^\d+$/.test(nextValue.trim()) || !Number.isSafeInteger(seconds) || seconds < 1 || seconds > LIMITS.MAX_MESSAGE_DELETE_UNDO_SECONDS) {
        throw new Error(t('config.invalidDeleteUndo'));
      }
      await ctx.serverRepo.updateServer({ messageDeleteUndoSeconds: seconds });
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
  }

  console.log(color(t('config.updated', { key: normalizedKey }), ANSI.green));
}
