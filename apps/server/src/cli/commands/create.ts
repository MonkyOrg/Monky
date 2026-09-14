import { v4 as uuidv4 } from 'uuid';
import { LIMITS } from '@monky/shared';
import { UserRecord } from '../../domain/entities';
import {
  ANSI,
  color,
  DEFAULT_BOOTSTRAP_PORT,
  DEFAULT_OWNER_NICKNAME,
} from '../constants';
import { ask, askChoice, confirm, promptPassword } from '../prompts';
import {
  CliContext,
  GlobalArgs,
  formatDataDirForPrompt,
  readLocalConfig,
  resolveInputPath,
  withContext,
  writeLocalConfig,
} from '../context';
import { DecryptedIdentity, decryptIdentityExport } from '../identity';
import { t } from '../i18n/index';
import { describeSfuPortProblem, parseOption, parseMemberLimit, parsePositiveInt, parseVoiceMode, printSfuPreflight, printVoiceModeComparisonTable } from '../formatters';
import { estimateHostCapacity, printCapacityEstimate } from '../capacity';
import { hasServerDatabase, registerServer } from '../registry';
import { setConfig } from './config';
import { checkSfuPreflight } from '../../infrastructure/sfu/SfuPreflight';
import { startServerCommand } from './serverLifecycle';

export async function findUserByPublicIdentity(ctx: CliContext, identity: DecryptedIdentity): Promise<UserRecord | null> {
  const byClientId = await ctx.userRepo.findByClientId(identity.clientId);
  if (byClientId) return byClientId;
  return ctx.userRepo.findByPublicKey(identity.publicKey);
}

export async function getUniqueNickname(ctx: CliContext, preferred?: string, excludeUserId?: string): Promise<string> {
  const base = (preferred?.trim() || DEFAULT_OWNER_NICKNAME).slice(0, 32);
  const direct = await ctx.userRepo.findByNickname(base);
  if (!direct || direct.id === excludeUserId) return base;

  for (let i = 1; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    const existing = await ctx.userRepo.findByNickname(candidate);
    if (!existing || existing.id === excludeUserId) return candidate;
  }

  return `owner-${Date.now().toString(36)}`;
}

export async function applyBootstrap(
  ctx: CliContext,
  identityCode: string,
  identityPassword: string,
  nicknameOverride: string
): Promise<void> {
  const identity = decryptIdentityExport(identityCode, identityPassword);
  const server = await ctx.serverRepo.getServer();
  if (!server) {
    throw new Error(t('create.serverNotFound'));
  }

  let user = await findUserByPublicIdentity(ctx, identity);

  if (server.ownerUserId && server.ownerUserId !== user?.id) {
    throw new Error(t('create.alreadyHasOwner'));
  }

  if (!user) {
    const now = Date.now();
    const nickname = await getUniqueNickname(ctx, nicknameOverride);
    user = {
      id: uuidv4(),
      clientId: identity.clientId,
      publicKey: identity.publicKey,
      nickname,
      avatarPath: null,
      createdAt: now,
      lastSeenAt: now,
    };
    await ctx.userRepo.create(user);
  } else {
    await ctx.userRepo.update(user.id, {
      publicKey: identity.publicKey,
      lastSeenAt: Date.now(),
      nickname: nicknameOverride.trim() ? await getUniqueNickname(ctx, nicknameOverride, user.id) : user.nickname,
    });
    user = await ctx.userRepo.findById(user.id);
    if (!user) {
      throw new Error(t('create.bootstrapFailed'));
    }
  }

  const defaultRoles = await ctx.roleRepo.getDefaultRoles();
  for (const role of defaultRoles) {
    await ctx.roleRepo.assignRole(user.id, role.id);
  }

  const adminRole = await ctx.roleRepo.findByName('Admin');
  if (!adminRole) {
    throw new Error(t('create.adminRoleNotFound'));
  }

  await ctx.roleRepo.assignRole(user.id, adminRole.id);
  await ctx.serverRepo.updateServer({ ownerUserId: user.id });

  console.log(color(t('create.ownerConfigured'), ANSI.green));
  console.log(`${t('label.nickname')}: ${user.nickname}`);
  console.log(`${t('label.userId')}: ${user.id}`);
  console.log(`${t('label.clientId')}: ${user.clientId}`);
}

/**
 * Asks where the server data should live.
 *
 * The directory is always confirmed instead of silently defaulting to `./data`
 * in whatever directory the command happened to run from — a globally
 * installed CLI has no meaningful working directory.
 */
async function askDataDir(globalArgs: GlobalArgs): Promise<string> {
  if (globalArgs.dataDirSpecified) {
    return globalArgs.dataDir;
  }

  while (true) {
    const answer = await ask(t('create.askDataDir'), formatDataDirForPrompt(globalArgs.dataDir));
    const resolved = resolveInputPath(answer);
    if (!hasServerDatabase(resolved)) {
      return resolved;
    }
    console.log(color(t('create.alreadyExists', { path: resolved }), ANSI.yellow));
    console.log(color(t('create.chooseAnother'), ANSI.dim));
  }
}

/**
 * Asks whether the server should cap how many members can register (#403).
 *
 * The default is no limit: the cap used to be silently applied at 20 to every
 * server, which meant owners only discovered it when someone was refused.
 */
async function askMemberLimit(args: string[]): Promise<number> {
  const fromFlag = parseOption(args, '--max-users');
  if (fromFlag !== undefined) {
    return parseMemberLimit('max-users', fromFlag);
  }

  const wantsLimit = await confirm(t('create.askMemberLimit'), false);
  if (!wantsLimit) {
    return LIMITS.MAX_USERS_UNLIMITED;
  }

  while (true) {
    const answer = await ask(t('create.memberLimit'), String(LIMITS.MAX_USERS_DEFAULT));
    try {
      const parsed = parseMemberLimit('max-users', answer);
      if (parsed > LIMITS.MAX_USERS_UNLIMITED) return parsed;
      console.log(color(t('create.invalidLimit'), ANSI.yellow));
    } catch (error) {
      console.log(color(error instanceof Error ? error.message : String(error), ANSI.yellow));
    }
  }
}

export async function createCommand(globalArgs: GlobalArgs, args: string[]): Promise<void> {
  const dataDir = await askDataDir(globalArgs);

  if (hasServerDatabase(dataDir)) {
    throw new Error(
      `${t('create.alreadyExists', { path: dataDir })}\n${t('create.adjustExisting')}`
    );
  }

  const identityCode = parseOption(args, '--identity') || (await ask(t('create.identityCode')));
  const identityPassword = await promptPassword(t('create.identityPassword'));
  const serverName = parseOption(args, '--name') || (await ask(t('create.serverName'), t('create.defaultServerName')));
  const portValue = parseOption(args, '--port') || (await ask(t('create.serverPort'), String(DEFAULT_BOOTSTRAP_PORT)));
  const serverPassword = parseOption(args, '--password') ?? (await promptPassword(t('create.serverPassword')));
  const port = parsePositiveInt('port', portValue);
  const maxUsers = await askMemberLimit(args);

  const rawVoiceMode = parseOption(args, '--voice-mode');
  let voiceMode: 'p2p' | 'sfu';
  if (rawVoiceMode !== undefined) {
    voiceMode = parseVoiceMode(rawVoiceMode);
  } else {
    printVoiceModeComparisonTable();
    voiceMode = parseVoiceMode(await askChoice(t('create.voiceModeChoice'), ['p2p', 'sfu']));
  }

  if (voiceMode === 'sfu') {
    const { SfuManager } = await import('../../infrastructure/sfu/SfuManager');
    const portProblem = await new SfuManager().checkPortAvailability();
    if (portProblem) {
      // A warning rather than a hard stop: the server does not exist yet, so
      // the operator can still open the range before starting it (#515).
      console.log();
      console.log(color('⚠ ' + describeSfuPortProblem(portProblem), ANSI.yellow));
    } else {
      console.log(color(t('config.sfuPortOk'), ANSI.green));
    }

    const report = await estimateHostCapacity();
    printCapacityEstimate(report);
    printSfuPreflight(checkSfuPreflight());
  }

  console.log();
  console.log(color(t('create.summary'), ANSI.bold));
  console.log(`${t('label.dataDir')}: ${dataDir}`);
  console.log(`${t('label.name')}: ${serverName}`);
  console.log(`${t('label.port')}: ${port}`);
  console.log(`${t('label.voiceMode')}: ${voiceMode}`);
  console.log(`${t('label.password')}: ${serverPassword ? t('create.passwordSet') : t('create.noPassword')}`);
  console.log(`${t('create.memberLimit')}: ${maxUsers > LIMITS.MAX_USERS_UNLIMITED ? maxUsers : t('create.noLimit')}`);
  console.log(`${t('label.identity')}: ${identityCode.slice(0, Math.min(identityCode.length, 40))}${identityCode.length > 40 ? '...' : ''}`);

  const accepted = await confirm(t('create.confirm'), true);
  if (!accepted) {
    console.log(color(t('create.cancelled'), ANSI.yellow));
    return;
  }

  await withContext(dataDir, async (ctx) => {
    await applyBootstrap(ctx, identityCode, identityPassword, DEFAULT_OWNER_NICKNAME);
    await setConfig(ctx, 'name', serverName);
    await setConfig(ctx, 'password', serverPassword);
    await setConfig(ctx, 'maxUsers', String(maxUsers));
    await setConfig(ctx, 'voiceMode', voiceMode, { skipSfuDiagnostics: true });
  });

  const config = readLocalConfig(dataDir);
  config.port = port;
  writeLocalConfig(dataDir, config);

  // Registering here is what lets start/stop/restart/update find this server
  // later from any directory.
  registerServer(dataDir, { name: serverName, port });

  if (await confirm(t('create.startNow'), true)) {
    await startServerCommand({ ...globalArgs, dataDir, dataDirSpecified: true }, ['--port', String(port)]);
  }
}
