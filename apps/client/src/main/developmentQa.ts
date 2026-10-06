import { BrowserWindow, ipcMain } from 'electron';
import fs from 'fs';
import path from 'path';
import { developmentQaConfigSchema, developmentQaReportSchema, DEVELOPMENT_QA_IPC, type DevelopmentQaConfig } from '@monky/shared';

export function configureDevelopmentQaMedia(
  commandLine: Pick<Electron.CommandLine, 'appendSwitch'>,
  config: DevelopmentQaConfig | null,
): void {
  if (!config) return;
  if (config.realMedia && config.smoke) throw new Error('Real capture devices cannot be used in unattended QA.');
  if (!config.realMedia) {
    commandLine.appendSwitch('use-fake-device-for-media-stream');
    commandLine.appendSwitch('use-fake-ui-for-media-stream');
  }
  if (config.smoke) commandLine.appendSwitch('mute-audio');
}

export function loadDevelopmentQa(options: {
  packaged: boolean;
  appPath: string;
  profile: string;
  configFile?: string;
  parentPid: number;
  supervised: boolean;
}): DevelopmentQaConfig | null {
  if (!options.configFile) return null;
  if (options.packaged || !options.supervised || !options.profile) {
    throw new Error('Prepared QA requires an unpackaged app, its owning npm QA launcher and an explicit isolated profile.');
  }
  const allowed = fs.realpathSync(path.resolve(options.appPath, '..', '..', '.qa', 'runs'));
  const filename = fs.realpathSync(options.configFile);
  const root = path.dirname(filename);
  const relative = path.relative(allowed, root);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep) ||
      path.basename(filename) !== 'launch.json' || fs.statSync(filename).size > 16_384 ||
      fs.realpathSync(options.profile) !== fs.realpathSync(path.join(root, 'client'))) {
    throw new Error('Prepared QA configuration/profile is outside the launcher-owned run directory.');
  }
  const envelope: unknown = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (!envelope || typeof envelope !== 'object' || !('ownerPid' in envelope) || envelope.ownerPid !== options.parentPid ||
      !('config' in envelope)) throw new Error('Prepared QA configuration does not belong to this launcher.');
  const config = developmentQaConfigSchema.parse(envelope.config);
  if (path.basename(root) !== `${config.scenario}-${config.runId}`) throw new Error('Prepared QA run identity does not match its directory.');
  return config;
}

export function bindDevelopmentQa(window: BrowserWindow, config: DevelopmentQaConfig | null, quit: () => void): () => void {
  const contents = window.webContents;
  const owns = (event: Electron.IpcMainInvokeEvent): boolean =>
    event.sender === contents && event.senderFrame === contents.mainFrame;
  ipcMain.handle(DEVELOPMENT_QA_IPC.config, (event): DevelopmentQaConfig | null => owns(event) ? config : null);
  ipcMain.handle(DEVELOPMENT_QA_IPC.report, (event, input: unknown): boolean => {
    const parsed = developmentQaReportSchema.safeParse(input);
    if (!config || !owns(event) || !parsed.success || parsed.data.runId !== config.runId ||
        parsed.data.scenario !== config.scenario || !process.connected) return false;
    process.send?.({ type: 'qa-report', report: parsed.data });
    return true;
  });
  const message = (input: unknown): void => {
    if (!config || !input || typeof input !== 'object' || !('runId' in input) || input.runId !== config.runId || !('type' in input)) return;
    if (input.type === 'qa-stop') quit();
    if (input.type === 'qa-ping' && 'id' in input) {
      process.send?.({ type: 'qa-response', id: input.id, value: {
        alive: !window.isDestroyed() && !contents.isCrashed(),
        visible: !window.isDestroyed() && window.isVisible(),
      } });
    }
  };
  const rendererGone = (): void => {
    process.send?.({ type: 'qa-failed', error: 'Prepared QA renderer terminated.' });
    quit();
  };
  if (config) {
    process.on('message', message);
    process.once('disconnect', quit);
    contents.on('render-process-gone', rendererGone);
  }
  return () => {
    ipcMain.removeHandler(DEVELOPMENT_QA_IPC.config);
    ipcMain.removeHandler(DEVELOPMENT_QA_IPC.report);
    process.removeListener('message', message);
    process.removeListener('disconnect', quit);
    contents.removeListener('render-process-gone', rendererGone);
  };
}
