import { app, dialog, type BrowserWindow } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  HOSTING_SKILL_IPC, hostingSkillIdSchema, hostingSkillName, type HostingSkillId, type HostingSkillSaveResult,
} from '@monky/shared';
import { mt } from './i18n';
import type { IpcRegistry } from './ipc/registry';
import { createZip } from './zipWriter';

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

/** The skill is saved as `<name>.zip` holding `<name>/SKILL.md`, the layout agent skill folders and uploads expect. */
export function registerHostingSkillIpc(registry: IpcRegistry, mainWindow: BrowserWindow): void {
  let saving = false, disposed = false;
  registry.onDispose(() => { disposed = true; });
  const refused: HostingSkillSaveResult = { status: 'failed', error: mt('hostingSkill.failed') };
  registry.handle(HOSTING_SKILL_IPC, { from: 'main', refused }, async (_event, input): Promise<HostingSkillSaveResult> => {
    if (disposed || mainWindow.isDestroyed() || saving) {
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
}
