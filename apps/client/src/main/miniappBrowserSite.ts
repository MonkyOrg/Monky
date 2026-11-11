import { BaseWindow, WebContentsView, type Rectangle, type View, type WebContents, type WebPreferences } from 'electron';

/** A captured site keeps a painting root even when the main window/stage is hidden. */
export class MiniappBrowserSite {
  readonly root: BaseWindow;
  readonly view: WebContentsView;
  readonly contents: WebContents;
  private parent: View;
  private closed = false;

  constructor(preferences: WebPreferences, width: number, height: number) {
    this.root = new BaseWindow({ show: false, focusable: false, skipTaskbar: true, useContentSize: true, width, height });
    let view: WebContentsView | undefined;
    try {
      view = new WebContentsView({
        webPreferences: { ...preferences, focusOnNavigation: false },
      });
      this.root.contentView.addChildView(view);
      view.setBounds({ x: 0, y: 0, width, height });
    } catch (error: unknown) {
      if (view && !view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
      this.root.destroy();
      throw error;
    }
    this.view = view;
    this.contents = view.webContents;
    this.parent = this.root.contentView;
    this.view.webContents.once('destroyed', this.close);
    this.root.once('closed', this.close);
  }

  present(container: View, bounds: Rectangle, visible: boolean): void {
    if (this.closed || this.view.webContents.isDestroyed()) return;
    const parent = visible ? container : this.root.contentView;
    if (this.parent !== parent) {
      this.parent.removeChildView(this.view);
      // Removal can synchronously close/revoke the entry. Never reattach a retired site.
      if (this.closed || this.view.webContents.isDestroyed()) return;
      this.parent = parent;
      parent.addChildView(this.view);
      if (this.closed || this.view.webContents.isDestroyed()) return;
    }
    if (visible) this.view.setBounds(bounds);
    else {
      const { width, height } = bounds;
      const [oldWidth, oldHeight] = this.root.getContentSize();
      if (width !== oldWidth || height !== oldHeight) this.root.setContentSize(width, height);
      this.view.setBounds({ x: 0, y: 0, width, height });
    }
  }

  close = (): void => {
    if (this.closed) return;
    this.closed = true;
    const contents = this.contents;
    if (!contents.isDestroyed()) {
      contents.setAudioMuted(true);
      contents.stop();
      contents.close({ waitForBeforeUnload: false });
    }
    // BaseWindow does not own the lifetime of a child view's WebContents.
    if (!this.root.isDestroyed()) this.root.destroy();
  };
}
