/**
 * Regenerates the app screenshots of the documentation site
 * (docs-site/public/screenshots/<shot>-<pt|en>.png).
 *
 *   npm run build
 *   node scripts/docs-screenshots.js                          every shot, both languages
 *   node scripts/docs-screenshots.js --lang en                one language
 *   node scripts/docs-screenshots.js --only conversa,eventos  some shots
 *
 * Deliberately not an npm script: the root package.json is a release input,
 * and regenerating documentation images must not publish a version.
 *
 * Each language gets its own disposable server, demo bot and client profile
 * under .qa/runs, through the same isolated QA launcher as `npm run qa`; the
 * installed Monky and its profile are never touched. The client renders
 * offscreen, so no window shows up while it runs. Nina and Rafa are real
 * protocol connections and GuiaBot is a real SDK bot, so every message, event
 * and live action reaches the client the way it would from other people.
 *
 * `--hold` stops after preparing the scene (and the shots named in `--only`)
 * and keeps it running, writing the DevTools port of the client to
 * .qa/docs-screenshots.json, to explore the UI while writing a new shot.
 * `--out <dir>` writes the images elsewhere, to compare before replacing.
 *
 * The identity screen is the exception: it only exists before an identity
 * does, so it is taken from a separate throwaway profile whose window shows
 * for a few seconds.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { isolatedEnvironment, repoRoot } from './qa.js';
import { startOwnedProcess } from './qa/process.js';
import { Member } from './docs-screenshots/member.js';
import { Page } from './docs-screenshots/page.js';
import { startGuiaBot } from './docs-screenshots/bot.js';
import { content } from './docs-screenshots/content.js';
import { shots } from './docs-screenshots/shots.js';

const require = createRequire(import.meta.url);
const shared = require(path.join(repoRoot, 'packages', 'shared', 'dist', 'index.js'));
const { MessageType, Permission } = shared;
const outputDir = path.join(repoRoot, 'docs-site', 'public', 'screenshots');
const WIDTH = 1280;
const HEIGHT = 900;
// Event times are computed here and shown by the client; both use this zone.
const TIME_ZONE = 'America/Sao_Paulo';
process.env.TZ = TIME_ZONE;

function parseArguments(args) {
  const options = { languages: ['pt-BR', 'en'], only: null, hold: false, out: outputDir };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--hold') options.hold = true;
    else if (argument === '--lang') options.languages = [args[++index]];
    else if (argument === '--only') options.only = new Set(args[++index].split(','));
    else if (argument === '--out') options.out = path.resolve(args[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  for (const language of options.languages) {
    if (!content[language]) throw new Error(`Unsupported language: ${language}. Use pt-BR or en.`);
  }
  if (options.only) {
    for (const name of options.only) {
      if (name !== 'identidade' && !shots.some(shot => shot.name === name)) throw new Error(`Unknown shot: ${name}`);
    }
  }
  return options;
}

async function freePort() {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function makeRunDirectory() {
  const runId = randomUUID();
  // The client only accepts a QA configuration from `<scenario>-<runId>` inside .qa/runs.
  const root = path.join(repoRoot, '.qa', 'runs', `server-settings-${runId}`);
  for (const role of ['server', 'bot', 'client']) {
    for (const child of [['AppData', 'Roaming'], ['AppData', 'Local'], ['config'], ['cache'], ['data'], ['scratch'], ['cli']]) {
      await fs.mkdir(path.join(root, role, ...child), { recursive: true });
    }
  }
  return { runId, root };
}

/** Disposable loopback server with the demo channels, roles and members. */
async function startServer(root, text, password) {
  const { MonkyServer } = require(path.join(repoRoot, 'apps', 'server', 'dist', 'server.js'));
  const repositories = require(path.join(repoRoot, 'apps', 'server', 'dist', 'infrastructure', 'database', 'SqliteRepositories.js'));
  const port = await freePort();
  const server = await MonkyServer.create({
    port, dataDir: path.join(root, 'server'), password, serverName: text.server,
    voiceMode: 'p2p', categoryLocale: text === content.en ? 'en' : 'pt-BR',
    // The QA client posts a readiness message to the first text channel; this
    // throwaway channel takes it and is deleted before any capture.
    initialTextChannel: 'qa', initialVoiceChannel: text.voice,
  });
  const listen = server.httpServer.listen;
  server.httpServer.listen = function listenOnLoopback(requestedPort, host, ...args) {
    return Reflect.apply(listen, this, [port, '127.0.0.1', ...args]);
  };
  server.lanBroadcaster.start = async () => {};
  await server.start();

  const db = server.dbConn.getDb();
  const logo = await fs.readFile(path.join(repoRoot, 'docs-site', 'public', 'logo.png'));
  await server.wsServer.authService.updateServerSettings({ iconBase64: `data:image/png;base64,${logo.toString('base64')}` });
  const channels = server.wsServer.channelService;
  const categories = await channels.listCategories();
  const [textCategory, voiceCategory] = [...categories].sort((a, b) => a.position - b.position);
  const created = {};
  for (const [key, name, type, categoryId] of [
    ['text', text.text, 'TEXT', textCategory.id],
    ['planning', text.planning, 'TEXT', textCategory.id],
    ['gaming', text.gaming, 'VOICE', voiceCategory.id],
  ]) {
    const result = await channels.createChannel({ name, type, categoryId, botCommandsEnabled: true });
    if (!result.success) throw new Error(`Could not create #${name}: ${result.errorMessage}`);
    created[key] = result.channel;
  }
  const all = await channels.listChannels();
  created.voice = all.find(channel => channel.name === text.voice);
  created.qa = all.find(channel => channel.name === 'qa');

  const roles = new repositories.SqliteRoleRepository(db);
  const facilitators = randomUUID();
  await roles.create({
    id: facilitators, name: text.role, color: '#3ba55d', position: 1, isDefault: false, createdAt: Date.now(),
    permissions: Permission.MANAGE_EVENTS | Permission.EMIT_LIVE_ACTIONS | Permission.MANAGE_CHANNELS,
  });
  return { server, port, db, repositories, channels: created, roles: { facilitators } };
}

/**
 * Registers a demo member ahead of their first connection, so a role given
 * here is already in effect when they join. Ownership still goes to the first
 * person who authenticates: Marina, through the client.
 */
async function registerMember(context, member, roleIds = []) {
  const users = new context.repositories.SqliteUserRepository(context.db);
  const roles = new context.repositories.SqliteRoleRepository(context.db);
  const id = randomUUID();
  const now = Date.now();
  await users.create({
    id, clientId: randomUUID(), publicKey: member.publicKey, nickname: member.nickname,
    avatarPath: null, createdAt: now, lastSeenAt: now,
  });
  for (const role of await roles.getDefaultRoles()) await roles.assignRole(id, role.id);
  for (const roleId of roleIds) await roles.assignRole(id, roleId);
}

async function launchClient(run, context, language, password) {
  const clientDir = path.join(run.root, 'client');
  const config = shared.developmentQaConfigSchema.parse({
    runId: run.runId, scenario: 'server-settings', smoke: true, nickname: 'Marina',
    server: { host: '127.0.0.1', port: context.port, name: content[language].server, password },
  });
  const configFile = path.join(run.root, 'launch.json');
  await fs.writeFile(configFile, JSON.stringify({ ownerPid: process.pid, config }), { flag: 'wx', mode: 0o600 });
  const client = startOwnedProcess(require('electron'), [
    path.join(repoRoot, 'apps', 'client'), `--user-data-dir=${clientDir}`,
    '--remote-debugging-port=0', `--lang=${language}`,
  ], {
    cwd: path.join(repoRoot, 'apps', 'client'),
    env: isolatedEnvironment(clientDir, { MONKY_QA_CONFIG: configFile, TZ: TIME_ZONE }, { useSystemKeychain: true }),
    runId: run.runId, label: 'Screenshot client', timeoutMs: 180_000,
  });
  const ready = await client.ready;
  const devtoolsPort = (await fs.readFile(path.join(clientDir, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
  const page = await Page.attach(devtoolsPort, url => url.endsWith('/index.html'));
  await page.setViewport(WIDTH, HEIGHT);
  return { client, page, ready, devtoolsPort };
}

/**
 * The QA launcher connects without saving the server, so the rail would be
 * empty. Joining again through the + button is what a person does, and it is
 * what puts the server on the rail.
 */
async function saveServerThroughJoinForm(page, port, password) {
  await page.click('#server-rail-add');
  await page.click('#add-server-option-join');
  await page.fill('#add-server-host', '127.0.0.1');
  await page.fill('#add-server-port', String(port));
  await page.fill('#add-server-password', password);
  await page.click('#add-server-submit-join');
  await page.waitUntil('!document.querySelector("#add-server-join-form")', 'the add-server modal to close');
  await page.waitFor('.server-rail-item, [data-server-key]');
}

/** Initials on a soft gradient, drawn by the client page itself. */
async function makeAvatar(page, initials, from, to) {
  return page.eval(`(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    const g = canvas.getContext('2d');
    const gradient = g.createLinearGradient(0, 0, 256, 256);
    gradient.addColorStop(0, ${JSON.stringify(from)});
    gradient.addColorStop(1, ${JSON.stringify(to)});
    g.fillStyle = gradient;
    g.fillRect(0, 0, 256, 256);
    g.fillStyle = '#ffffff';
    g.font = '600 112px Inter, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(${JSON.stringify(initials)}, 128, 136);
    return canvas.toDataURL('image/png');
  })()`);
}

/** Fills `scene` as each part comes up, so a failure halfway still shuts everything down. */
async function prepareScene(run, language, scene) {
  const text = content[language];
  // 16 characters: the QA launcher's minimum, and a realistic length in the join form.
  const password = randomBytes(8).toString('hex');
  Object.assign(scene, { text, password });
  const context = scene.context = await startServer(run.root, text, password);
  const url = `ws://127.0.0.1:${context.port}`;
  const nina = new Member(url, 'Nina', password);
  const rafa = new Member(url, 'Rafa', password);
  scene.members = { nina, rafa };
  await registerMember(context, nina, [context.roles.facilitators]);
  await registerMember(context, rafa);
  scene.bot = await startGuiaBot(path.join(run.root, 'bot'), language);
  const app = scene.app = await launchClient(run, context, language, password);
  const page = scene.page = app.page;

  // Marina is the owner now; the throwaway channel with the QA readiness message goes away.
  await page.escape();
  const ws = context.server.wsServer;
  await ws.channelService.deleteChannel(context.channels.qa.id);
  ws.releaseDeletedChannel(context.channels.qa.id);
  await ws.reconcileChannelVisibility();
  await saveServerThroughJoinForm(page, context.port, password);
  await page.click(`[data-channel-id="${context.channels.text.id}"][data-channel-type="TEXT"]`);

  await nina.connect();
  await rafa.connect();
  for (const [member, initials, from, to] of [[nina, 'N', '#f472b6', '#8b5cf6'], [rafa, 'R', '#38bdf8', '#22c55e']]) {
    const avatar = await makeAvatar(page, initials, from, to);
    await member.request(MessageType.USER_UPDATE_AVATAR, { avatarBase64: avatar, mimeType: 'image/png' }).catch(() => {});
  }
  const people = { Nina: nina, Rafa: rafa };
  const sent = [];
  for (const [nickname, message] of text.messages) sent.push(await people[nickname].say(context.channels.text.id, message));
  const [welcome, , , meetup] = sent.map(result => result?.id ?? result?.message?.id);
  for (const [member, messageId, emoji] of [
    [nina, welcome, text.reactions[0]], [rafa, meetup, text.reactions[1]], [nina, meetup, text.reactions[1]],
  ]) {
    if (messageId) await member.request(MessageType.CHAT_REACTION_ADD, { channelId: context.channels.text.id, messageId, emoji });
  }
  scene.community = await seedCommunity(page, text, context, { nina, rafa }, app.ready.userId);
  await setOwnerAvatar(context, app.ready.userId, await makeAvatar(page, 'M', '#fbbf24', '#f97316'));
}

/**
 * The avatar picker is a native file dialog, out of reach of DevTools. This is
 * the server half of the same update the client sends after that dialog.
 */
async function setOwnerAvatar(context, userId, avatar) {
  const ws = context.server.wsServer;
  const result = await ws.userService.updateAvatar(userId, avatar);
  if (!result.success) throw new Error(`Could not set Marina's avatar: ${result.errorMessage}`);
  ws.applyUserUpdate(result.updatedUser);
  ws.broadcastUserUpdate(result.updatedUser);
}

/** Next Saturday at the given local hour, in the client's time zone. */
function nextSaturday(hour) {
  const date = new Date();
  date.setDate(date.getDate() + ((6 - date.getDay() + 7) % 7 || 7));
  date.setHours(hour, 0, 0, 0);
  return date.getTime();
}

/** A 5:2 event cover: emoji on a gradient, drawn by the client page. */
async function makeCover(page, emoji, from, to) {
  return page.eval(`(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1500;
    canvas.height = 600;
    const g = canvas.getContext('2d');
    const gradient = g.createLinearGradient(0, 0, 1500, 600);
    gradient.addColorStop(0, ${JSON.stringify(from)});
    gradient.addColorStop(1, ${JSON.stringify(to)});
    g.fillStyle = gradient;
    g.fillRect(0, 0, 1500, 600);
    g.globalAlpha = 0.18;
    g.fillStyle = '#ffffff';
    for (let i = 0; i < 9; i++) {
      g.beginPath();
      g.arc(120 + i * 170, 90 + (i % 3) * 210, 46 + (i % 4) * 14, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
    g.font = '260px "Segoe UI Emoji", "Apple Color Emoji", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(${JSON.stringify(emoji)}, 750, 320);
    return canvas.toDataURL('image/png');
  })()`);
}

/** Events and live actions created by Nina (Facilitators) through the protocol. */
async function seedCommunity(page, text, context, { nina, rafa }, ownerId) {
  await context.server.wsServer.communityService.updateSettings(ownerId, { eventsEnabled: true });
  const timeZone = TIME_ZONE;
  const gameNight = await nina.request(MessageType.EVENT_SAVE, {
    title: text.event.title, description: text.event.description,
    location: { kind: 'voice', channelId: context.channels.gaming.id },
    startsAt: nextSaturday(19), endsAt: nextSaturday(22), repeat: 'none', timeZone,
    imageSources: [await makeCover(page, '🎲', '#5865f2', '#22c55e')],
  });
  const workshop = await nina.request(MessageType.EVENT_SAVE, {
    title: text.secondEvent.title, description: text.secondEvent.description,
    location: { kind: 'text', channelId: context.channels.planning.id },
    startsAt: nextSaturday(15) + 7 * 86_400_000, endsAt: nextSaturday(17) + 7 * 86_400_000, repeat: 'none', timeZone,
    imageSources: [await makeCover(page, '🤖', '#0ea5e9', '#8b5cf6')],
  });
  const gameNightId = gameNight?.event?.id ?? gameNight?.id;
  if (gameNightId) await rafa.request(MessageType.EVENT_INTEREST, { id: gameNightId, interested: true });

  const poll = await nina.request(MessageType.POLL_CREATE, {
    channelId: context.channels.text.id, question: text.poll.question,
    options: text.poll.options.map(label => ({ label, emoji: null })),
    durationMinutes: 1440, liveAction: true,
  });
  const pollRecord = poll?.poll ?? poll;
  const option = index => pollRecord?.options?.[index]?.id;
  if (pollRecord?.id && option(0)) {
    await nina.request(MessageType.POLL_VOTE, { id: pollRecord.id, optionIds: [option(0)] });
    await rafa.request(MessageType.POLL_VOTE, { id: pollRecord.id, optionIds: [option(1)] });
  }
  if (gameNightId) await nina.request(MessageType.EVENT_INTEREST, { id: gameNightId, interested: true });
  const form = await nina.request(MessageType.NATIVE_FORM_CREATE, {
    channelId: context.channels.planning.id, durationMinutes: 1440,
    form: {
      title: text.form.title, description: text.form.description, submitLabel: text.form.submit,
      fields: [
        { name: 'name', label: text.form.fields.name, type: 'text', required: true, maxLength: 60 },
        { name: 'level', label: text.form.fields.level, type: 'select', presentation: 'buttons', required: true,
          choices: text.form.fields.levels.map((label, index) => ({ label, value: `level_${index}` })) },
        { name: 'topics', label: text.form.fields.topics, type: 'multi-select',
          choices: text.form.fields.topicList.map((label, index) => ({ label, value: `topic_${index}` })) },
        { name: 'notes', label: text.form.fields.notes, type: 'text', multiline: true, maxLength: 500 },
      ],
    },
  });
  return { gameNight, workshop, poll, form };
}


async function closeScene(scene) {
  scene.page?.close();
  for (const member of Object.values(scene.members ?? {})) member.close();
  await scene.app?.client.stop().catch(error => console.error(error.message));
  await scene.bot?.close().catch(() => {});
  await scene.context?.server.stop?.();
}

/**
 * The identity screen exists only before an identity does, and prepared QA
 * always creates one first. This launches a throwaway profile without QA,
 * captures the first screen and stops that exact process. Its window shows
 * for a few seconds; nothing else is touched.
 */
async function captureIdentity(language, file) {
  const run = await makeRunDirectory();
  const clientDir = path.join(run.root, 'client');
  const client = spawn(require('electron'), [
    path.join(repoRoot, 'apps', 'client'), `--user-data-dir=${clientDir}`,
    '--remote-debugging-port=0', `--lang=${language}`,
  ], { cwd: path.join(repoRoot, 'apps', 'client'), env: isolatedEnvironment(clientDir), stdio: 'ignore' });
  const exited = new Promise(resolve => client.once('exit', resolve));
  try {
    let devtoolsPort;
    for (let attempt = 0; attempt < 150 && !devtoolsPort; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 200));
      devtoolsPort = await fs.readFile(path.join(clientDir, 'DevToolsActivePort'), 'utf8')
        .then(contents => contents.split('\n')[0], () => undefined);
    }
    if (!devtoolsPort) throw new Error('The identity client did not start.');
    const page = await Page.attach(devtoolsPort, url => url.endsWith('/index.html'));
    await page.setViewport(WIDTH, HEIGHT);
    await page.waitUntil(`[...document.querySelectorAll('button')].filter(button => button.offsetParent).length >= 2`, 'the identity screen');
    await page.capture(file);
    page.close();
  } finally {
    client.kill();
    await exited;
    await fs.rm(run.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

async function run(options) {
  await fs.mkdir(options.out, { recursive: true });
  for (const language of options.languages) {
    const suffix = language === 'en' ? 'en' : 'pt';
    if (!options.hold && (!options.only || options.only.has('identidade'))) {
      const file = path.join(options.out, `identidade-${suffix}.png`);
      await captureIdentity(language, file);
      console.log(file);
    }
    if (options.only && [...options.only].every(name => name === 'identidade')) continue;
    const run = await makeRunDirectory();
    const scene = {};
    try {
      await prepareScene(run, language, scene);
      for (const shot of shots) {
        if (options.only ? !options.only.has(shot.name) : options.hold) continue;
        const file = path.join(options.out, `${shot.name}-${suffix}.png`);
        await shot.take(scene, file);
        console.log(file);
      }
      if (options.hold) {
        await fs.writeFile(path.join(repoRoot, '.qa', 'docs-screenshots.json'), JSON.stringify({
          devtoolsPort: scene.app.devtoolsPort, channels: scene.context.channels, manifestUrl: scene.bot.manifestUrl,
        }, null, 2));
        console.log(`Scene ready (${language}). DevTools port ${scene.app.devtoolsPort}. Press Ctrl+C to stop.`);
        await new Promise(resolve => process.once('SIGINT', resolve));
      }
    } finally {
      await closeScene(scene);
      await fs.rm(run.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }
}

await run(parseArguments(process.argv.slice(2)));
process.exit(0);
