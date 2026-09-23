import { ipcRenderer } from 'electron';
import { CRASH_RECOVERY_IPC } from '@monky/shared';
import type { CrashRecoveryActionResult, IpcInvokeChannels } from '@monky/shared';

function invoke<K extends keyof IpcInvokeChannels>(
  channel: K, ...args: IpcInvokeChannels[K]['args']
): Promise<IpcInvokeChannels[K]['returnType']> {
  return ipcRenderer.invoke(channel, ...args);
}

// No Node/Electron object or general-purpose bridge is exposed to this page.
window.addEventListener('DOMContentLoaded', () => {
  const status = document.getElementById('recovery-status');
  const controller = new AbortController();
  let pending = false;
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('button')];
  const showStatus = (key: string): void => {
    if (status) status.textContent = status.dataset[key] ?? status.dataset.failed ?? '';
  };
  const action = (id: string, perform: () => Promise<CrashRecoveryActionResult>, success: string): void => {
    document.getElementById(id)?.addEventListener('click', async () => {
      if (pending) return;
      pending = true;
      buttons.forEach(button => { button.disabled = true; });
      showStatus('wait');
      try {
        const result = await perform();
        if (result.ok) {
          showStatus(success === 'opened' && !result.copied ? 'openedNoCopy' : success);
        } else if (result.reason === 'open-failed' && result.copied) {
          showStatus('reportFailed');
        } else {
          showStatus(result.reason === 'restart-failed' ? 'restartFailed' : 'failed');
        }
      } catch {
        showStatus('failed');
      } finally {
        pending = false;
        buttons.forEach(button => { button.disabled = false; });
      }
    }, { signal: controller.signal });
  };
  action('recovery-report', () => invoke(CRASH_RECOVERY_IPC.report), 'opened');
  action('recovery-copy', () => invoke(CRASH_RECOVERY_IPC.copy), 'copied');
  action('recovery-reopen', () => invoke(CRASH_RECOVERY_IPC.reopen), 'wait');
  document.getElementById('recovery-close')?.addEventListener('click', () => {
    void invoke(CRASH_RECOVERY_IPC.close).catch(() => showStatus('failed'));
  }, { signal: controller.signal });
  window.addEventListener('pagehide', () => controller.abort(), { once: true });
  document.getElementById('recovery-title')?.focus();
  void invoke(CRASH_RECOVERY_IPC.ready).catch(() => showStatus('failed'));
}, { once: true });
