import { MAX_IDENTITY_BAN_DURATION_SECONDS, MessageType, identityBanSchema } from '@monky/shared';
import { getActiveNetworkClient } from '../core/NetworkClient';
import { getActiveServerStore } from '../stores/serverStore';
import { BoundRequests, SessionBinding } from '../core/sessionBinding';
import { t } from '../i18n';
import { html } from '../utils/html';
import { renderChoiceCards, renderSwitch, selectChoiceCard } from '../utils/formControls';
import { openModal } from '../utils/modalShell';
import { reportError, validateForm } from '../utils/feedback';
import { setButtonLoading } from '../utils/buttonLoading';
import { setSurfaceVisible } from '../utils/surfaceVisibility';
import { bindIdentityBanAccess, canBanIdentity } from '../utils/identityBan';
import { durationMinutes, isDurationUnit, renderDurationUnit } from './community/durationField';
import '../styles/identityBan.css';

export { openIdentityBansDialog } from './IdentityBansDialog';

export function openIdentityBanDialog(userId: string): void {
  const client = getActiveNetworkClient();
  const store = getActiveServerStore();
  const target = store.knownMembers.get(userId);
  if (!target || !canBanIdentity(store, userId)) {
    reportError(t('identity.banUnavailable'));
    return;
  }
  const binding = new SessionBinding(client, store, () => getActiveServerStore() === store);
  const requests = new BoundRequests(client);
  let permanent = true;
  let busy = false;
  const shell = openModal({
    closeWithSession: true, canClose: () => !busy, onClose: () => requests.cancel(),
    card: html`<div class="modal-card">
      <div class="modal-header"><h2 class="modal-title">${t('identity.banTitle', { name: target.nickname })}</h2>
        <button type="button" class="btn btn-icon" data-modal-close aria-label="${t('common.close')}">×</button></div>
      <p>${t('identity.banScope')}</p>
      <form class="identity-ban-form" data-ban-form novalidate>
        ${renderChoiceCards({ id: 'identity-ban-duration', label: t('identity.banDuration'), attribute: 'data-ban-duration',
          selected: 'permanent', choices: [
            { value: 'permanent', title: t('identity.banPermanent'), description: t('identity.banPermanentDescription') },
            { value: 'temporary', title: t('identity.banTemporary'), description: t('identity.banTemporaryDescription') },
          ] })}
        <div data-ban-time hidden class="form-row">
          <div class="form-group">
            <label for="identity-ban-duration-value">${t('identity.banDuration')}</label>
            <input type="number" class="input-field" id="identity-ban-duration-value" min="1"
              max="${MAX_IDENTITY_BAN_DURATION_SECONDS / 60}" step="1" value="60" disabled>
          </div>
          <div class="form-group">${renderDurationUnit('ban-unit', 'minutes')}</div>
        </div>
        <div class="form-group"><label for="identity-ban-reason">${t('identity.banReason')}</label>
          <textarea id="identity-ban-reason" required maxlength="1000" rows="3"></textarea></div>
        <div class="dialog-checkbox"><span id="identity-ban-show-label">${t('identity.banShowReason')}</span>
          ${renderSwitch({ id: 'identity-ban-show', labelledBy: 'identity-ban-show-label', checked: false })}</div>
        <div class="modal-footer"><button type="button" class="btn btn-secondary" data-modal-close>${t('common.cancel')}</button>
          <button type="submit" class="btn btn-danger" data-ban-submit>${t('identity.banAction')}</button></div>
      </form>
    </div>`,
    initialFocus: '#identity-ban-reason',
  });
  const current = bindIdentityBanAccess(shell, binding, store, userId);
  const form = shell.card.querySelector<HTMLFormElement>('[data-ban-form]')!;
  const duration = shell.card.querySelector<HTMLInputElement>('#identity-ban-duration-value')!;
  const unit = shell.card.querySelector<HTMLSelectElement>('[data-ban-unit]')!;
  unit.disabled = true;
  const reason = shell.card.querySelector<HTMLTextAreaElement>('#identity-ban-reason')!;
  const show = shell.card.querySelector<HTMLInputElement>('#identity-ban-show')!;
  const button = shell.card.querySelector<HTMLButtonElement>('[data-ban-submit]')!;
  form.addEventListener('click', event => {
    const choice = event.target instanceof Element ? event.target.closest('[data-ban-duration]') : null;
    if (!choice || busy) return;
    permanent = choice.getAttribute('data-ban-duration') === 'permanent';
    selectChoiceCard(form, 'data-ban-duration', permanent ? 'permanent' : 'temporary');
    duration.required = !permanent;
    duration.disabled = permanent;
    unit.required = !permanent;
    unit.disabled = permanent;
    setSurfaceVisible(form.querySelector<HTMLElement>('[data-ban-time]')!, !permanent, 'panel');
  }, { signal: shell.signal });
  unit.addEventListener('change', () => {
    if (!isDurationUnit(unit.value)) {
      reportError(t('identity.banInvalid'), { field: unit, focus: true });
      return;
    }
    duration.max = String(Math.floor(MAX_IDENTITY_BAN_DURATION_SECONDS / (durationMinutes('1', unit.value) * 60)));
  }, { signal: shell.signal });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (busy || !current()) return;
    if (!validateForm(form)) return;
    let durationSeconds: number | null = null;
    if (!permanent) {
      if (!isDurationUnit(unit.value)) {
        reportError(t('identity.banInvalid'), { field: unit, focus: true });
        return;
      }
      durationSeconds = durationMinutes(duration.value, unit.value) * 60;
    }
    const input = identityBanSchema.safeParse({ targetUserId: userId, reason: reason.value, showReason: show.checked,
      durationSeconds });
    if (!input.success) { reportError(t('identity.banInvalid'), { field: permanent ? reason : duration, focus: true }); return; }
    busy = true;
    setButtonLoading(button, true);
    void requests.send(id => client.sendRequest(MessageType.IDENTITY_BAN, input.data, id)).then(() => {
      busy = false;
      if (!shell.closed && current()) shell.close('api');
    }).catch(error => {
      busy = false;
      if (!shell.closed && current()) reportError(t('identity.banFailed'), { log: 'CONNECTION', error });
    }).finally(() => { if (!shell.closed) setButtonLoading(button, false); });
  }, { signal: shell.signal });
}
