import { t } from '../i18n';
import { escapeHtml } from './html';

/** The yellow BRB tag shown next to a name while that person is "Volto já" (user-brb). */
export function renderBrbTag(user: { brb?: boolean; invisible?: boolean } | undefined): string {
  if (!user?.brb || user.invisible) return '';
  return `<span class="presence-brb-tag" title="${escapeHtml(t('main.statusBrb'))}">${escapeHtml(t('main.brbTag'))}</span>`;
}
