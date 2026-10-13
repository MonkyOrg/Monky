const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const ts = require('typescript');
const shared = require('@monky/shared');

const root = path.join(__dirname, '..');
const skillsDirectory = path.join(root, 'hosting-skills');

function loadModule({ dialog = {}, app = {}, handlers = new Map(), warnings = [] } = {}) {
  const source = fs.readFileSync(path.join(root, 'src', 'main', 'hostingSkills.ts'), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const exports = {};
  vm.runInNewContext(output, {
    exports, Buffer, __dirname: path.join(root, 'dist-electron', 'main'),
    console: { warn: (...args) => warnings.push(args) },
    require: name => {
      if (name === '@monky/shared') return shared;
      if (['node:fs/promises', 'node:path', 'node:zlib'].includes(name)) return require(name);
      if (name === './i18n') return { mt: key => key };
      if (name === 'electron') return {
        app, dialog,
        ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) },
      };
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  return exports;
}

/** Independent reader: checks both headers, the CRC and that every byte is accounted for. */
function readZip(buffer) {
  const end = buffer.length - 22;
  assert.equal(buffer.readUInt32LE(end), 0x06054b50);
  const count = buffer.readUInt16LE(end + 10);
  let cursor = buffer.readUInt32LE(end + 16);
  assert.equal(cursor + buffer.readUInt32LE(end + 12), end, 'central directory ends where the end record starts');
  const entries = [];
  for (let index = 0; index < count; index++) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50);
    assert.equal(buffer.readUInt16LE(cursor + 8) & 0x0800, 0x0800, 'names are flagged as UTF-8');
    assert.equal(buffer.readUInt16LE(cursor + 10), 8, 'entries are deflated');
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const offset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    assert.equal(buffer.readUInt32LE(offset), 0x04034b50);
    assert.equal(buffer.readUInt32LE(offset + 14), crc);
    assert.equal(buffer.toString('utf8', offset + 30, offset + 30 + buffer.readUInt16LE(offset + 26)), name);
    const start = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
    const data = zlib.inflateRawSync(buffer.subarray(start, start + compressedSize));
    assert.equal(data.length, size);
    assert.equal(zlib.crc32(data), crc);
    entries.push({ name, data });
    cursor += 46 + nameLength + buffer.readUInt16LE(cursor + 30) + buffer.readUInt16LE(cursor + 32);
  }
  return entries;
}

function python() {
  for (const command of ['python3', 'python']) {
    const probe = spawnSync(command, ['--version'], { encoding: 'utf8' });
    if (probe.status === 0) return command;
  }
  return null;
}

test('every hosting skill composes into a valid SKILL.md with the shared rules', async () => {
  const { composeHostingSkill } = loadModule();
  const methodFiles = fs.readdirSync(skillsDirectory).filter(name => name.endsWith('.md')).sort();
  assert.deepEqual(methodFiles, shared.HOSTING_SKILL_IDS.map(id => `${id}.md`).sort(), 'one skill file per id, no orphans');
  for (const id of shared.HOSTING_SKILL_IDS) {
    const skill = await composeHostingSkill(id);
    const frontMatter = /^---\nname: ([^\n]+)\ndescription: ([^\n]+)\n---\n/.exec(skill);
    assert.ok(frontMatter, `${id} starts with name and description front matter`);
    const [, name, description] = frontMatter;
    assert.equal(name, shared.hostingSkillName(id));
    assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(name.length <= 64);
    assert.ok(description.length >= 80 && description.length <= 1024, `${id} description length`);
    assert.ok(!/: |^[\s'"[{>|*&!%@`#-]/.test(description), `${id} description is a plain YAML scalar`);
    assert.ok(!skill.includes('<!-- include') && !skill.includes('\r'), `${id} has every include resolved and LF lines`);
    assert.equal(skill.split('## Ground rules').length, 2, `${id} carries the shared rules once`);
    assert.match(skill, /\/health/);
  }
  assert.match(await composeHostingSkill('vps-oracle'), /monky create --name/, 'VPS skills include the CLI section');
  assert.doesNotMatch(await composeHostingSkill('lan'), /monky create --name/, 'desktop skills skip the CLI section');
});

test('malformed hosting skills are rejected', async () => {
  const { composeHostingSkill } = loadModule();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-hosting-skills-'));
  try {
    fs.mkdirSync(path.join(directory, 'shared'));
    fs.writeFileSync(path.join(directory, 'shared', 'common.md'), '## Ground rules\r\n');
    fs.writeFileSync(path.join(directory, 'lan.md'), '---\r\nname: monky-server-lan\r\ndescription: x\r\n---\r\n<!-- include: shared/common.md -->\r\n');
    assert.equal(await composeHostingSkill('lan', directory), '---\nname: monky-server-lan\ndescription: x\n---\n## Ground rules\n');
    fs.writeFileSync(path.join(directory, 'lan.md'), '---\nname: monky-server-lan\ndescription: x\n---\nno rules\n');
    await assert.rejects(composeHostingSkill('lan', directory), /malformed/);
    fs.writeFileSync(path.join(directory, 'lan.md'), '---\nname: other\ndescription: x\n---\n<!-- include: shared/common.md -->\n');
    await assert.rejects(composeHostingSkill('lan', directory), /malformed/);
    fs.writeFileSync(path.join(directory, 'lan.md'), '---\nname: monky-server-lan\n---\n<!-- include: shared/missing.md -->\n<!-- include: shared/common.md -->\n');
    await assert.rejects(composeHostingSkill('lan', directory), /ENOENT/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('the ZIP writer produces archives standard tools can read', t => {
  const { createZip } = loadModule();
  const files = [
    { path: 'monky-server-lan/SKILL.md', data: Buffer.from('# Olá, Monky 🐵\n'.repeat(50)) },
    { path: 'monky-server-lan/notes/empty.txt', data: Buffer.alloc(0) },
  ];
  const archive = createZip(files, new Date(2026, 9, 9, 18, 41, 33));
  const entries = readZip(archive);
  assert.deepEqual(entries.map(entry => entry.name), files.map(file => file.path));
  entries.forEach((entry, index) => assert.ok(entry.data.equals(files[index].data)));
  assert.equal(archive.readUInt16LE(10), (18 << 11) | (41 << 5) | 16, 'DOS time');
  assert.equal(archive.readUInt16LE(12), ((2026 - 1980) << 9) | (10 << 5) | 9, 'DOS date');

  const interpreter = python();
  if (!interpreter) return t.diagnostic('python not found: skipped the zipfile cross-check');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'monky-zip-')), 'skill.zip');
  try {
    fs.writeFileSync(file, archive);
    const check = spawnSync(interpreter, ['-c',
      'import sys, zipfile\nz = zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nprint("\\n".join(z.namelist()))', file], { encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr);
    assert.deepEqual(check.stdout.trim().split(/\r?\n/), files.map(entry => entry.path));
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('hosting skill IPC validates sender and id, saves the zip, handles cancel/failure and tears down', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-hosting-skill-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const handlers = new Map(), dialogs = [], warnings = [];
  const frame = {}, contents = { mainFrame: frame };
  const window = { webContents: contents, isDestroyed: () => false };
  const event = { sender: contents, senderFrame: frame };
  let selection = { canceled: false, filePath: path.join(directory, 'skill.zip') };
  let dialogGate;
  const { setupHostingSkillIpc, composeHostingSkill } = loadModule({
    handlers, warnings,
    app: { getPath: name => { assert.equal(name, 'downloads'); return directory; } },
    dialog: { showSaveDialog: async (_owner, options) => { dialogs.push(options); return dialogGate ? await dialogGate : selection; } },
  });
  const dispose = setupHostingSkillIpc(window);
  const handler = handlers.get(shared.HOSTING_SKILL_IPC);

  for (const sender of [{ ...event, sender: {} }, { ...event, senderFrame: {} }]) {
    assert.equal((await handler(sender, 'tailscale')).status, 'failed');
  }
  for (const invalid of ['../common', 'radmin-vpn', 42, undefined]) {
    const result = await handler(event, invalid);
    assert.equal(result.status, 'failed');
    assert.equal(result.error, 'hostingSkill.failed');
  }
  assert.equal(dialogs.length, 0, 'nothing is offered for rejected requests');

  assert.equal((await handler(event, 'tailscale')).status, 'saved');
  assert.equal(dialogs[0].defaultPath, path.join(directory, 'monky-server-tailscale.zip'));
  assert.equal(dialogs[0].filters[0].extensions.join(), 'zip');
  const [entry, ...rest] = readZip(fs.readFileSync(selection.filePath));
  assert.equal(rest.length, 0);
  assert.equal(entry.name, 'monky-server-tailscale/SKILL.md');
  assert.equal(entry.data.toString('utf8'), await composeHostingSkill('tailscale'));

  selection = { canceled: true };
  assert.equal((await handler(event, 'lan')).status, 'cancelled');
  selection = { canceled: false, filePath: path.join(directory, 'missing', 'skill.zip') };
  assert.equal((await handler(event, 'lan')).error, 'hostingSkill.failed');

  let release;
  dialogGate = new Promise(resolve => { release = resolve; });
  const pending = handler(event, 'lan');
  assert.equal((await handler(event, 'lan')).status, 'failed', 'one save dialog at a time');
  dispose();
  const discarded = path.join(directory, 'discarded.zip');
  release({ canceled: false, filePath: discarded });
  assert.equal((await pending).status, 'cancelled');
  assert.equal(fs.existsSync(discarded), false);
  assert.equal(handlers.size, 0);
  assert.ok(warnings.length >= 8);
});
