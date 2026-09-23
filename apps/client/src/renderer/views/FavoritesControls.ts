import { t } from '../i18n';
import { escapeHtml } from '../utils/html';
import '../styles/favoritesControls.css';

export function renderFavoriteToggle(key: string, name: string, favorite: boolean): string {
  const label = escapeHtml(t(favorite ? 'favorites.remove' : 'favorites.add', { name }));
  return `<button type="button" class="btn favorite-toggle" data-favorite-key="${escapeHtml(key)}"
    aria-pressed="${favorite}" aria-label="${label}" title="${label}">
    <span class="material-symbols-outlined md-18" aria-hidden="true">star</span>
  </button>`;
}

export function renderFavoritesFilter(prefix: string, favoritesOnly: boolean): string {
  return `<div class="favorites-filter" role="group" aria-label="${t('favorites.filterLabel')}">
    <button type="button" id="${prefix}-all" class="btn" data-favorites-filter="all"
      aria-pressed="${!favoritesOnly}" title="${t('favorites.showAll')}">${t('favorites.all')}</button>
    <button type="button" id="${prefix}-favorites" class="btn" data-favorites-filter="favorites"
      aria-pressed="${favoritesOnly}" title="${t('favorites.showFavorites')}">${t('favorites.only')}</button>
  </div>`;
}

export function updateFavoritesFilter(container: Element, favoritesOnly: boolean): void {
  container.querySelectorAll<HTMLButtonElement>('[data-favorites-filter]').forEach(button => {
    button.setAttribute('aria-pressed', String((button.dataset.favoritesFilter === 'favorites') === favoritesOnly));
  });
}
