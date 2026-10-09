import fs from 'node:fs';
import type http from 'node:http';
import { createProtocolOffer, PROTOCOL_VERSION, type BotDiagnosticResult } from '@monky/shared';
import { RegistrationStore } from '../../RegistrationStore';
import {
  closeServer, createReachabilityIdentity, probeReachability, startReachabilityResponder,
  type BotReachabilityIdentity,
} from '../../reachability';
import { localizedText } from '../../tooling/requirements';
import { readConfig, resolveInstalledEntry, type BotConfig, type CliContext } from '../config';
import { ANSI, color } from '../constants';
import { describeHostConsent, HOST_CONSENT_ENV } from '../consent';
import { keyPaths, loadBotKeys, loadOrCreateBotKeys, type KeyPair } from '../keys';
import { CliError, cliErrorMessage, cliText } from '../locale';
import { ManifestReadinessError, verifyManifest } from '../manifestReadiness';
import { findDefaultPm2Process, listProcesses, type Pm2Process } from '../pm2';
import { checkPortBind, localConnectHost } from '../ports';
import { readProfileEnvironment, resolveDeclaredVariables, validateDeclaredValue } from '../profileEnvironment';
import { describePort, effectivePorts, type EffectivePort } from '../requirementsView';
import { requestServerDiagnostic, type ServerDiagnosticOutcome } from '../serverDiagnostic';

type Level = 'ok' | 'warn' | 'fail' | 'skip' | 'info';

interface Finding {
  level: Level;
  message: string;
}

class DoctorReport {
  readonly findings: Finding[] = [];
  constructor(private readonly context: CliContext) {}

  section(pt: string, en: string): void {
    console.log();
    console.log(color(cliText(this.context.locale, pt, en), ANSI.bold));
  }

  add(level: Level, pt: string, en: string): void {
    const message = cliText(this.context.locale, pt, en);
    this.findings.push({ level, message });
    const labels: Record<Level, [string, string, string]> = {
      ok: ['OK', 'OK', ANSI.green], warn: ['AVISO', 'WARN', ANSI.yellow], fail: ['FALHA', 'FAIL', ANSI.red],
      skip: ['PULADO', 'SKIPPED', ANSI.dim], info: ['INFO', 'INFO', ANSI.cyan],
    };
    const [labelPt, labelEn, code] = labels[level];
    console.log(`  ${color(`[${cliText(this.context.locale, labelPt, labelEn)}]`, code)} ${message}`);
  }

  count(level: Level): number {
    return this.findings.filter((finding) => finding.level === level).length;
  }
}

interface PortCheck {
  port: EffectivePort;
  /** The port answers locally as this bot, or a temporary responder can be started on it. */
  servable: 'bot' | 'responder' | null;
}

function nodeRequirement(engines: unknown): number | null {
  if (typeof engines !== 'object' || engines === null || !('node' in engines) || typeof engines.node !== 'string') return null;
  const match = /^\s*>=\s*v?(\d+)(?:\.\d+){0,2}\s*$/.exec(engines.node);
  return match ? Number(match[1]) : null;
}

function checkPackage(context: CliContext, report: DoctorReport): void {
  report.section('Pacote e perfil', 'Package and profile');
  const required = nodeRequirement(context.project.manifest.engines);
  const major = Number(process.versions.node.split('.')[0]);
  if (required !== null && major < required) {
    report.add('fail', `Node.js ${process.versions.node}; o bot exige ${required} ou superior.`,
      `Node.js ${process.versions.node}; the bot requires ${required} or later.`);
  } else {
    report.add('ok', `Node.js ${process.versions.node}.`, `Node.js ${process.versions.node}.`);
  }
  try {
    resolveInstalledEntry(context);
    report.add('ok', `${context.displayName} ${context.version}: entrada ${context.project.definition.entry} encontrada.`,
      `${context.displayName} ${context.version}: entry ${context.project.definition.entry} found.`);
  } catch {
    if (context.project.definition.buildScript) {
      report.add('warn', `A entrada ${context.project.definition.entry} ainda não foi compilada; o start executará "npm run ${context.project.definition.buildScript}".`,
        `The entry ${context.project.definition.entry} is not built yet; start will run "npm run ${context.project.definition.buildScript}".`);
    } else {
      report.add('fail', `A entrada ${context.project.definition.entry} não existe no pacote instalado. Reinstale o bot.`,
        `The entry ${context.project.definition.entry} is missing from the installed package. Reinstall the bot.`);
    }
  }
}

function checkProfile(context: CliContext, report: DoctorReport, config: BotConfig): KeyPair | null {
  if (!context.project.definition.modes.includes(config.mode)) {
    report.add('fail', `O perfil usa o modo ${config.mode}, que esta versão não suporta. Execute "${context.cliName} setup".`,
      `The profile uses the ${config.mode} mode, which this version does not support. Run "${context.cliName} setup".`);
  } else {
    report.add('ok', `Perfil ${context.configFile} (modo ${config.mode}).`, `Profile ${context.configFile} (${config.mode} mode).`);
  }
  let keys: KeyPair | null = null;
  const paths = keyPaths(config.botDir);
  if (!fs.existsSync(paths.publicKeyFile) && !fs.existsSync(paths.privateKeyFile) && !fs.existsSync(paths.registrationsFile)) {
    report.add('info', `A identidade do bot será criada em ${paths.directory} no primeiro start.`,
      `The bot identity will be created in ${paths.directory} on the first start.`);
  } else {
    try {
      keys = loadBotKeys(config.botDir);
      report.add('ok', `Identidade Ed25519 em ${paths.directory}.`, `Ed25519 identity in ${paths.directory}.`);
    } catch (error: unknown) {
      report.add('fail', `Identidade inválida: ${cliErrorMessage(error, 'pt-BR')}`, `Invalid identity: ${cliErrorMessage(error, 'en')}`);
    }
  }
  try {
    const consent = describeHostConsent(context, config);
    const level: Level = !consent.status.ok ? 'fail'
      : consent.status.state === 'legacy' || consent.status.state === 'inherited' ? 'warn' : 'ok';
    report.add(level, `Consentimento de quem hospeda: ${consent.label}.${consent.status.ok ? '' : ` Execute "${context.cliName} consent".`}`,
      `Host operator consent: ${consent.label}.${consent.status.ok ? '' : ` Run "${context.cliName} consent".`}`);
  } catch (error: unknown) {
    report.add('fail', cliErrorMessage(error, 'pt-BR'), cliErrorMessage(error, 'en'));
  }
  return keys;
}

function checkProcess(context: CliContext, report: DoctorReport): Pm2Process | null {
  report.section('Processo', 'Process');
  let processes: Pm2Process[] | null;
  try {
    processes = listProcesses(context);
  } catch (error: unknown) {
    report.add('fail', `O PM2 deste perfil falhou: ${cliErrorMessage(error, 'pt-BR')}`, `This profile's PM2 failed: ${cliErrorMessage(error, 'en')}`);
    return null;
  }
  if (findDefaultPm2Process(context)) {
    report.add('warn',
      `Há um processo "${context.processName}" no PM2 padrão desta conta (fora deste perfil). Ele pode ocupar as portas; remova-o com "pm2 delete ${context.processName}" e "pm2 save".`,
      `There is a "${context.processName}" process in this account's default PM2 (outside this profile). It may hold the ports; remove it with "pm2 delete ${context.processName}" and "pm2 save".`);
  }
  if (processes === null) {
    report.add('warn', 'O PM2 não está instalado; o start em background o instala.', 'PM2 is not installed; background start installs it.');
    return null;
  }
  const processInfo = processes.find((entry) => entry.name === context.processName) ?? null;
  const status = processInfo?.pm2_env?.status;
  if (!processInfo) {
    report.add('info', `O bot não está registrado no PM2. Inicie com "${context.cliName} start".`,
      `The bot is not registered in PM2. Start it with "${context.cliName} start".`);
  } else if (status === 'online') {
    const restarts = processInfo.pm2_env?.restart_time ?? 0;
    report.add(restarts > 10 ? 'warn' : 'ok',
      `Processo online (PID ${processInfo.pid ?? '?'}, ${restarts} reinícios).${restarts > 10 ? ` Muitos reinícios: veja "${context.cliName} logs".` : ''}`,
      `Process online (PID ${processInfo.pid ?? '?'}, ${restarts} restarts).${restarts > 10 ? ` Many restarts: see "${context.cliName} logs".` : ''}`);
  } else {
    report.add(status === 'errored' ? 'fail' : 'info',
      `Processo ${status ?? 'desconhecido'}. Veja "${context.cliName} logs" e inicie com "${context.cliName} start".`,
      `Process ${status ?? 'unknown'}. See "${context.cliName} logs" and start it with "${context.cliName} start".`);
  }
  return processInfo;
}

function checkSettings(
  context: CliContext, report: DoctorReport, config: BotConfig, env: Record<string, unknown>, running: boolean,
): void {
  report.section('Configurações', 'Settings');
  const where = running ? ['do processo em execução', 'of the running process'] : ['deste terminal', 'of this terminal'];
  if (config.mode === 'manual') {
    if (config.botToken !== undefined) report.add('ok', 'Token de vínculo salvo no perfil.', 'Link token saved in the profile.');
    else if (typeof env[config.tokenEnv] === 'string' && env[config.tokenEnv] !== '') {
      report.add('ok', `Token de vínculo em ${config.tokenEnv} (ambiente ${where[0]}).`, `Link token in ${config.tokenEnv} (environment ${where[1]}).`);
    } else {
      report.add('fail', `${config.tokenEnv} não está definida no ambiente ${where[0]}; o modo manual precisa do token.`,
        `${config.tokenEnv} is not set in the environment ${where[1]}; manual mode needs the token.`);
    }
  }
  const variables = resolveDeclaredVariables(context.project.definition.requirements, readProfileEnvironment(context.homeDir), env)
    .filter((entry) => entry.variable.modes.includes(config.mode));
  if (!variables.length && config.mode === 'marketplace') {
    report.add('ok', 'Nenhuma configuração extra declarada.', 'No extra settings declared.');
  }
  for (const entry of variables) {
    const name = entry.variable.name;
    if (entry.value === undefined) {
      if (entry.variable.required) {
        report.add('fail', `${name} é obrigatória e não está definida. Use "${context.cliName} config env set ${name}". ${localizedText(entry.variable.description, 'pt-BR')}`,
          `${name} is required and not set. Use "${context.cliName} config env set ${name}". ${localizedText(entry.variable.description, 'en')}`);
      } else {
        report.add('info', `${name} não definida (opcional).`, `${name} not set (optional).`);
      }
      continue;
    }
    try {
      validateDeclaredValue(entry.variable, entry.value);
    } catch (error: unknown) {
      report.add('fail', cliErrorMessage(error, 'pt-BR'), cliErrorMessage(error, 'en'));
      continue;
    }
    if (entry.overridesProfile) {
      report.add('warn', `${name}: o valor do ambiente ${where[0]} difere do salvo no perfil; em uso: ambiente.`,
        `${name}: the environment value ${where[1]} differs from the saved one; in use: environment.`);
    } else {
      const source = entry.source === 'environment' ? ['ambiente', 'environment'] : entry.source === 'profile' ? ['perfil', 'profile'] : ['padrão', 'default'];
      report.add('ok', `${name} definida (${source[0]}).`, `${name} set (${source[1]}).`);
    }
  }
}

async function checkPorts(
  context: CliContext, report: DoctorReport, config: BotConfig, env: Record<string, unknown>, running: boolean,
  keys: KeyPair | null,
): Promise<PortCheck[]> {
  report.section('Portas', 'Ports');
  const ports = effectivePorts(context, config, env);
  if (!ports.length) {
    report.add('ok', 'O bot não declara portas de entrada.', 'The bot declares no inbound ports.');
    return [];
  }
  const checks: PortCheck[] = [];
  for (const port of ports) {
    const label = describePort(context.locale, port);
    if (port.invalid || port.port === null) {
      report.add('fail', `${label}: ${port.invalid?.pt ?? 'porta inválida.'}`, `${label}: ${port.invalid?.en ?? 'invalid port.'}`);
      continue;
    }
    const clash = ports.find((other) => other !== port && other.protocol === port.protocol && other.port === port.port);
    if (clash) {
      report.add('fail', `${label}: é a mesma porta de "${clash.id}" deste bot; cada porta do bot precisa ser diferente.`,
        `${label}: same port as this bot's "${clash.id}"; each of the bot's ports must be different.`);
      continue;
    }
    const bind = await checkPortBind(port.protocol, port.port, port.bindHost);
    let servable: PortCheck['servable'] = null;
    if (bind.state === 'error') {
      report.add('fail', `${label}: não foi possível usar ${port.bindHost}:${port.port} (${bind.code}). Verifique o host e as permissões.`,
        `${label}: could not use ${port.bindHost}:${port.port} (${bind.code}). Check the host and permissions.`);
    } else if (bind.state === 'free') {
      if (running && port.when === 'always') {
        report.add('fail', `${label}: o bot está online, mas ninguém escuta nesta porta. Veja "${context.cliName} logs".`,
          `${label}: the bot is online, but nothing listens on this port. See "${context.cliName} logs".`);
      } else {
        report.add('ok', `${label}: livre${port.when === 'on-demand' ? '; o bot a abre quando o recurso for usado' : ''}.`,
          `${label}: free${port.when === 'on-demand' ? '; the bot opens it when the feature is used' : ''}.`);
      }
      servable = port.protocol === 'tcp' ? 'responder' : null;
    } else if (port.protocol === 'udp') {
      report.add(running ? 'info' : 'fail',
        `${label}: em uso${running ? ' (o dono de uma porta UDP não pode ser confirmado)' : ' por outro processo'}.`,
        `${label}: in use${running ? ' (the owner of a UDP port cannot be confirmed)' : ' by another process'}.`);
    } else if (!keys) {
      report.add('fail', `${label}: em uso por outro processo (este bot ainda não tem identidade).`,
        `${label}: in use by another process (this bot has no identity yet).`);
    } else {
      const outcome = await probeReachability(`http://127.0.0.1:${port.port}`, keys.publicKeyHex,
        { connectHost: localConnectHost(port.bindHost) });
      if (outcome === 'verified') {
        servable = 'bot';
        report.add('ok', `${label}: em uso por este bot (identidade confirmada).`, `${label}: in use by this bot (identity confirmed).`);
        if (port.id === 'manifest' && config.mode === 'marketplace') {
          try {
            const readiness = await verifyManifest(config, keys.publicKeyHex, port.bindHost, context.locale);
            report.add(readiness.nameMatches ? 'ok' : 'warn',
              `Manifest válido${readiness.nameMatches ? '' : ', mas o nome difere do configurado (a entrada deve usar MONKY_BOT_NAME)'}.`,
              `Valid manifest${readiness.nameMatches ? '' : ', but its name differs from the configured one (the entry should use MONKY_BOT_NAME)'}.`);
          } catch (error: unknown) {
            if (!(error instanceof ManifestReadinessError)) throw error;
            report.add('fail', error.message, error.message);
          }
        }
      } else if (running) {
        report.add('fail',
          `${label}: em uso, mas não respondeu como este bot. Pode ser outro processo, ou um listener do bot que não encaminha o desafio com handleReachabilityProbe.`,
          `${label}: in use, but it did not answer as this bot. It may be another process, or a bot listener that does not forward the challenge with handleReachabilityProbe.`);
      } else {
        report.add('fail', `${label}: em uso por outro processo. Pare-o ou escolha outra porta.`,
          `${label}: in use by another process. Stop it or choose another port.`);
      }
    }
    if (port.exposure === 'public' && !port.publicOrigin) {
      report.add('warn',
        `${port.id}: sem endereço público configurado${port.declared?.publicUrlEnv ? `; defina ${port.declared.publicUrlEnv}` : ''}. Quem usa o recurso de outra máquina não conseguirá acessá-lo.`,
        `${port.id}: no public address configured${port.declared?.publicUrlEnv ? `; set ${port.declared.publicUrlEnv}` : ''}. Users on other machines will not reach it.`);
    }
    checks.push({ port, servable });
  }
  return checks;
}

async function serverTarget(
  context: CliContext, config: BotConfig, env: Record<string, unknown>, keys: KeyPair,
): Promise<{ targets: { url: string; token: string; name: string }[]; reason?: [string, string] }> {
  if (config.mode === 'manual') {
    const token = config.botToken ?? (typeof env[config.tokenEnv] === 'string' ? String(env[config.tokenEnv]) : '');
    if (!token) return { targets: [], reason: ['sem token de vínculo disponível', 'no link token available'] };
    return { targets: [{ url: config.serverUrl, token, name: config.serverUrl }] };
  }
  const file = keyPaths(config.botDir).registrationsFile;
  if (!fs.existsSync(file)) {
    return { targets: [], reason: ['nenhum servidor vinculado ainda; instale o bot por URL em um servidor e rode doctor de novo',
      'no server linked yet; install the bot by URL on a server and run doctor again'] };
  }
  try {
    const registrations = await new RegistrationStore(file, keys.publicKeyHex).load();
    if (!registrations.length) {
      return { targets: [], reason: ['nenhum servidor vinculado ainda; instale o bot por URL em um servidor e rode doctor de novo',
        'no server linked yet; install the bot by URL on a server and run doctor again'] };
    }
    return { targets: registrations.slice(0, 3).map((entry) => ({ url: entry.serverUrl, token: entry.token, name: entry.serverName })) };
  } catch (error: unknown) {
    return { targets: [], reason: [`não foi possível ler os vínculos: ${cliErrorMessage(error, 'pt-BR')}`,
      `could not read the links: ${cliErrorMessage(error, 'en')}`] };
  }
}

function reportCredential(context: CliContext, report: DoctorReport, result: BotDiagnosticResult, name: string): void {
  if (!result.protocol) {
    report.add('fail', `${name}: protocolo incompatível (bot ${PROTOCOL_VERSION}, servidor ${result.serverProtocolVersion}). Atualize o lado mais antigo.`,
      `${name}: incompatible protocol (bot ${PROTOCOL_VERSION}, server ${result.serverProtocolVersion}). Update the older side.`);
  } else {
    report.add('ok', `${name}: protocolo compatível (bot ${PROTOCOL_VERSION}, servidor ${result.serverProtocolVersion}).`,
      `${name}: compatible protocol (bot ${PROTOCOL_VERSION}, server ${result.serverProtocolVersion}).`);
  }
  const credential: Record<BotDiagnosticResult['credential'], [Level, string, string]> = {
    valid: ['ok', 'token válido e vinculado a esta identidade.', 'token valid and bound to this identity.'],
    pending_binding: ['info', 'token válido; a identidade será vinculada na primeira conexão do bot.',
      'token valid; the identity is bound on the bot\'s first connection.'],
    invalid: ['fail', 'token inválido ou revogado. Gere um novo vínculo no servidor e refaça o setup.',
      'invalid or revoked token. Create a new link on the server and run setup again.'],
    key_mismatch: ['fail', 'o token está vinculado a outra identidade (TOFU). Restaure a pasta .keys original ou gere um novo vínculo.',
      'the token is bound to another identity (TOFU). Restore the original .keys folder or create a new link.'],
  };
  const [level, pt, en] = credential[result.credential];
  report.add(level, `${name}: ${pt}`, `${name}: ${en}`);
}

async function checkServer(
  context: CliContext, report: DoctorReport, config: BotConfig, env: Record<string, unknown>,
  ports: PortCheck[], keys: KeyPair | null,
): Promise<void> {
  report.section('Servidor Monky e acesso externo', 'Monky server and external access');
  const identity: KeyPair = keys ?? loadOrCreateBotKeys(config.botDir);
  if (!keys) {
    report.add('info', `Identidade criada em ${keyPaths(config.botDir).directory} para o teste (o start a reutiliza).`,
      `Identity created in ${keyPaths(config.botDir).directory} for the test (start reuses it).`);
  }
  const { targets: servers, reason } = await serverTarget(context, config, env, identity);
  const publicPorts = ports.filter((check) => check.port.exposure === 'public' && check.port.protocol === 'tcp' && check.port.publicOrigin);
  if (!servers.length) {
    report.add('skip', `Teste pelo servidor pulado: ${reason?.[0] ?? ''}.`, `Server test skipped: ${reason?.[1] ?? ''}.`);
    return;
  }
  const reachability: BotReachabilityIdentity = createReachabilityIdentity(identity.publicKeyHex, identity.privateKeyPem);
  const responders: http.Server[] = [];
  const targets: { id: string; origin: string }[] = [];
  try {
    for (const check of publicPorts) {
      if (check.servable === 'responder' && check.port.port !== null) {
        try {
          responders.push(await startReachabilityResponder(check.port.port, check.port.bindHost, reachability));
        } catch {
          report.add('warn', `${check.port.id}: a porta foi ocupada durante o teste; tente novamente.`,
            `${check.port.id}: the port was taken during the test; try again.`);
          continue;
        }
      } else if (check.servable !== 'bot') continue;
      targets.push({ id: check.port.id, origin: check.port.publicOrigin ?? '' });
      const local = await probeReachability(check.port.publicOrigin ?? '', identity.publicKeyHex);
      report.add(local === 'verified' ? 'info' : 'warn',
        local === 'verified' ? `${check.port.id}: ${check.port.publicOrigin} responde a partir desta máquina (isso não prova acesso de fora).`
          : `${check.port.id}: ${check.port.publicOrigin} não respondeu a partir desta máquina. Alguns roteadores não permitem acessar o próprio IP público (hairpin NAT); o teste do servidor abaixo é o que vale.`,
        local === 'verified' ? `${check.port.id}: ${check.port.publicOrigin} answers from this machine (this does not prove outside access).`
          : `${check.port.id}: ${check.port.publicOrigin} did not answer from this machine. Some routers cannot reach their own public IP (hairpin NAT); the server test below is what counts.`);
    }
    let outcome: ServerDiagnosticOutcome | null = null;
    let server = servers[0];
    for (const candidate of servers) {
      server = candidate;
      outcome = await requestServerDiagnostic(candidate.url, {
        protocolVersion: PROTOCOL_VERSION, protocolOffer: createProtocolOffer('bot'),
        botToken: candidate.token, publicKey: identity.publicKeyHex, targets,
      });
      if (outcome.kind === 'result') break;
      const failure: Record<Exclude<ServerDiagnosticOutcome['kind'], 'result'>, [string, string]> = {
        unsupported: ['o servidor é anterior ao protocolo 37 e não oferece o diagnóstico; atualize o servidor Monky',
          'the server predates protocol 37 and does not offer diagnostics; update the Monky server'],
        'rate-limited': ['o servidor limitou os testes; aguarde alguns minutos', 'the server rate-limited the tests; wait a few minutes'],
        error: [`não foi possível conectar (${outcome.kind === 'error' ? outcome.code : ''}); confira a URL e se o servidor está no ar`,
          `could not connect (${outcome.kind === 'error' ? outcome.code : ''}); check the URL and whether the server is up`],
      };
      const [pt, en] = failure[outcome.kind];
      report.add(outcome.kind === 'unsupported' ? 'warn' : 'fail', `${candidate.name}: ${pt}.`, `${candidate.name}: ${en}.`);
    }
    if (!outcome || outcome.kind !== 'result') return;
    const result = outcome.result;
    const name = result.serverName ?? server.name;
    reportCredential(context, report, result, name);
    if (!targets.length) {
      report.add('skip', 'Nenhuma porta pública verificável pelo servidor.', 'No public port the server can verify.');
      return;
    }
    for (const target of targets) {
      const entry = result.reachability.find((item) => item.id === target.id);
      if (entry?.status === 'verified') {
        report.add('ok', `${target.id}: ${target.origin} acessível de fora (testado por ${name}).`,
          `${target.id}: ${target.origin} reachable from outside (tested by ${name}).`);
      } else if (entry?.status === 'skipped') {
        const reasons: Record<string, [string, string]> = {
          address_not_allowed: ['o endereço não é público nem o IP de origem deste teste', 'the address is neither public nor this test\'s source IP'],
          port_not_allowed: ['o servidor só testa as portas 80, 443 e 1024–65535', 'the server only tests ports 80, 443 and 1024–65535'],
          rate_limited: ['limite de testes atingido; aguarde', 'test limit reached; wait'],
          busy: ['o servidor está ocupado; tente novamente', 'the server is busy; try again'],
          credential: ['a credencial não foi aceita', 'the credential was not accepted'],
        };
        const [pt, en] = reasons[entry.reason ?? 'busy'] ?? reasons.busy;
        report.add('skip', `${target.id}: teste externo pulado — ${pt}.`, `${target.id}: external test skipped — ${en}.`);
      } else {
        report.add('fail',
          `${target.id}: ${name} não conseguiu acessar ${target.origin}. Libere a porta no firewall, configure o redirecionamento (NAT) do roteador e confira o endereço público.`,
          `${target.id}: ${name} could not reach ${target.origin}. Allow the port through the firewall, set up router port forwarding (NAT) and check the public address.`);
      }
    }
    report.add('info', `O teste externo foi feito a partir da rede de ${name}; outras redes podem ter regras diferentes.`,
      `The external test ran from ${name}'s network; other networks may have different rules.`);
  } finally {
    await Promise.all(responders.map(closeServer));
  }
}

export async function doctorCommand(context: CliContext, args: string[]): Promise<void> {
  const local = args.includes('--local');
  if (args.some((argument) => argument !== '--local')) {
    throw new CliError('Uso: doctor [--local]', 'Usage: doctor [--local]');
  }
  const report = new DoctorReport(context);
  console.log(color(cliText(context.locale, `${context.displayName} — verificação`, `${context.displayName} — check`), ANSI.bold));
  checkPackage(context, report);
  const config = readConfig(context);
  if (!config) {
    report.add('fail', `Nenhuma configuração encontrada. Execute "${context.cliName} setup".`,
      `No configuration found. Run "${context.cliName} setup".`);
  } else {
    const keys = checkProfile(context, report, config);
    const processInfo = checkProcess(context, report);
    const running = processInfo?.pm2_env?.status === 'online';
    const env: Record<string, unknown> = running ? processInfo?.pm2_env?.env ?? {} : process.env;
    if (process.env[HOST_CONSENT_ENV] !== undefined && running) {
      report.add('info', `${HOST_CONSENT_ENV} está definida neste terminal; o processo usa o próprio ambiente.`,
        `${HOST_CONSENT_ENV} is set in this terminal; the process uses its own environment.`);
    }
    checkSettings(context, report, config, env, running);
    const ports = await checkPorts(context, report, config, env, running, keys);
    if (local) {
      report.section('Servidor Monky e acesso externo', 'Monky server and external access');
      report.add('skip', '--local: nenhuma conexão com servidores foi feita.', '--local: no server connection was made.');
    } else {
      await checkServer(context, report, config, env, ports, keys);
    }
  }
  const failures = report.count('fail');
  const warnings = report.count('warn');
  console.log();
  if (!failures) {
    console.log(color(cliText(context.locale,
      `Pronto para operar${warnings ? ` (${warnings} aviso(s))` : ''}.`, `Ready to operate${warnings ? ` (${warnings} warning(s))` : ''}.`), ANSI.green));
    return;
  }
  throw new CliError(`${failures} problema(s) impedem o bot de operar corretamente. Corrija os itens [FALHA] acima e rode doctor novamente.`,
    `${failures} problem(s) keep the bot from operating correctly. Fix the [FAIL] items above and run doctor again.`);
}

