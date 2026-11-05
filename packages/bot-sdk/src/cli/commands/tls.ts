import { AUTO_TLS_LOW_PORT_COMMAND, AUTO_TLS_VALIDATION_PORT, type AutoTlsErrorCode, type AutoTlsStatus } from '@monky/shared';
import { createBotTls, AutoTlsFailure } from '../../tls';
import { ANSI, color } from '../constants';
import type { CliContext } from '../config';
import { CliError, cliText } from '../locale';
import { askCliConfirm } from '../prompts';

function describeError(locale: CliContext['locale'], code: AutoTlsErrorCode): string {
  const port = AUTO_TLS_VALIDATION_PORT;
  const text = (pt: string, en: string): string => cliText(locale, pt, en);
  switch (code) {
    case 'no-public-ip': return text('Não foi possível descobrir o IP público desta máquina. Confira a conexão com a internet.', 'Could not find this machine\'s public IP. Check the internet connection.');
    case 'address-not-public': return text('O IP desta máquina não é público (rede local ou CGNAT); a Let\'s Encrypt só emite para IPs públicos.', 'This machine\'s IP is not public (local network or CGNAT); Let\'s Encrypt only issues for public IPs.');
    case 'port-in-use': return text(`A porta ${port} está em uso por outro programa. Libere-a e tente de novo.`, `Port ${port} is in use by another program. Free it and try again.`);
    case 'port-permission': return text(`Sem permissão para abrir a porta ${port}. No Linux: ${AUTO_TLS_LOW_PORT_COMMAND}`, `No permission to open port ${port}. On Linux: ${AUTO_TLS_LOW_PORT_COMMAND}`);
    case 'privilege-unavailable': return text(`Não há root nem sudo sem senha para liberar a porta ${port}. Rode: ${AUTO_TLS_LOW_PORT_COMMAND}`, `No root or passwordless sudo to allow port ${port}. Run: ${AUTO_TLS_LOW_PORT_COMMAND}`);
    case 'unreachable': return text(`A Let's Encrypt não alcançou a porta ${port} deste IP. Libere-a no firewall e no roteador.`, `Let's Encrypt could not reach port ${port} on this IP. Allow it in the firewall and router.`);
    case 'rate-limited': return text('A Let\'s Encrypt limitou novos pedidos. Tente de novo mais tarde.', 'Let\'s Encrypt rate-limited new requests. Try again later.');
    case 'rejected': return text('A Let\'s Encrypt recusou o pedido de certificado.', 'Let\'s Encrypt rejected the certificate request.');
    case 'network': return text('Não foi possível falar com a Let\'s Encrypt ou outro processo está emitindo o certificado. Tente de novo.', 'Could not reach Let\'s Encrypt, or another process is issuing the certificate. Try again.');
    case 'storage': return text('Não foi possível gravar o certificado na pasta compartilhada (~/.monky/tls ou MONKY_TLS_DIR).', 'Could not save the certificate in the shared folder (~/.monky/tls or MONKY_TLS_DIR).');
  }
}

function formatDate(context: CliContext, time: number | null): string {
  return time === null ? '-' : new Date(time).toLocaleString(context.locale);
}

function printStatus(context: CliContext, status: AutoTlsStatus): void {
  const text = (pt: string, en: string): string => cliText(context.locale, pt, en);
  console.log(`${text('TLS automático', 'Automatic TLS')}: ${status.enabled ? color(text('ligado', 'on'), ANSI.green) : color(text('desligado', 'off'), ANSI.yellow)}`);
  if (status.enabled) {
    console.log(`${text('Endereço', 'Address')}: ${status.ip ? `https://${status.ip} / wss://${status.ip}` : '-'}`);
    console.log(`${text('Válido até', 'Valid until')}: ${formatDate(context, status.validUntil)}`);
    console.log(`${text('Próxima renovação', 'Next renewal')}: ${formatDate(context, status.nextRenewalAt)}`);
  }
  if (status.lastError) {
    console.log(color(`${text('Último erro', 'Last error')} (${formatDate(context, status.lastError.at)}): ${describeError(context.locale, status.lastError.code)}`, ANSI.yellow));
  }
}

function interactive(): boolean {
  return !!process.stdin.isTTY && !!process.stdout.isTTY;
}

async function enable(context: CliContext): Promise<void> {
  const text = (pt: string, en: string): string => cliText(context.locale, pt, en);
  const botTls = createBotTls({ dataDir: context.homeDir });
  try {
    console.log(color(text(
      `Procurando um certificado compartilhado nesta máquina; se não houver, a Let's Encrypt valida a porta ${AUTO_TLS_VALIDATION_PORT} (alguns segundos)...`,
      `Looking for a certificate shared on this machine; if there is none, Let's Encrypt validates port ${AUTO_TLS_VALIDATION_PORT} (a few seconds)...`), ANSI.dim));
    let status: AutoTlsStatus;
    try {
      status = await botTls.enable();
    } catch (error) {
      if (!(error instanceof AutoTlsFailure) || error.code !== 'port-permission' || !interactive()) throw error;
      if (!await askCliConfirm(context.locale, text(
        `Linux só deixa abrir a porta ${AUTO_TLS_VALIDATION_PORT} com permissão (${AUTO_TLS_LOW_PORT_COMMAND}). Liberar agora com sudo?`,
        `Linux only allows opening port ${AUTO_TLS_VALIDATION_PORT} with permission (${AUTO_TLS_LOW_PORT_COMMAND}). Allow it now with sudo?`), true)) throw error;
      status = await botTls.enable({ grantPortPermission: true });
    }
    console.log(color(botTls.reusedSharedCertificate
      ? text('TLS ativado com o certificado já compartilhado nesta máquina.', 'TLS enabled with the certificate already shared on this machine.')
      : text('TLS ativado; o certificado novo ficou compartilhado com os outros bots e o servidor desta máquina.',
        'TLS enabled; the new certificate is now shared with the other bots and the server on this machine.'), ANSI.green));
    printStatus(context, status);
    console.log(color(text(
      'Um bot em execução que usa createBotTls() passa a servir o certificado em cerca de 1 minuto.',
      'A running bot that uses createBotTls() starts serving the certificate within about 1 minute.'), ANSI.dim));
  } catch (error) {
    if (error instanceof AutoTlsFailure) {
      throw new CliError(`Não foi possível ativar o TLS. ${describeError('pt-BR', error.code)}`,
        `Could not enable TLS. ${describeError('en', error.code)}`);
    }
    throw error;
  } finally {
    botTls.dispose();
  }
}

/** `<cli> tls [status|enable|disable]`: automatic TLS for the bot, with the certificate shared by the machine. */
export async function tlsCommand(context: CliContext, args: string[]): Promise<void> {
  const [action = 'status', ...extra] = args;
  if (extra.length || !['status', 'enable', 'disable'].includes(action)) {
    throw new CliError(`Uso: ${context.cliName} tls [status|enable|disable]`, `Usage: ${context.cliName} tls [status|enable|disable]`);
  }
  if (action === 'enable') return enable(context);
  const botTls = createBotTls({ dataDir: context.homeDir });
  try {
    if (action === 'disable') {
      await botTls.disable();
      console.log(color(cliText(context.locale,
        'TLS desativado para este bot. O certificado compartilhado continua para os outros.',
        'TLS disabled for this bot. The shared certificate stays for the others.'), ANSI.green));
      return;
    }
    printStatus(context, botTls.status());
  } finally {
    botTls.dispose();
  }
}
