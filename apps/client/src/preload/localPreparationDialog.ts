import { ipcRenderer } from 'electron';
import {
  LOCAL_PREPARATION_DIALOG_CHANGED, LOCAL_PREPARATION_DIALOG_IPC,
  type LocalPreparationDialogAction, type LocalPreparationDialogState,
} from '@monky/shared/dist/ipc';

function element<T extends HTMLElement>(selector: string): T {
  const result = document.querySelector<T>(selector);
  if (!result) throw new Error(`Missing local preparation dialog element: ${selector}`);
  return result;
}

function text(node: HTMLElement, value: string): void {
  if (node.textContent !== value) node.textContent = value;
}

window.addEventListener('DOMContentLoaded', () => {
  const choices = element('#choices');
  const connection = element<HTMLButtonElement>('#connection-choice');
  const always = element<HTMLButtonElement>('#always-choice');
  const allow = element<HTMLButtonElement>('#allow');
  const deny = element<HTMLButtonElement>('#deny');
  const cancel = element<HTMLButtonElement>('#cancel');
  const dismiss = element<HTMLButtonElement>('#dismiss');
  const retry = element<HTMLButtonElement>('#retry');
  const close = element<HTMLButtonElement>('#close');
  const progressSection = element('#progress-section');
  const progress = element('#progress');
  const fill = element('#progress-fill');
  const spinner = element('#spinner');
  const status = element('#status');
  const detail = element('#detail');
  const title = element('#title');
  const storage = document.getElementById('storage');
  const mode = document.body.dataset.mode;
  const maintenance = mode === 'remove' || mode === 'cache';
  let selected: 'connection' | 'always' = 'always';
  let phase: LocalPreparationDialogState['phase'] = 'consent';
  let broken = false;

  const ipcFailed = (error: unknown): void => {
    console.error('[LocalExecution] Preparation dialog communication failed', error);
    broken = true;
    progressSection.hidden = false;
    spinner.hidden = progress.hidden = allow.hidden = deny.hidden = cancel.hidden = retry.hidden = true;
    dismiss.hidden = false;
    dismiss.disabled = false;
    text(status, document.body.dataset.ipcError ?? '');
    text(detail, '');
    status.setAttribute('role', 'alert');
  };
  const act = (action: LocalPreparationDialogAction): void => {
    if (broken) { window.close(); return; }
    void ipcRenderer.invoke(LOCAL_PREPARATION_DIALOG_IPC.action, action).catch(ipcFailed);
  };
  const select = (value: typeof selected, focus = false): void => {
    selected = value;
    connection.setAttribute('aria-checked', String(value === 'connection'));
    always.setAttribute('aria-checked', String(value === 'always'));
    connection.tabIndex = value === 'connection' ? 0 : -1;
    always.tabIndex = value === 'always' ? 0 : -1;
    if (mode === 'consent') {
      const label = value === 'always' ? allow.dataset.allowAlways : allow.dataset.allowConnection;
      if (!label) throw new Error('Missing consent duration label');
      text(allow, label);
    }
    if (focus) (value === 'connection' ? connection : always).focus();
  };
  connection.addEventListener('click', () => select('connection'));
  always.addEventListener('click', () => select('always'));
  choices.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    select(event.key === 'Home' ? 'always' : event.key === 'End' ? 'connection'
      : selected === 'connection' ? 'always' : 'connection', true);
  });
  allow.addEventListener('click', () => {
    allow.disabled = deny.disabled = connection.disabled = always.disabled = true;
    act(maintenance ? 'confirm' : selected);
  });
  deny.addEventListener('click', () => {
    deny.disabled = allow.disabled = true;
    act(mode === 'consent' ? 'deny' : 'cancel');
  });
  cancel.addEventListener('click', () => { cancel.disabled = true; act('cancel'); });
  dismiss.addEventListener('click', () => act('close'));
  retry.addEventListener('click', () => {
    retry.disabled = dismiss.disabled = true;
    act('retry');
  });
  close.addEventListener('click', () => act(phase === 'failed' ? 'close' : 'cancel'));
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (maintenance && (phase === 'installing' || phase === 'cancelling')) return;
      act(phase === 'failed' ? 'close' : 'cancel');
    }
  });

  const render = (state: LocalPreparationDialogState): void => {
    if (broken) return;
    const phaseChanged = phase !== state.phase;
    phase = state.phase;
    document.body.dataset.phase = phase;
    text(title, state.title);
    text(status, state.status);
    text(detail, state.detail);
    if (storage) text(storage, state.storage);
    const confirming = phase === 'consent';
    const busy = phase === 'installing' || phase === 'cancelling';
    choices.hidden = !confirming || mode !== 'consent';
    allow.hidden = deny.hidden = !confirming;
    allow.disabled = deny.disabled = connection.disabled = always.disabled = !confirming;
    cancel.hidden = !busy || maintenance;
    cancel.disabled = phase === 'cancelling';
    close.disabled = phase === 'cancelling' || maintenance && busy;
    dismiss.hidden = retry.hidden = phase !== 'failed';
    dismiss.disabled = retry.disabled = phase !== 'failed';
    progressSection.hidden = confirming;
    spinner.hidden = progress.hidden = !busy;
    progressSection.setAttribute('aria-busy', String(busy));
    status.setAttribute('role', phase === 'failed' ? 'alert' : 'status');
    progress.classList.toggle('indeterminate', state.progress === null);
    if (state.progress === null) {
      progress.removeAttribute('aria-valuenow');
      fill.style.width = '';
    } else {
      progress.setAttribute('aria-valuenow', String(Math.round(state.progress)));
      fill.style.width = `${state.progress}%`;
    }
    for (const tool of state.tools) {
      const row = element(`[data-tool="${tool.id}"]`);
      row.dataset.ready = String(tool.ready);
      row.dataset.active = String(tool.active);
      text(element(`[data-tool="${tool.id}"] [data-tool-status]`), tool.status);
      text(element(`[data-tool="${tool.id}"] [data-tool-size]`), tool.size);
    }
    if (phaseChanged && phase === 'installing') (maintenance ? title : cancel).focus({ preventScroll: true });
    if (phaseChanged && phase === 'failed') retry.focus();
  };
  const changed = (_event: Electron.IpcRendererEvent, state: LocalPreparationDialogState): void => render(state);
  ipcRenderer.on(LOCAL_PREPARATION_DIALOG_CHANGED, changed);
  window.addEventListener('unload', () => ipcRenderer.removeListener(LOCAL_PREPARATION_DIALOG_CHANGED, changed), { once: true });
  select(selected);
  const ready = async (): Promise<void> => {
    const initial: LocalPreparationDialogState = await ipcRenderer.invoke(LOCAL_PREPARATION_DIALOG_IPC.state);
    render(initial);
    if (initial.phase === 'consent') title.focus({ preventScroll: true });
  };
  void ready().catch(ipcFailed);
}, { once: true });
