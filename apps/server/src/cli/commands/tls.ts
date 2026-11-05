import { AUTO_TLS_LOW_PORT_COMMAND, AUTO_TLS_VALIDATION_PORT, type AutoTlsErrorCode, type AutoTlsStatus } from '@monky/shared';
import { getPublicIp } from '../../infrastructure/discovery/ServerIpScanner';
import { AcmeChallenges } from '../../infrastructure/tls/AcmeChallenges';
import { AutoTlsFailure, AutoTlsService } from '../../infrastructure/tls/AutoTlsService';
import { CertificateStore } from '../../infrastructure/tls/CertificateStore';
import { LetsEncryptIssuer, acmeTestOverrides, allowValidationPort } from '../../infrastructure/tls/LetsEncryptIssuer';
import { ANSI, color } from '../constants';
import type { GlobalArgs } from '../context';
import { formatDate } from '../formatters';
import { t, type CliTranslationKey } from '../i18n/index';
import { confirm } from '../prompts';
import { findOnlinePm2Process } from '../runningServer';
import { resolveTargetServer } from '../target';
import { restartServerCommand } from './serverLifecycle';

const ERROR_KEYS: Record<AutoTlsErrorCode, CliTranslationKey> = {
  'no-public-ip': 'tls.error.noPublicIp',
  'address-not-public': 'tls.error.addressNotPublic',
  'port-in-use': 'tls.error.portInUse',
  'port-permission': 'tls.error.portPermission',
  'privilege-unavailable': 'tls.error.privilegeUnavailable',
  unreachable: 'tls.error.unreachable',
  'rate-limited': 'tls.error.rateLimited',
  rejected: 'tls.error.rejected',
  network: 'tls.error.network',
  storage: 'tls.error.storage',
};

export function describeAutoTlsError(code: AutoTlsErrorCode): string {
  return t(ERROR_KEYS[code], { port: AUTO_TLS_VALIDATION_PORT, command: AUTO_TLS_LOW_PORT_COMMAND });
}

/** The service as the CLI runs it: issuing here, serving later in the server process. */
function cliService(dataDir: string): AutoTlsService {
  const store = new CertificateStore(dataDir);
  const overrides = acmeTestOverrides();
  return new AutoTlsService({
    store,
    // The server may be running on its own port; the CLI always answers on the validation port itself.
    issuer: new LetsEncryptIssuer({
      store, challenges: new AcmeChallenges(), serverPort: -1,
      directoryOverride: overrides.directoryOverride, validationPort: overrides.validationPort,
    }),
    publicIp: async () => overrides.publicIp || getPublicIp(),
    install: () => {},
    allowNonPublicAddress: !!overrides.directoryOverride,
    grantPortPermission: allowValidationPort,
  });
}

function printStatus(status: AutoTlsStatus): void {
  console.log(`${t('tls.enabled')}: ${status.enabled ? color(t('tls.on'), ANSI.green) : color(t('tls.off'), ANSI.yellow)}`);
  if (status.enabled) {
    console.log(`${t('tls.address')}: ${status.ip ? `wss://${status.ip}` : '-'}`);
    console.log(`${t('tls.validUntil')}: ${formatDate(status.validUntil)}`);
    console.log(`${t('tls.nextRenewal')}: ${formatDate(status.nextRenewalAt)}`);
  }
  if (status.lastError) {
    console.log(color(`${t('tls.lastError')} (${formatDate(status.lastError.at)}): ${describeAutoTlsError(status.lastError.code)}`, ANSI.yellow));
  }
}

/** A setting the server reads when it starts, like the port: a running server is offered the regular restart. */
async function offerRestart(dataDir: string): Promise<void> {
  if (!findOnlinePm2Process(dataDir)) {
    console.log(color(t('tls.nextStart'), ANSI.dim));
    return;
  }
  if (await confirm(t('tls.restartNow'), true) &&
      await restartServerCommand({ args: [], dataDir, dataDirSpecified: true })) {
    return;
  }
  console.log(color(t('tls.nextStartOrRestart'), ANSI.dim));
}

async function enable(dataDir: string): Promise<void> {
  const service = cliService(dataDir);
  try {
    console.log(color(t('tls.checking', { port: AUTO_TLS_VALIDATION_PORT }), ANSI.dim));
    let status: AutoTlsStatus;
    try {
      status = await service.enable();
    } catch (error) {
      if (!(error instanceof AutoTlsFailure) || error.code !== 'port-permission') throw error;
      if (!(await confirm(t('tls.askGrant', { port: AUTO_TLS_VALIDATION_PORT, command: AUTO_TLS_LOW_PORT_COMMAND }), true))) throw error;
      status = await service.enable({ grantPortPermission: true });
    }
    console.log(color(t('tls.enabledNow', { address: `wss://${status.ip}` }), ANSI.green));
    printStatus(status);
  } catch (error) {
    if (error instanceof AutoTlsFailure) throw new Error(`${t('tls.notEnabled')} ${describeAutoTlsError(error.code)}`);
    throw error;
  } finally {
    service.dispose();
  }
  await offerRestart(dataDir);
}

async function disable(dataDir: string): Promise<void> {
  const service = cliService(dataDir);
  try {
    await service.disable();
  } finally {
    service.dispose();
  }
  console.log(color(t('tls.disabledNow'), ANSI.green));
  await offerRestart(dataDir);
}

/** One line for `monky status` when automatic TLS is on but failing: the owner hears about it there too. */
export function printAutoTlsProblem(dataDir: string): void {
  const service = cliService(dataDir);
  service.restore();
  const status = service.status();
  service.dispose();
  if (!status.enabled || !status.lastError) return;
  console.log(color(`${t('tls.enabled')}: ${describeAutoTlsError(status.lastError.code)} ${t('tls.stillPlain')}`, ANSI.yellow));
}

/** `monky tls [status|enable|disable]`: automatic TLS for servers reached by public IP (#860). */
export async function tlsCommand(globalArgs: GlobalArgs, action = 'status'): Promise<void> {
  const target = await resolveTargetServer(globalArgs, t('action.manage'));
  if (action === 'enable') await enable(target.dataDir);
  else if (action === 'disable') await disable(target.dataDir);
  else {
    const service = cliService(target.dataDir);
    service.restore();
    const status = service.status();
    service.dispose();
    printStatus(status);
  }
}
