import type {
  LocalBotIdentity, LocalCapabilityId, LocalExecutionFailure, LocalPreparationDialogState, LocalToolId,
} from '@monky/shared';
import { escapeHtml } from '../../renderer/utils/html';
import { getMainLanguage, mt, type MainTranslationKey } from '../i18n';
import type { LocalToolPreparationInfo } from './LocalTools';

export const LOCAL_TOOL_NAMES: Record<LocalToolId, string> = { node: 'Node.js', 'yt-dlp': 'yt-dlp', ffmpeg: 'FFmpeg' };
export type PreparationDialogMode = 'consent' | 'enable';
export type LocalMaintenanceRequest =
  | { mode: 'remove'; tool: LocalToolId; affectedTasks: number }
  | { mode: 'cache'; affectedTasks: number };

const purposes: Record<LocalToolId, MainTranslationKey> = {
  node: 'localExecution.toolNodePurpose',
  'yt-dlp': 'localExecution.toolYtdlpPurpose',
  ffmpeg: 'localExecution.toolFfmpegPurpose',
};
const stages = {
  resolving: 'localExecution.stageResolving',
  downloading: 'localExecution.stageDownloading',
  verifying: 'localExecution.stageVerifying',
  extracting: 'localExecution.stageExtracting',
  checking: 'localExecution.stageChecking',
} as const;

export function formatLocalToolBytes(bytes: number, ceiling = false): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = bytes > 0 ? Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024))) : 0;
  const scaled = bytes / 1024 ** index;
  const value = ceiling ? Math.ceil(scaled * 10) / 10 : scaled;
  return `${new Intl.NumberFormat(getMainLanguage(), { maximumFractionDigits: 1 }).format(value)} ${units[index]}`;
}

function failureText(reason: LocalExecutionFailure): string {
  switch (reason) {
    case 'storage_failed': return mt('localExecution.installStorageFailed');
    case 'integrity_failed': return mt('localExecution.installIntegrityFailed');
    case 'provider_unavailable': return mt('localExecution.installDownloadFailed');
    case 'unsupported_platform': return mt('localExecution.installUnsupported');
    case 'timeout': return mt('localExecution.installTimeout');
    case 'permission_revoked': return mt('localExecution.installRevoked');
    default: return mt('localExecution.installFailedHint');
  }
}

export function preparationDialogState(
  phase: LocalPreparationDialogState['phase'], inventory: LocalToolPreparationInfo, failure?: LocalExecutionFailure,
): LocalPreparationDialogState {
  const additional = inventory.tools.reduce((sum, tool) => sum + tool.maximumAdditionalBytes, 0);
  const installed = inventory.tools.reduce((sum, tool) => sum + tool.info.sizeBytes, 0);
  const active = phase === 'installing' ? inventory.tools.find((tool) => tool.info.progress)?.info : undefined;
  const progress = active?.progress;
  const titles = {
    consent: 'localExecution.dialogTitle',
    installing: 'localExecution.installingTitle',
    cancelling: 'localExecution.cancellingTitle',
    failed: 'localExecution.installFailedTitle',
    complete: 'localExecution.installCompleteTitle',
  } as const;
  let status = mt('localExecution.checkingTools');
  let detail = mt('localExecution.installingHint');
  if (phase === 'consent') {
    status = mt('localExecution.toolsTitle');
    detail = mt('localExecution.toolsHint');
  } else if (phase === 'cancelling') {
    status = mt('localExecution.cancellingTitle');
    detail = mt('localExecution.cancellingHint');
  } else if (phase === 'failed') {
    status = mt('localExecution.installFailedTitle');
    detail = failureText(failure ?? 'tool_install_failed');
  } else if (phase === 'complete') {
    status = mt('localExecution.installCompleteTitle');
    detail = mt('localExecution.installCompleteHint');
  } else if (active && progress) {
    status = mt(stages[progress.stage], { tool: LOCAL_TOOL_NAMES[active.id] });
    if (progress.stage === 'downloading' && progress.totalBytes !== null) {
      detail = mt('localExecution.downloadBytes', {
        received: formatLocalToolBytes(progress.downloadedBytes), total: formatLocalToolBytes(progress.totalBytes),
      });
    }
  }
  return {
    phase, title: mt(titles[phase]), status, detail,
    storage: additional > 0
      ? mt('localExecution.storageMaximum', { size: formatLocalToolBytes(additional, true) })
      : mt('localExecution.storageInstalled', { size: formatLocalToolBytes(installed) }),
    progress: progress?.stage === 'downloading' && progress.totalBytes !== null && progress.totalBytes > 0
      ? Math.min(100, Math.max(0, progress.downloadedBytes / progress.totalBytes * 100)) : null,
    tools: inventory.tools.map(({ info, maximumAdditionalBytes }) => ({
      id: info.id,
      ready: info.status === 'ready',
      active: phase === 'installing' && info.id === active?.id,
      status: info.status === 'ready' ? mt('localExecution.toolInstalled')
        : info.status === 'invalid' ? mt('localExecution.toolInvalid')
          : info.status === 'failed' ? mt('localExecution.toolFailed')
          : info.progress && phase === 'installing' ? mt(stages[info.progress.stage], { tool: LOCAL_TOOL_NAMES[info.id] })
            : info.status === 'installing' ? mt('localExecution.toolSharedPreparation') : mt('localExecution.toolToInstall'),
      size: info.status === 'ready'
        ? [info.version, formatLocalToolBytes(info.sizeBytes)].filter(Boolean).join(' \u00b7 ')
        : mt('localExecution.upTo', { size: formatLocalToolBytes(maximumAdditionalBytes, true) }),
    })),
  };
}

export function preparationDialogHtml(options: {
  bot: LocalBotIdentity; capability: LocalCapabilityId; mode: PreparationDialogMode;
  inventory: LocalToolPreparationInfo; icon: string; font: string;
}): string {
  const { bot, inventory, mode } = options;
  const state = preparationDialogState('consent', inventory);
  const capabilities: Record<LocalCapabilityId, string> = { 'youtube-audio': mt('localExecution.youtubeAudio') };
  const row = (id: LocalToolId): string => {
    const tool = state.tools.find((tool) => tool.id === id);
    if (!tool) throw new Error('Missing preparation tool disclosure');
    return `<article class="tool" data-tool="${id}">
      <span class="tool-icon" aria-hidden="true">${id === 'node' ? 'JS' : id === 'yt-dlp' ? '&#8595;' : '&#9835;'}</span>
      <div class="tool-copy"><strong>${LOCAL_TOOL_NAMES[id]}</strong><p>${escapeHtml(mt(purposes[id]))}</p></div>
      <div class="tool-meta"><span data-tool-status>${escapeHtml(tool.status)}</span><small data-tool-size>${escapeHtml(tool.size)}</small></div>
    </article>`;
  };
  const content = `<h1 id="title" tabindex="-1">${escapeHtml(state.title)}</h1>
    <p class="requester"><strong>${escapeHtml(bot.botName)}</strong> &middot; ${escapeHtml(bot.serverName)}</p>
    <p id="capability" class="capability">${escapeHtml(capabilities[options.capability])}</p>
    <strong class="section-title">${escapeHtml(mt('localExecution.toolsTitle'))}</strong>
    <p class="hint">${escapeHtml(mt('localExecution.toolsHint'))}</p>
    <div class="tools">${inventory.tools.map(({ info }) => row(info.id)).join('')}</div>
    <div class="storage"><strong id="storage">${escapeHtml(state.storage)}</strong>
      <p>${escapeHtml(mt('localExecution.storageExplanation', { cache: formatLocalToolBytes(inventory.maximumCacheBytes) }))}</p></div>
    <p class="limits">${escapeHtml(mt('localExecution.permissionLimits'))}</p>
    <details><summary>${escapeHtml(mt('localExecution.securityDetails'))}</summary><dl>
      <dt>${escapeHtml(mt('localExecution.origin'))}</dt><dd>${escapeHtml(bot.serverOrigin)}</dd>
      <dt>${escapeHtml(mt('localExecution.botInstallation'))}</dt><dd>${escapeHtml(bot.botId)}</dd>
      <dt>${escapeHtml(mt('localExecution.publicKeySuffix'))}</dt><dd>${escapeHtml(bot.botPublicKey.slice(-12))}</dd>
    </dl></details>`;
  return localToolDialogHtml({
    ...options, content, windowTitle: mt('localExecution.permissionTitle'),
    confirmLabel: mt(mode === 'enable' ? 'localExecution.allowAlways' : 'localExecution.allowAndPrepare'),
  });
}

export function maintenanceDialogState(
  request: LocalMaintenanceRequest, phase: LocalPreparationDialogState['phase'], failure?: LocalExecutionFailure,
): LocalPreparationDialogState {
  const title = mt(phase === 'failed' ? 'localExecution.maintenanceFailedTitle'
    : phase === 'installing' || phase === 'cancelling' ? 'localExecution.maintenanceWorking'
      : phase === 'complete' ? 'localExecution.maintenanceComplete'
        : request.mode === 'remove' ? 'localExecution.removeTitle' : 'localExecution.clearCacheTitle');
  return {
    phase, title, status: title, progress: null, tools: [], storage: '',
    detail: phase === 'failed' ? failureText(failure ?? 'storage_failed')
      : phase === 'consent' ? '' : mt('localExecution.maintenanceWorkingHint'),
  };
}

export function maintenanceDialogHtml(request: LocalMaintenanceRequest, assets: { icon: string; font: string }): string {
  const state = maintenanceDialogState(request, 'consent');
  const message = request.mode === 'remove' ? mt('localExecution.removeMessage', { tool: LOCAL_TOOL_NAMES[request.tool] })
    : mt('localExecution.clearCacheMessage');
  const detail = mt(request.mode === 'remove' ? 'localExecution.removeDetail' : 'localExecution.clearCacheDetail',
    { count: String(request.affectedTasks) });
  return localToolDialogHtml({
    ...assets, mode: request.mode, windowTitle: state.title,
    confirmLabel: mt(request.mode === 'remove' ? 'localExecution.remove' : 'localExecution.clearCache'),
    content: `<h1 id="title" tabindex="-1">${escapeHtml(state.title)}</h1>
      <p id="capability" class="capability">${escapeHtml(message)}</p>
      <p class="maintenance-detail">${escapeHtml(detail)}</p>`,
  });
}

function localToolDialogHtml(options: {
  mode: PreparationDialogMode | LocalMaintenanceRequest['mode'];
  content: string; windowTitle: string; confirmLabel: string; icon: string; font: string;
}): string {
  const { mode } = options;
  return `<!doctype html><html lang="${getMainLanguage()}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'">
<title>${escapeHtml(options.windowTitle)}</title>
<style>
@font-face { font-family: Inter; src: url('${options.font}') format('woff2'); font-weight: 400; font-display: swap; }
:root { color-scheme: dark; --bg: #161b22; --card: #1c232d; --border: #262c36; --accent: #5865f2; --text: #f0f3f6; --muted: #9da7b3; }
* { box-sizing: border-box; } [hidden] { display: none !important; }
body { margin: 0; height: 100vh; overflow: hidden; color: var(--text); background: var(--bg); font-family: Inter, 'Segoe UI', sans-serif; font-size: 13px; line-height: 1.5; }
button { font: inherit; cursor: pointer; } button:disabled { cursor: default; opacity: .55; }
button:focus-visible, summary:focus-visible { outline: 2px solid #9ca5ff; outline-offset: 3px; }
.dialog { height: 100%; display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
.brand { display: flex; align-items: center; gap: 9px; padding: 12px 20px; background: #11151c; border-bottom: 1px solid var(--border); -webkit-app-region: drag; }
.brand img { width: 26px; height: 26px; } .brand strong { font-size: 14px; } .brand span { font-size: 11px; color: var(--muted); }
.close { margin-left: auto; background: transparent; border: 0; color: var(--muted); width: 30px; height: 30px; border-radius: 6px; font-size: 22px; -webkit-app-region: no-drag; }
.close:hover { color: var(--text); background: var(--card); }
.content { flex: 1; min-height: 0; overflow-y: auto; padding: 22px 26px 16px; }
.content::-webkit-scrollbar { width: 6px; height: 6px; }
.content::-webkit-scrollbar-track { background: transparent; }
.content::-webkit-scrollbar-thumb { background: #2f3846; border-radius: 9999px; }
.content::-webkit-scrollbar-thumb:hover { background: #656d76; }
h1 { margin: 0 0 8px; font-size: 21px; line-height: 1.3; } p { margin: 0; }
#title:focus { outline: none; }
.requester { color: var(--muted); overflow-wrap: anywhere; } .requester strong { color: var(--text); }
.capability { margin: 16px 0; padding: 11px 13px; background: rgba(88,101,242,.1); border: 1px solid rgba(88,101,242,.28); border-radius: 8px; font-size: 12px; }
.section-title { display: block; margin-bottom: 3px; font-size: 13px; } .hint { color: var(--muted); font-size: 11px; }
.tools { margin: 12px 0; display: grid; gap: 8px; }
.tool { display: flex; align-items: center; gap: 11px; padding: 12px; background: var(--card); border: 1px solid var(--border); border-radius: 8px; }
.tool-icon { display: grid; place-items: center; flex-shrink: 0; width: 32px; height: 34px; color: #b1b8ff; background: #292e4b; border-radius: 7px; font-size: 16px; font-weight: 700; }
.tool-copy { flex: 1; min-width: 0; } .tool-copy strong { font-size: 13px; } .tool-copy p { margin-top: 2px; color: var(--muted); font-size: 11px; line-height: 1.4; }
.tool-meta { text-align: right; flex-shrink: 0; max-width: 170px; font-size: 10px; } .tool-meta small { display: block; color: var(--muted); margin-top: 4px; font-size: 11px; }
.tool[data-ready="true"] [data-tool-status] { color: #62d994; } .tool[data-active="true"] { border-color: var(--accent); }
.storage { padding: 10px 12px; background: #11151c; border: 1px solid var(--border); border-radius: 8px; }
.storage strong { display: block; font-size: 12px; } .storage p { margin-top: 4px; color: var(--muted); font-size: 10px; }
.limits { margin-top: 12px; color: var(--muted); font-size: 11px; }
.maintenance-detail { white-space: pre-line; color: var(--muted); font-size: 12px; }
details { margin-top: 12px; font-size: 11px; color: var(--muted); } summary { cursor: pointer; width: fit-content; }
dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin-bottom: 0; } dt { color: var(--muted); } dd { margin: 0; overflow-wrap: anywhere; color: var(--text); }
.choices { margin-bottom: 12px; } .choice-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 8px; }
.choice { border: 1px solid var(--border); border-radius: 8px; padding: 11px 12px; background: var(--card); text-align: left; color: var(--text); }
.choice strong { display: block; font-size: 11px; } .choice small { display: block; color: var(--muted); margin-top: 4px; font-size: 10px; line-height: 1.4; }
.choice[aria-checked="true"] { border-color: var(--accent); background: rgba(88,101,242,.12); box-shadow: inset 0 0 0 1px var(--accent); }
.progress-section { margin-bottom: 12px; padding: 14px; background: #11151c; border: 1px solid var(--border); border-radius: 8px; }
.status-line { display: flex; align-items: center; gap: 10px; } #status { font-weight: 600; font-size: 12px; } #detail { color: var(--muted); margin: 8px 0 0 26px; font-size: 11px; }
.spinner { width: 16px; height: 16px; flex-shrink: 0; border: 2px solid #353e65; border-top-color: #9aa4ff; border-radius: 50%; animation: spin .8s linear infinite; }
.progress { height: 7px; margin-top: 13px; background: #262c36; overflow: hidden; border-radius: 99px; } .progress-fill { height: 100%; width: 0; border-radius: inherit; background: var(--accent); transition: width .15s linear; }
.progress.indeterminate .progress-fill { width: 35%; animation: slide 1.2s ease-in-out infinite; }
body[data-phase="failed"] .progress-section { border-color: #9a3c42; } body[data-phase="failed"] #status { color: #ff8589; }
body[data-phase="complete"] #status { color: #62d994; }
.footer { padding: 15px 26px; border-top: 1px solid var(--border); background: #11151c; }
.footer-actions { display: flex; justify-content: flex-end; gap: 10px; }
.button { border-radius: 7px; padding: 10px 16px; border: 1px solid var(--border); font-weight: 600; font-size: 12px; background: var(--card); color: var(--text); }
.button:hover:not(:disabled) { background: #242c38; } .primary { background: var(--accent); border-color: var(--accent); } .primary:hover:not(:disabled) { background: #4752c4; }
@keyframes spin { to { transform: rotate(360deg); } } @keyframes slide { from { transform: translateX(-120%); } to { transform: translateX(400%); } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
@media (max-width: 600px) { .content { padding: 18px; } .tool-meta { max-width: 125px; } .choice-grid { grid-template-columns: 1fr; } }
</style></head>
<body data-phase="consent" data-mode="${mode}" data-ipc-error="${escapeHtml(mt('localExecution.dialogCommunicationFailed'))}">
<section class="dialog" role="dialog" aria-modal="true" aria-labelledby="title" aria-describedby="capability">
  <header class="brand"><img src="${options.icon}" alt=""><strong>Monky</strong><span>${escapeHtml(options.windowTitle)}</span>
    <button class="close" id="close" type="button" aria-label="${escapeHtml(mt('localExecution.cancel'))}">&#215;</button></header>
  <main class="content">
    ${options.content}
  </main>
  <footer class="footer">
    <section class="choices" id="choices"${mode !== 'consent' ? ' hidden' : ''}>
      <strong class="section-title" id="duration-label">${escapeHtml(mt('localExecution.permissionDuration'))}</strong>
      <div class="choice-grid" role="radiogroup" aria-labelledby="duration-label">
        <button type="button" class="choice" id="connection-choice" role="radio" aria-checked="true" tabindex="0">
          <strong>${escapeHtml(mt('localExecution.allowConnection'))}</strong><small>${escapeHtml(mt('localExecution.connectionHint'))}</small></button>
        <button type="button" class="choice" id="always-choice" role="radio" aria-checked="false" tabindex="-1">
          <strong>${escapeHtml(mt('localExecution.allowAlways'))}</strong><small>${escapeHtml(mt('localExecution.alwaysHint'))}</small></button>
      </div>
    </section>
    <section id="progress-section" class="progress-section" hidden>
      <div class="status-line"><span class="spinner" id="spinner" aria-hidden="true"></span><p id="status" role="status" aria-live="polite"></p></div>
      <p id="detail"></p><div id="progress" class="progress indeterminate" role="progressbar" aria-labelledby="status" aria-describedby="detail" aria-valuemin="0" aria-valuemax="100"><div class="progress-fill" id="progress-fill"></div></div>
    </section>
    <div class="footer-actions">
    <button type="button" class="button" id="deny" disabled>${escapeHtml(mt(mode === 'consent' ? 'localExecution.deny' : 'localExecution.cancel'))}</button>
    <button type="button" class="button primary" id="allow" disabled>${escapeHtml(options.confirmLabel)}</button>
    <button type="button" class="button" id="cancel" hidden>${escapeHtml(mt('localExecution.cancel'))}</button>
    <button type="button" class="button" id="dismiss" hidden>${escapeHtml(mt('localExecution.close'))}</button>
    <button type="button" class="button primary" id="retry" hidden>${escapeHtml(mt('localExecution.retry'))}</button>
    </div>
  </footer>
</section></body></html>`;
}
