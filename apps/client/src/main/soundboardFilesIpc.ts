import { SOUNDBOARD_FILES_IPC } from '@monky/shared';
import type { IpcRegistry } from './ipc/registry';
import type { SoundboardFiles } from './soundboardFiles';

/** Editing the files of the confirmed soundboard folder; any other sender gets `invalid_request`. */
export function registerSoundboardFilesIpc(registry: IpcRegistry, files: SoundboardFiles): void {
  const policy = { from: 'main', refused: { status: 'failed', reason: 'invalid_request' } } as const;
  registry.handle(SOUNDBOARD_FILES_IPC.read, policy, (_event, input) => files.read(input));
  registry.handle(SOUNDBOARD_FILES_IPC.open, policy, (_event, input) => files.openEditor(input));
  registry.handle(SOUNDBOARD_FILES_IPC.overwrite, policy, (_event, input) => files.overwrite(input));
  registry.handle(SOUNDBOARD_FILES_IPC.rename, policy, (_event, input) => files.rename(input));
  registry.handle(SOUNDBOARD_FILES_IPC.delete, policy, (_event, input) => files.delete(input));
  registry.handle(SOUNDBOARD_FILES_IPC.edit, policy, (_event, input) => files.edit(input));
}
