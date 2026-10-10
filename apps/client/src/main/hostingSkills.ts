import { app, dialog, ipcMain, type BrowserWindow } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import {
  HOSTING_SKILL_IPC, hostingSkillIdSchema, hostingSkillName, type HostingSkillId, type HostingSkillSaveResult,
} from '@monky/shared';
import { mt } from './i18n';

const SKILLS_DIRECTORY = path.join(__dirname, '..', '..', 'hosting-skills');
/** Method files pull shared sections with this marker; every skill must include the common rules. */
const INCLUDE = /<!-- include: (shared\/[a-z-]+\.md) -->/g;
const COMMON = 'shared/common.md';

const toLf = (text: string): string => text.replace(/\r\n/g, '\n');

/** SKILL.md of one hosting method: its own steps plus the shared sections it includes. */
export async function composeHostingSkill(id: HostingSkillId, directory = SKILLS_DIRECTORY): Promise<string> {
  // Git may check the files out with CRLF; agents expect the front matter on LF lines.
  const skill = toLf(await readFile(path.join(directory, `${id}.md`), 'utf8'));
  const included = [...skill.matchAll(INCLUDE)].map((match) => match[1]);
  if (!skill.startsWith(`---\nname: ${hostingSkillName(id)}\n`) || included.filter((name) => name === COMMON).length !== 1) {
    throw new Error(`The ${id} hosting skill is malformed.`);
  }
  const sections = new Map(await Promise.all([...new Set(included)].map(async (name) =>
    [name, toLf(await readFile(path.join(directory, name), 'utf8')).trim()] as const)));
  return skill.replace(INCLUDE, (_marker, name: string) => sections.get(name) ?? '');
}

/** Deflated ZIP without ZIP64: enough for a skill of a few kilobytes. */
export function createZip(files: { path: string; data: Buffer }[], modified = new Date()): Buffer {
  const time = (modified.getHours() << 11) | (modified.getMinutes() << 5) | (modified.getSeconds() >> 1);
  const date = ((modified.getFullYear() - 1980) << 9) | ((modified.getMonth() + 1) << 5) | modified.getDate();
  const UTF8_NAMES = 0x0800, DEFLATE = 8, VERSION = 20;
  const records: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.path, 'utf8');
    const compressed = deflateRawSync(file.data);
    const checksum = crc32(file.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(DEFLATE, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(VERSION, 4);
    central.writeUInt16LE(VERSION, 6);
    central.writeUInt16LE(UTF8_NAMES, 8);
    central.writeUInt16LE(DEFLATE, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    records.push(local, name, compressed);
    directory.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...records, centralDirectory, end]);
}

/** The skill is saved as `<name>.zip` holding `<name>/SKILL.md`, the layout agent skill folders and uploads expect. */
export function setupHostingSkillIpc(mainWindow: BrowserWindow): () => void {
  let saving = false, disposed = false;
  ipcMain.handle(HOSTING_SKILL_IPC, async (event, input: unknown): Promise<HostingSkillSaveResult> => {
    if (disposed || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents
      || event.senderFrame !== mainWindow.webContents.mainFrame || saving) {
      console.warn('[Onboarding] Rejected hosting skill download from an unavailable sender or while saving.');
      return { status: 'failed', error: mt('hostingSkill.failed') };
    }
    saving = true;
    try {
      const id = hostingSkillIdSchema.parse(input);
      const name = hostingSkillName(id);
      const archive = createZip([{ path: `${name}/SKILL.md`, data: Buffer.from(await composeHostingSkill(id), 'utf8') }]);
      const result = await dialog.showSaveDialog(mainWindow, {
        title: mt('hostingSkill.save'),
        defaultPath: path.join(app.getPath('downloads'), `${name}.zip`),
        filters: [{ name: mt('hostingSkill.filter'), extensions: ['zip'] }],
      });
      if (result.canceled || !result.filePath || disposed || mainWindow.isDestroyed()) return { status: 'cancelled' };
      await writeFile(result.filePath, archive);
      return { status: 'saved' };
    } catch (error) {
      console.warn('[Onboarding] Hosting skill download failed.', error);
      return { status: 'failed', error: mt('hostingSkill.failed') };
    } finally { saving = false; }
  });
  return () => { disposed = true; ipcMain.removeHandler(HOSTING_SKILL_IPC); };
}
