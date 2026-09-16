import type {
  LocalBotIdentity,
  LocalExecutionFailure,
  LocalExecutionMutationResult,
  LocalExecutionSnapshot,
  LocalPermissionInfo,
  LocalTaskInfo,
  LocalToolId,
  LocalToolInfo,
} from '@monky/shared';
import { getLanguage, t, type TranslationKey } from '../../../i18n';
import { formatBytes } from '../../../utils/attachment';
import { escapeHtml } from '../../../utils/html';
import { renderLoadingIndicator } from '../../../utils/loadingIndicator';

type Mutation =
  | { kind: 'permission'; permissionId: string; enabled: boolean }
  | { kind: 'remove'; tool: LocalToolId }
  | { kind: 'cache' }
  | { kind: 'cancel'; taskId: string };

const TOOL_NAMES: Record<LocalToolId, string> = { node: 'Node.js', 'yt-dlp': 'yt-dlp', ffmpeg: 'FFmpeg' };
const COMPLETED: Record<Mutation['kind'], TranslationKey> = {
  permission: 'localExecution.permissionUpdated',
  remove: 'localExecution.toolRemoved',
  cache: 'localExecution.cacheCleared',
  cancel: 'localExecution.taskCancelled',
};
const CARD_STYLE = 'padding: 12px; margin-bottom: 10px; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-md); overflow-wrap: anywhere;';
let nextTabId = 0;

function requiredElement<T extends HTMLElement = HTMLElement>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Local tools settings element missing: ${selector}`);
  return element;
}

function setText(root: ParentNode, selector: string, value: string): void {
  const element = requiredElement(root, selector);
  if (element.textContent !== value) element.textContent = value;
}

function show(element: HTMLElement, visible: boolean): void {
  if (element.hidden !== !visible) element.hidden = !visible;
}

function sectionHtml(id: string, label: TranslationKey, content: string): string {
  return `<section data-settings-section="${id}" data-settings-label="${escapeHtml(t(label))}"
    class="form-group" style="border-top: 1px solid var(--border-color); padding-top: 14px; margin-top: 16px;">
    <h3 tabindex="-1" style="font-size: 13px; margin: 0 0 10px;">${escapeHtml(t(label))}</h3>
    ${content}
  </section>`;
}

function identityHtml(): string {
  return `<strong data-field="identity-title"></strong>
    <div data-field="identity-origin" style="color: var(--text-muted); margin-top: 4px;"></div>
    <details style="margin-top: 4px;">
      <summary style="cursor: pointer; color: var(--text-muted);">${escapeHtml(t('localExecution.identityDetails'))}</summary>
      <div data-field="identity-details" style="white-space: pre-wrap; color: var(--text-muted); margin-top: 4px;"></div>
    </details>`;
}

function renderIdentity(row: HTMLElement, bot: LocalBotIdentity): void {
  setText(row, '[data-field="identity-title"]', t('localExecution.botAndServer', { bot: bot.botName, server: bot.serverName }));
  setText(row, '[data-field="identity-origin"]', t('localExecution.identityOrigin', { origin: bot.serverOrigin, botId: bot.botId }));
  setText(row, '[data-field="identity-details"]', t('localExecution.identityValue', { serverId: bot.serverId, publicKey: bot.botPublicKey }));
}

function reconcileRows<T>(
  list: HTMLElement,
  rows: Map<string, HTMLElement>,
  items: readonly T[],
  idOf: (item: T) => string,
  create: () => HTMLElement,
  update: (row: HTMLElement, item: T) => void,
): void {
  const retained = new Set<string>();
  for (const item of items) {
    const id = idOf(item);
    retained.add(id);
    let row = rows.get(id);
    if (!row) {
      row = create();
      rows.set(id, row);
      list.append(row);
    }
    // Keep keyed controls and expanded identity details in place during progress updates.
    update(row, item);
  }
  for (const [id, row] of rows) {
    if (retained.has(id)) continue;
    if (row.contains(document.activeElement)) {
      list.closest('section')?.querySelector<HTMLElement>('h3')?.focus({ preventScroll: true });
    }
    row.remove();
    rows.delete(id);
  }
}

export class LocalToolsTab {
  private root: HTMLElement | null = null;
  private readonly tabId = ++nextTabId;
  private nextPermissionId = 0;
  private generation = 0;
  private readSequence = 0;
  private readController: AbortController | null = null;
  private changeSequence = 0;
  private unsubscribe: (() => void) | null = null;
  private unbind: Array<() => void> = [];
  private snapshot: LocalExecutionSnapshot | null = null;
  private initialLoad: Promise<void> = Promise.resolve();
  private loading = false;
  private loadFailure: LocalExecutionFailure | null = null;
  private feedback = '';
  private feedbackError = false;
  private pending: Mutation | { kind: 'source'; tool: LocalToolId } | null = null;
  private permissionIntent: Extract<Mutation, { kind: 'permission' }> | null = null;
  private tools = new Map<string, HTMLElement>();
  private permissions = new Map<string, HTMLElement>();
  private tasks = new Map<string, HTMLElement>();

  public renderHtml(): string {
    return `<div data-local-tools-root style="font-size: 12px; line-height: 1.5;">
      <p style="margin-top: 0; color: var(--text-secondary);">${escapeHtml(t('localExecution.description'))}</p>
      <p style="color: var(--text-muted);">${escapeHtml(t('localExecution.safety'))}</p>
      <div data-local-loading role="status">${renderLoadingIndicator(t('localExecution.loading'))}</div>
      <div data-local-load-error class="bot-error" role="alert" hidden></div>
      <p data-local-unsupported role="status" hidden>${escapeHtml(t('localExecution.unsupported'))}</p>
      <div data-local-feedback role="status" aria-live="polite" aria-atomic="true"
        style="position: sticky; top: 0; background: var(--bg-secondary); z-index: 1; overflow-wrap: anywhere;" hidden></div>
      ${sectionHtml('local-tools-storage', 'localExecution.storage', `
        <div style="display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 10px;">
          <div>${escapeHtml(t('localExecution.toolsSize'))}<br><strong data-local-tools-size>${escapeHtml(t('localExecution.notLoaded'))}</strong></div>
          <div>${escapeHtml(t('localExecution.cacheSize'))}<br><strong data-local-cache-size>${escapeHtml(t('localExecution.notLoaded'))}</strong></div>
        </div>
        <p style="color: var(--text-muted);">${escapeHtml(t('localExecution.removalHint'))}</p>
        <div style="display: flex; gap: 8px; flex-wrap: wrap;">
          <button type="button" data-local-action="cache" class="btn btn-secondary" disabled>${escapeHtml(t('localExecution.clearCache'))}</button>
          <button type="button" data-local-action="refresh" class="btn btn-secondary">${escapeHtml(t('localExecution.refresh'))}</button>
        </div>
      `)}
      ${sectionHtml('local-tools-tools', 'localExecution.tools', `
        <p style="color: var(--text-muted);">${escapeHtml(t('localExecution.sharedTools'))}</p>
        <p data-local-empty="tools" style="color: var(--text-muted);" hidden>${escapeHtml(t('localExecution.noTools'))}</p>
        <div data-local-list="tools"></div>
      `)}
      ${sectionHtml('local-tools-permissions', 'localExecution.permissions', `
        <p style="color: var(--text-muted);">${escapeHtml(t('localExecution.permissionScope'))}</p>
        <p data-local-empty="permissions" style="color: var(--text-muted);" hidden>${escapeHtml(t('localExecution.noPermissions'))}</p>
        <div data-local-list="permissions"></div>
      `)}
      ${sectionHtml('local-tools-tasks', 'localExecution.tasks', `
        <p data-local-empty="tasks" style="color: var(--text-muted);" hidden>${escapeHtml(t('localExecution.noTasks'))}</p>
        <div data-local-list="tasks"></div>
      `)}
    </div>`;
  }

  public attachEvents(container: HTMLElement): Promise<void> {
    const root = requiredElement(container, '[data-local-tools-root]');
    if (this.root === root) return this.initialLoad;
    this.cleanup();
    this.root = root;
    const generation = this.generation;
    for (const list of root.querySelectorAll('[data-local-list]')) list.replaceChildren();
    const click = (event: Event) => {
      if (!this.isCurrent(root, generation) || !(event.target instanceof Element)) return;
      const button = event.target.closest<HTMLButtonElement>('button[data-local-action]');
      if (!button || !root.contains(button) || button.disabled || button.getAttribute('aria-disabled') === 'true' || this.pending) return;
      this.handleAction(button);
    };
    const change = (event: Event) => {
      if (!this.isCurrent(root, generation) || !(event.target instanceof HTMLInputElement)) return;
      const input = event.target;
      if (!input.hasAttribute('data-local-permission')) return;
      const permission = this.snapshot?.permissions.find((entry) => entry.id === input.dataset.localPermission);
      if (!permission) {
        this.setFeedback(t('localExecution.failure.invalid_request'), true);
      } else if (!this.pending && !input.disabled && input.getAttribute('aria-disabled') !== 'true'
        && input.checked !== (permission.decision !== 'deny')) {
        void this.mutate({ kind: 'permission', permissionId: permission.id, enabled: input.checked });
      }
      this.renderState();
    };
    root.addEventListener('click', click);
    root.addEventListener('change', change);
    this.unbind.push(() => root.removeEventListener('click', click), () => root.removeEventListener('change', change));
    this.initialLoad = this.subscribe(root, generation) ? this.refreshState(root, generation) : Promise.resolve();
    return this.initialLoad;
  }

  private isCurrent(root: HTMLElement, generation: number): boolean {
    return this.root === root && this.generation === generation && root.isConnected;
  }

  private subscribe(root: HTMLElement, generation: number): boolean {
    if (this.unsubscribe) return true;
    try {
      this.unsubscribe = window.api.onLocalExecutionChanged((snapshot) => {
        if (!this.isCurrent(root, generation)) return;
        this.changeSequence++;
        this.snapshot = snapshot;
        this.loadFailure = null;
        this.readController?.abort();
        this.renderState();
      });
      return true;
    } catch {
      this.loadFailure = 'executor_unavailable';
      this.renderState();
      return false;
    }
  }

  private async refreshState(root: HTMLElement, generation: number): Promise<void> {
    const read = ++this.readSequence;
    const changes = this.changeSequence;
    this.readController?.abort();
    const controller = new AbortController();
    this.readController = controller;
    this.loading = true;
    this.renderState();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 15_000);
    let abortRead!: () => void;
    const interrupted = new Promise<never>((_resolve, reject) => {
      abortRead = () => reject(new Error('Local inventory read interrupted'));
      controller.signal.addEventListener('abort', abortRead, { once: true });
    });
    let snapshot: LocalExecutionSnapshot;
    try {
      snapshot = await Promise.race([window.api.getLocalExecutionState(), interrupted]);
    } catch {
      if (!this.isCurrent(root, generation) || read !== this.readSequence) return;
      this.loading = false;
      if (changes === this.changeSequence) this.loadFailure = timedOut ? 'timeout' : 'transport_failed';
      this.renderState();
      return;
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', abortRead);
      if (this.readController === controller) this.readController = null;
    }
    if (!this.isCurrent(root, generation) || read !== this.readSequence) return;
    this.loading = false;
    // An IPC change received after this read began is newer than its eventual reply.
    if (changes === this.changeSequence) {
      this.snapshot = snapshot;
      this.loadFailure = null;
    }
    this.renderState();
  }

  private handleAction(button: HTMLButtonElement): void {
    const root = this.root;
    if (!root) return;
    if (button.dataset.localAction === 'refresh') {
      if (this.subscribe(root, this.generation)) void this.refreshState(root, this.generation);
      return;
    }
    if (!this.snapshot || this.loadFailure) {
      this.setFeedback(t('localExecution.failure.executor_unavailable'), true);
      return;
    }
    switch (button.dataset.localAction) {
      case 'cache':
        void this.mutate({ kind: 'cache' });
        return;
      case 'remove':
      case 'source': {
        const tool = this.snapshot.tools.find((entry) => entry.id === button.dataset.localTool);
        if (tool) {
          if (button.dataset.localAction === 'remove') void this.mutate({ kind: 'remove', tool: tool.id });
          else if (tool.sourceUrl) void this.openSource(tool.id, tool.sourceUrl);
          else this.setFeedback(t('localExecution.failure.invalid_request'), true);
          return;
        }
        break;
      }
      case 'cancel': {
        const task = this.snapshot.tasks.find((entry) => entry.id === button.dataset.localTask);
        if (task) {
          void this.mutate({ kind: 'cancel', taskId: task.id });
          return;
        }
        break;
      }
    }
    this.setFeedback(t('localExecution.failure.invalid_request'), true);
  }

  private requestMutation(mutation: Mutation): Promise<LocalExecutionMutationResult> {
    switch (mutation.kind) {
      case 'permission':
        return window.api.setLocalExecutionPermission({ permissionId: mutation.permissionId, enabled: mutation.enabled });
      case 'remove':
        return window.api.removeLocalTool(mutation.tool);
      case 'cache':
        return window.api.clearLocalExecutionCache();
      case 'cancel':
        return window.api.cancelLocalExecutionTask(mutation.taskId);
    }
  }

  private async mutate(mutation: Mutation): Promise<void> {
    const root = this.root;
    const generation = this.generation;
    if (!root || !this.isCurrent(root, generation) || this.pending) return;
    this.pending = mutation;
    if (mutation.kind === 'permission') this.permissionIntent = mutation;
    this.setFeedback(t('localExecution.pending'));
    let result: LocalExecutionMutationResult;
    try {
      result = await this.requestMutation(mutation);
    } catch {
      result = { status: 'failed', reason: 'transport_failed' };
    }
    if (!this.isCurrent(root, generation)) return;
    this.pending = null;
    if (result.status !== 'completed' && this.permissionIntent === mutation) this.permissionIntent = null;
    switch (result.status) {
      case 'completed':
        this.setFeedback(t(COMPLETED[mutation.kind]));
        break;
      case 'cancelled':
        this.setFeedback(t('localExecution.actionCancelled'));
        break;
      case 'failed':
        this.setFeedback(t(`localExecution.failure.${result.reason}`), true);
        break;
    }
    await this.refreshState(root, generation);
    if (!this.isCurrent(root, generation)) return;
    if (this.permissionIntent === mutation) this.permissionIntent = null;
    this.renderState();
  }

  private async openSource(tool: LocalToolId, url: string): Promise<void> {
    const root = this.root;
    const generation = this.generation;
    if (!root || !this.isCurrent(root, generation) || this.pending) return;
    this.pending = { kind: 'source', tool };
    this.setFeedback(t('localExecution.pending'));
    let success: boolean;
    try {
      success = (await window.api.openExternal(url)).success;
    } catch {
      success = false;
    }
    if (!this.isCurrent(root, generation)) return;
    this.pending = null;
    this.setFeedback(success ? '' : t('localExecution.sourceFailed'), !success);
  }

  private setFeedback(message: string, error = false): void {
    this.feedback = message;
    this.feedbackError = error;
    this.renderState();
  }

  private setControl(control: HTMLButtonElement | HTMLInputElement, disabled: boolean): void {
    // A task/tool may become unavailable while its focused action is pending.
    // Keep focus until the row disappears; delegated handlers also honor aria-disabled.
    control.disabled = disabled && document.activeElement !== control;
    control.setAttribute('aria-disabled', String(disabled || !!this.pending));
    const opacity = disabled || this.pending ? '0.6' : '';
    const visibleControl = control instanceof HTMLInputElement ? control.parentElement : control;
    if (visibleControl && visibleControl.style.opacity !== opacity) visibleControl.style.opacity = opacity;
  }

  private renderState(): void {
    const root = this.root;
    if (!root || !root.isConnected) return;
    const snapshot = this.snapshot;
    const unavailable = !snapshot || !!this.loadFailure;
    show(requiredElement(root, '[data-local-loading]'), this.loading && !snapshot);
    const error = requiredElement(root, '[data-local-load-error]');
    show(error, !!this.loadFailure);
    setText(root, '[data-local-load-error]', this.loadFailure
      ? t('localExecution.loadFailed', { reason: t(`localExecution.failure.${this.loadFailure}`) }) : '');
    show(requiredElement(root, '[data-local-unsupported]'), snapshot?.supported === false);
    const feedback = requiredElement(root, '[data-local-feedback]');
    show(feedback, !!this.feedback);
    const busy = this.pending !== null;
    if (feedback.dataset.message !== this.feedback || feedback.dataset.busy !== String(busy)) {
      feedback.dataset.message = this.feedback;
      feedback.dataset.busy = String(busy);
      if (busy) feedback.innerHTML = renderLoadingIndicator(this.feedback);
      else feedback.textContent = this.feedback;
    }
    feedback.setAttribute('aria-busy', String(busy));
    const color = this.feedbackError ? 'var(--text-danger)' : 'var(--text-secondary)';
    if (feedback.style.color !== color) feedback.style.color = color;
    setText(root, '[data-local-tools-size]', snapshot ? formatBytes(snapshot.toolsBytes) : t('localExecution.notLoaded'));
    setText(root, '[data-local-cache-size]', snapshot ? formatBytes(snapshot.cacheBytes) : t('localExecution.notLoaded'));
    this.setControl(requiredElement<HTMLButtonElement>(root, '[data-local-action="refresh"]'), this.loading);
    this.setControl(requiredElement<HTMLButtonElement>(root, '[data-local-action="cache"]'), unavailable || snapshot?.cacheBytes === 0);
    for (const kind of ['tools', 'permissions', 'tasks'] as const) {
      show(requiredElement(root, `[data-local-empty="${kind}"]`), !!snapshot && snapshot[kind].length === 0);
    }
    if (!snapshot) return;
    const permissions = new Map(snapshot.permissions.map((permission) => [permission.id, permission]));
    reconcileRows(requiredElement(root, '[data-local-list="tools"]'), this.tools, snapshot.tools, (tool) => tool.id,
      () => this.createToolRow(), (row, tool) => this.renderTool(row, tool, permissions, unavailable));
    reconcileRows(requiredElement(root, '[data-local-list="permissions"]'), this.permissions, snapshot.permissions, (permission) => permission.id,
      () => this.createPermissionRow(), (row, permission) => this.renderPermission(row, permission, snapshot.supported, unavailable));
    reconcileRows(requiredElement(root, '[data-local-list="tasks"]'), this.tasks, snapshot.tasks, (task) => task.id,
      () => this.createTaskRow(), (row, task) => this.renderTask(row, task, unavailable));
  }

  private createToolRow(): HTMLElement {
    const row = document.createElement('article');
    row.style.cssText = CARD_STYLE;
    row.innerHTML = `<div style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
        <strong data-field="tool-name"></strong>
        <button type="button" data-local-action="remove" class="btn btn-secondary">${escapeHtml(t('common.remove'))}</button>
      </div>
      <div data-field="tool-status" style="margin-top: 4px;"></div>
      <div data-field="tool-details" style="color: var(--text-muted);"></div>
      <div data-field="tool-progress" hidden>
        <div data-field="progress-label"></div>
        <progress style="width: 100%; height: 8px; accent-color: var(--accent-primary);"></progress>
      </div>
      <div data-field="tool-failure" class="bot-error" hidden></div>
      <div data-field="tool-source" style="overflow-wrap: anywhere;" hidden>
        <button type="button" data-local-action="source" class="bot-field-clear" style="text-align: left; overflow-wrap: anywhere;"></button>
      </div>
      <details style="margin-top: 8px;">
        <summary data-field="dependents-label" style="cursor: pointer;"></summary>
        <div data-field="dependents" style="white-space: pre-wrap; color: var(--text-muted); margin-top: 4px;"></div>
      </details>`;
    return row;
  }

  private renderTool(row: HTMLElement, tool: LocalToolInfo, permissions: Map<string, LocalPermissionInfo>, unavailable: boolean): void {
    row.dataset.localToolRow = tool.id;
    setText(row, '[data-field="tool-name"]', TOOL_NAMES[tool.id]);
    setText(row, '[data-field="tool-status"]', t(`localExecution.toolStatus.${tool.status}`));
    setText(row, '[data-field="tool-details"]', t('localExecution.toolDetails', {
      version: tool.version ?? t('localExecution.versionUnknown'), size: formatBytes(tool.sizeBytes),
    }));
    show(requiredElement(row, '[data-field="tool-failure"]'), !!tool.failure);
    setText(row, '[data-field="tool-failure"]', tool.failure ? t(`localExecution.failure.${tool.failure}`) : '');
    show(requiredElement(row, '[data-field="tool-progress"]'), !!tool.progress);
    if (tool.progress) {
      const { stage, downloadedBytes, totalBytes } = tool.progress;
      const stageLabel = t(`localExecution.stage.${stage}`);
      const label = stage === 'downloading' ? t(totalBytes === null ? 'localExecution.downloadUnknown' : 'localExecution.downloadKnown', {
        downloaded: formatBytes(downloadedBytes), total: formatBytes(totalBytes ?? 0),
      }) : stageLabel;
      setText(row, '[data-field="progress-label"]', stage === 'downloading' ? `${stageLabel}: ${label}` : label);
      const progress = requiredElement<HTMLProgressElement>(row, 'progress');
      progress.setAttribute('aria-label', t('localExecution.toolProgress', { tool: TOOL_NAMES[tool.id], stage: stageLabel }));
      progress.setAttribute('aria-valuetext', label);
      if (stage === 'downloading' && totalBytes !== null && totalBytes > 0) {
        progress.max = totalBytes;
        progress.value = Math.min(downloadedBytes, totalBytes);
      } else {
        progress.removeAttribute('value');
      }
    }
    const remove = requiredElement<HTMLButtonElement>(row, '[data-local-action="remove"]');
    remove.dataset.localTool = tool.id;
    remove.setAttribute('aria-label', t('localExecution.removeTool', { tool: TOOL_NAMES[tool.id] }));
    this.setControl(remove, unavailable || tool.status === 'absent' || tool.status === 'removing');
    const source = requiredElement<HTMLButtonElement>(row, '[data-local-action="source"]');
    source.dataset.localTool = tool.id;
    source.title = t('localExecution.openSource', { tool: TOOL_NAMES[tool.id] });
    show(requiredElement(row, '[data-field="tool-source"]'), !!tool.sourceUrl);
    setText(row, '[data-local-action="source"]', tool.sourceUrl ? t('localExecution.source', { url: tool.sourceUrl }) : '');
    this.setControl(source, unavailable || !tool.sourceUrl);
    setText(row, '[data-field="dependents-label"]', t('localExecution.dependents', { count: tool.requiredBy.length }));
    setText(row, '[data-field="dependents"]', tool.requiredBy.length ? tool.requiredBy.map((id) => {
      const permission = permissions.get(id);
      if (!permission) return t('localExecution.unknownDependent', { id });
      const { bot } = permission;
      return [
        t('localExecution.botAndServer', { bot: bot.botName, server: bot.serverName }),
        t('localExecution.identityOrigin', { origin: bot.serverOrigin, botId: bot.botId }),
        t('localExecution.identityValue', { serverId: bot.serverId, publicKey: bot.botPublicKey }),
      ].join('\n');
    }).join('\n\n') : t('localExecution.noDependents'));
  }

  private createPermissionRow(): HTMLElement {
    const row = document.createElement('article');
    row.className = 'bot-field';
    row.style.cssText = CARD_STYLE;
    const id = `local-permission-${this.tabId}-${++this.nextPermissionId}`;
    row.innerHTML = `<div style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
        <div style="min-width: 0;">${identityHtml()}</div>
        <label class="toggle-switch">
          <input type="checkbox" role="switch" data-local-permission aria-describedby="${id}-capability ${id}-decision ${id}-identity">
          <span class="toggle-slider"></span>
        </label>
      </div>
      <div id="${id}-capability" data-field="permission-capability" style="margin-top: 8px;"></div>
      <div id="${id}-decision" data-field="permission-decision" style="color: var(--text-muted);"></div>`;
    requiredElement(row, '[data-field="identity-details"]').id = `${id}-identity`;
    return row;
  }

  private renderPermission(row: HTMLElement, permission: LocalPermissionInfo, supported: boolean, unavailable: boolean): void {
    row.dataset.localPermissionRow = permission.id;
    renderIdentity(row, permission.bot);
    setText(row, '[data-field="permission-capability"]', t(`localExecution.capability.${permission.capability}`));
    setText(row, '[data-field="permission-decision"]', t(`localExecution.permission.${permission.decision}`));
    const input = requiredElement<HTMLInputElement>(row, '[data-local-permission]');
    input.dataset.localPermission = permission.id;
    input.setAttribute('aria-label', t('localExecution.permissionToggle', {
      bot: permission.bot.botName, server: permission.bot.serverName,
      origin: permission.bot.serverOrigin, botId: permission.bot.botId,
    }));
    input.checked = this.permissionIntent?.permissionId === permission.id ? this.permissionIntent.enabled : permission.decision !== 'deny';
    this.setControl(input, unavailable || this.permissionIntent?.permissionId === permission.id || (!supported && permission.decision === 'deny'));
  }

  private createTaskRow(): HTMLElement {
    const row = document.createElement('article');
    row.style.cssText = CARD_STYLE;
    row.innerHTML = `<div style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
        <div style="min-width: 0;">${identityHtml()}</div>
        <button type="button" data-local-action="cancel" class="btn btn-secondary">${escapeHtml(t('common.cancel'))}</button>
      </div>
      <div data-field="task-operation" style="margin-top: 8px;"></div>
      <div data-field="task-phase"></div>
      <div data-field="task-started" style="color: var(--text-muted);"></div>`;
    return row;
  }

  private renderTask(row: HTMLElement, task: LocalTaskInfo, unavailable: boolean): void {
    row.dataset.localTaskRow = task.id;
    renderIdentity(row, task.bot);
    setText(row, '[data-field="task-operation"]', t('localExecution.taskOperation', {
      capability: t(`localExecution.capability.${task.capability}`), operation: t(`localExecution.operation.${task.operation}`),
    }));
    setText(row, '[data-field="task-phase"]', t(`localExecution.phase.${task.phase}`));
    setText(row, '[data-field="task-started"]', t('localExecution.taskStarted', {
      time: new Intl.DateTimeFormat(getLanguage(), { dateStyle: 'short', timeStyle: 'medium' }).format(task.startedAt),
    }));
    const cancel = requiredElement<HTMLButtonElement>(row, '[data-local-action="cancel"]');
    cancel.dataset.localTask = task.id;
    cancel.setAttribute('aria-label', t('localExecution.cancelTask', { bot: task.bot.botName, server: task.bot.serverName }));
    this.setControl(cancel, unavailable || task.phase === 'cancelling');
  }

  public cleanup(): void {
    this.generation++;
    this.readController?.abort();
    this.readController = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unbind.forEach((off) => off());
    this.unbind = [];
    this.root = null;
    this.snapshot = null;
    this.initialLoad = Promise.resolve();
    this.pending = null;
    this.permissionIntent = null;
    this.loading = false;
    this.loadFailure = null;
    this.feedback = '';
    this.feedbackError = false;
    this.tools.clear();
    this.permissions.clear();
    this.tasks.clear();
  }
}
