import { dialog, type BrowserWindow, type OpenDialogOptions, type WebContents } from 'electron';
import { attachDevTools } from './discordWebFrames';
import { isRecord } from './ipc/guards';

/**
 * Opens the files Discord asks for (its "+" button, an avatar, an emoji) over
 * Monky's window. Chromium would open its chooser over the page's own window,
 * which is hidden: the chooser showed away from Monky and Monky went on as if
 * nothing were open. DevTools takes the chooser instead (Chromium then cancels
 * its own), Monky asks for the files over its window, and DevTools hands the
 * chosen ones to the page's file field, which tells Discord as a person's
 * choice would.
 */
export class DiscordWebFileChooser {
  private watching = false;

  constructor(private readonly contents: WebContents, private readonly owner: BrowserWindow) {
    contents.debugger.on('message', (_event, method: string, params: unknown) => {
      if (method === 'Page.fileChooserOpened') void this.choose(params);
    });
  }

  /** Takes the page's chooser from now on; the page asks for files only after the person used it. */
  watch(): void {
    if (this.watching) return;
    try {
      attachDevTools(this.contents);
    } catch (error) {
      console.warn('[Discord web] Could not open Discord\'s file chooser over Monky.', error instanceof Error ? error.message : error);
      return;
    }
    this.watching = true;
    // The page reports its chooser only to a client following its page events.
    void this.contents.debugger.sendCommand('Page.enable')
      .then(() => this.contents.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true }))
      .catch(error => {
        this.watching = false;
        console.warn('[Discord web] Could not open Discord\'s file chooser over Monky.', error instanceof Error ? error.message : error);
      });
  }

  /** DevTools let go of the page, and with it the chooser: it is taken again on the next input. */
  detached(): void {
    this.watching = false;
  }

  private async choose(params: unknown): Promise<void> {
    const field = isRecord(params) ? params.backendNodeId : undefined;
    if (typeof field !== 'number' || this.owner.isDestroyed()) return;
    const properties: OpenDialogOptions['properties'] = isRecord(params) && params.mode === 'selectMultiple'
      ? ['openFile', 'multiSelections'] : ['openFile'];
    try {
      const { canceled, filePaths } = await dialog.showOpenDialog(this.owner, { properties });
      // A page closed or gone elsewhere meanwhile no longer has the field that asked.
      if (canceled || !filePaths.length || this.contents.isDestroyed() || !this.contents.debugger.isAttached()) return;
      await this.contents.debugger.sendCommand('DOM.setFileInputFiles', { files: filePaths, backendNodeId: field });
    } catch (error) {
      console.warn('[Discord web] Could not hand the chosen files to Discord.', error instanceof Error ? error.message : error);
    }
  }
}
