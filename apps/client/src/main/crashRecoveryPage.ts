import fs from 'fs';
import { createRequire } from 'module';
import { formatCrashDiagnostic, type CrashDiagnostic } from './crashDiagnostics';
import { getMainLanguage, mt } from './i18n';

export const CRASH_RECOVERY_COLORS = {
  background: '#0b0e14',
  titlebar: '#11151c',
  controls: '#9da7b3',
} as const;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] ?? character);
}

function recoveryFontStyles(): string {
  const resolve = createRequire(__filename).resolve;
  const fonts = [
    ...[400, 500, 600, 700].map(weight => ({ family: 'Inter', package: 'inter', weight })),
    { family: 'JetBrains Mono', package: 'jetbrains-mono', weight: 400 },
  ];
  try {
    // Embed the installed fonts, independently of Vite's bundle and asset URLs.
    return fonts.map(font => {
      const file = resolve(`@fontsource/${font.package}/files/${font.package}-latin-${font.weight}-normal.woff2`);
      const data = fs.readFileSync(file).toString('base64');
      return `@font-face { font-family: '${font.family}'; font-style: normal; font-weight: ${font.weight}; font-display: swap; src: url(data:font/woff2;base64,${data}) format('woff2'); }`;
    }).join('\n');
  } catch (error: unknown) {
    console.warn('[CrashRecovery] Could not load bundled fonts; using system fonts', error);
    return '';
  }
}

function icon(shapes: string, className = 'icon'): string {
  return `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${shapes}</svg>`;
}

// Mirror the app's theme.css without requiring its renderer, stylesheet or icons.
export function buildCrashRecoveryPage(diagnostic: CrashDiagnostic): string {
  const text = (key: Parameters<typeof mt>[0]): string => escapeHtml(mt(key));
  return `<!doctype html>
<html lang="${getMainLanguage()}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'">
  <title>Monky — ${text('crash.nativeTitle')}</title>
  <style>
    ${recoveryFontStyles()}
    :root {
      color-scheme: dark;
      --bg-app: ${CRASH_RECOVERY_COLORS.background};
      --bg-sidebar: ${CRASH_RECOVERY_COLORS.titlebar};
      --bg-panel: #161b22;
      --bg-card: #1c232d;
      --bg-card-hover: #242c38;
      --bg-input: #0d1117;
      --accent-primary: #5865f2;
      --accent-hover: #4752c4;
      --text-primary: #f0f3f6;
      --text-secondary: ${CRASH_RECOVERY_COLORS.controls};
      --text-muted: #656d76;
      --border-color: #262c36;
      --radius-md: 8px;
      --radius-lg: 12px;
      --font-main: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      --font-mono: 'JetBrains Mono', monospace;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background: var(--bg-app);
      color: var(--text-primary);
      font: 14px/1.5 var(--font-main);
      -webkit-font-smoothing: antialiased;
      user-select: none;
    }
    .titlebar {
      height: 32px;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      padding: 0 152px 0 12px;
      background: var(--bg-sidebar);
      border-bottom: 1px solid var(--border-color);
      -webkit-app-region: drag;
    }
    .titlebar--mac { padding: 0 12px 0 78px; }
    .titlebar__title { font-size: 12px; font-weight: 600; color: var(--text-secondary); }
    .recovery-content {
      flex: 1;
      min-height: 0;
      display: grid;
      place-items: center;
      overflow: hidden;
      padding: 24px;
    }
    main {
      width: 100%;
      max-width: 560px;
      max-height: 100%;
      min-height: 0;
      display: flex;
      flex-direction: column;
      gap: 18px;
      overflow-y: auto;
      padding: 24px;
      background: var(--bg-panel);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-lg);
      box-shadow: 0 16px 48px #0005;
    }
    main > * { flex-shrink: 0; }
    .recovery-heading { display: flex; align-items: flex-start; gap: 18px; }
    .mascot { width: 64px; height: 64px; flex-shrink: 0; color: var(--text-muted); }
    h1 { font-size: 18px; font-weight: 700; line-height: 1.4; }
    h1:focus { outline: none; }
    .description { color: var(--text-secondary); margin-top: 8px; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 9px 16px;
      border: 1px solid transparent;
      border-radius: var(--radius-md);
      font: inherit;
      font-weight: 500;
      white-space: nowrap;
      cursor: pointer;
      transition: background-color .15s ease, transform .05s ease;
    }
    .btn:active { transform: scale(.98); }
    .btn-primary { background: var(--accent-primary); color: #fff; }
    .btn-primary:hover { background: var(--accent-hover); }
    .btn-secondary { background: var(--bg-card); border-color: var(--border-color); color: var(--text-primary); }
    .btn-secondary:hover { background: var(--bg-card-hover); }
    .btn:disabled { opacity: .6; cursor: wait; }
    button:focus-visible, summary:focus-visible, pre:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 3px; }
    .icon { width: 18px; height: 18px; flex-shrink: 0; }
    .privacy { font-size: 12px; line-height: 1.6; color: var(--text-secondary); border-top: 1px solid var(--border-color); padding-top: 18px; }
    details { background: var(--bg-input); border: 1px solid var(--border-color); border-radius: var(--radius-md); }
    summary { display: flex; align-items: center; gap: 8px; padding: 12px; font-size: 13px; color: var(--text-secondary); cursor: pointer; list-style: none; }
    summary::-webkit-details-marker { display: none; }
    summary:hover { color: var(--text-primary); }
    .details-arrow { width: 16px; height: 16px; flex-shrink: 0; margin-left: auto; }
    details[open] .details-arrow { transform: rotate(180deg); }
    .diagnostic-content { padding: 0 12px 12px; }
    pre { max-height: 180px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; padding: 12px 0; border-top: 1px solid var(--border-color); font: 12px/1.6 var(--font-mono); color: var(--text-secondary); user-select: text; }
    #recovery-copy { margin-top: 8px; font-size: 12px; padding: 7px 12px; }
    #recovery-status { min-height: 18px; font-size: 12px; color: var(--text-secondary); }
    ::-webkit-scrollbar { width: 8px; height: 8px; }
    ::-webkit-scrollbar-thumb { background: var(--bg-card-hover); border: 2px solid var(--bg-panel); border-radius: 8px; }
    @media (max-width: 520px) {
      .recovery-content { padding: 16px; }
      main { padding: 20px; }
      .recovery-heading { flex-direction: column; gap: 16px; }
      .mascot { width: 56px; height: 56px; }
      .actions .btn { flex: 1 1 100%; }
    }
    @media (prefers-reduced-motion: reduce) { .btn { transition: none; } .btn:active { transform: none; } }
  </style>
</head>
<body>
  <header class="titlebar${process.platform === 'darwin' ? ' titlebar--mac' : ''}" aria-hidden="true">
    <span class="titlebar__title">Monky</span>
  </header>
  <div class="recovery-content">
  <main aria-labelledby="recovery-title">
    <header class="recovery-heading">
      <svg class="mascot" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
        <path d="M12 25a8 8 0 1 0 0 15m40-15a8 8 0 1 1 0 15" />
        <path d="M12 30c0-10 6-18 16-20l4-5 1 6c11 0 19 8 19 19v8c0 12-8 20-20 20S12 50 12 38Z" />
        <path d="M32 27c-3-7-13-8-14 1-1 5 1 8 5 11-3 2-5 4-5 7 0 6 6 9 14 9s14-3 14-9c0-3-2-5-5-7 4-3 6-6 5-11-1-9-11-8-14-1Z" />
        <circle cx="25" cy="32" r="1.5" fill="currentColor" stroke="none" />
        <circle cx="39" cy="32" r="1.5" fill="currentColor" stroke="none" />
        <path d="M30 39h4m-7 8q5-4 10 0" />
      </svg>
      <div>
        <h1 id="recovery-title" tabindex="-1">${text('crash.title')}</h1>
        <p class="description">${text('crash.description')}</p>
      </div>
    </header>
    <div class="actions">
      <button type="button" id="recovery-report" class="btn btn-primary">
        ${icon('<path d="M8 8h8v8a4 4 0 0 1-8 0V8Zm1 0V6a3 3 0 0 1 6 0v2M4 9h4m8 0h4M3 14h5m8 0h5M4 19h5m6 0h5" />')}
        <span>${text('crash.report')}</span>
      </button>
      <button type="button" id="recovery-reopen" class="btn btn-secondary">
        ${icon('<path d="M4 11a8 8 0 1 1 2 7M4 5v6h6" />')}
        <span>${text('crash.reopen')}</span>
      </button>
      <button type="button" id="recovery-close" class="btn btn-secondary">${text('crash.close')}</button>
    </div>
    <p class="privacy">${text('crash.privacy')}</p>
    <details>
      <summary>
        ${icon('<rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3m6 0h4" />')}
        <span>${text('crash.details')}</span>
        ${icon('<path d="m6 9 6 6 6-6" />', 'details-arrow')}
      </summary>
      <div class="diagnostic-content">
        <pre id="recovery-diagnostic" tabindex="0">${escapeHtml(formatCrashDiagnostic(diagnostic))}</pre>
        <button type="button" id="recovery-copy" class="btn btn-secondary">
          ${icon('<rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4" />')}
          <span>${text('crash.copy')}</span>
        </button>
      </div>
    </details>
    <p id="recovery-status" role="status" aria-live="polite" aria-atomic="true"
      data-wait="${text('crash.wait')}"
      data-opened="${text('crash.reportOpened')}"
      data-opened-no-copy="${text('crash.reportOpenedNoCopy')}"
      data-report-failed="${text('crash.reportFailed')}"
      data-failed="${text('crash.actionFailed')}"
      data-copied="${text('crash.copied')}"
      data-restart-failed="${text('crash.restartFailed')}"></p>
  </main>
  </div>
</body>
</html>`;
}
