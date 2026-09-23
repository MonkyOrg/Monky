import { botCapabilitySchema, type BotCapability } from '@monky/shared';
import { t } from '../i18n';
import { escapeHtml } from '../utils/html';

export function renderBotPermissionControls(
  requested: BotCapability[] | null, granted: BotCapability[], prefix: string, disabled = false,
): string {
  const capabilities = requested ?? [];
  const toggle = (id: string, label: string, checked: boolean, attribute: string, description?: string): string => `
    <div class="bot-permission-row">
      <div><label for="${id}">${escapeHtml(label)}</label>
        ${description ? `<p id="${id}-hint" class="bot-settings-description">${escapeHtml(description)}</p>` : ''}</div>
      <label class="toggle-switch"><input id="${id}" type="checkbox" role="switch" ${attribute}
        ${description ? `aria-describedby="${id}-hint"` : ''} ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
        <span class="toggle-slider"></span></label>
    </div>`;
  return `<section data-settings-section="bot-permissions" data-settings-label="${escapeHtml(t('botPermissions.title'))}">
    <p class="bot-settings-description">${t('botPermissions.description')}</p>
    <p class="bot-permission-consent">${t('botPermissions.localConsent')}</p>
    ${capabilities.length ? toggle(`${prefix}-all`, t('botPermissions.allowAll'),
      capabilities.every((capability) => granted.includes(capability)), 'data-bot-permissions-all') : ''}
    <div class="bot-permission-list">${capabilities.map((capability) => toggle(`${prefix}-${capability}`,
      t(`botPermissions.${capability}.title`), granted.includes(capability), `data-bot-capability="${capability}"`,
      t(`botPermissions.${capability}.description`))).join('')}</div>
    ${!capabilities.length ? `<p role="status">${t(requested === null ? 'botPermissions.undeclared' : 'botPermissions.none')}</p>` : ''}
    <p class="bot-settings-description">${t('botPermissions.listeningUnavailable')}</p>
  </section>`;
}

export function readBotPermissionChange(
  target: EventTarget | null, requested: BotCapability[] | null, granted: BotCapability[],
): BotCapability[] | undefined {
  if (!(target instanceof HTMLInputElement) || target.disabled || requested === null) return undefined;
  if (target.hasAttribute('data-bot-permissions-all')) return target.checked ? requested.slice() : [];
  const capability = botCapabilitySchema.safeParse(target.dataset.botCapability);
  if (!capability.success || !requested.includes(capability.data)) return undefined;
  return requested.filter((entry) => entry === capability.data ? target.checked : granted.includes(entry));
}

export function syncBotPermissionControls(root: HTMLElement, requested: BotCapability[], granted: BotCapability[]): void {
  for (const input of root.querySelectorAll<HTMLInputElement>('[data-bot-capability]')) {
    const parsed = botCapabilitySchema.safeParse(input.dataset.botCapability);
    input.checked = parsed.success && granted.includes(parsed.data);
  }
  const all = root.querySelector<HTMLInputElement>('[data-bot-permissions-all]');
  if (all) all.checked = requested.length > 0 && requested.every((capability) => granted.includes(capability));
}
