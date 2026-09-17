import { getCommandPresentation, localizeCommand, type BotLocale, type BotSettingsSummary, type SlashCommand } from '@monky/shared';
import { getLanguage, t } from '../i18n';
import { getAvatarUrl } from '../utils/avatar';
import { escapeHtml } from '../utils/html';
import type { CommandGroup } from '../utils/commandCatalog';

export function optionalParameterLabel(count: number): string {
  return t(count === 1 ? 'botChat.optionalCountOne' : 'botChat.optionalCountMany', { count });
}

export function renderCommandParameters(command: SlashCommand): string {
  const required = (command.options ?? []).filter((option) => option.required);
  const optional = (command.options ?? []).length - required.length;
  return `<span class="command-row-arguments">
    ${required.map((option) => `<span class="command-parameter-chip" title="${escapeHtml(option.description)}">${escapeHtml(option.label ?? option.name)}</span>`).join('')}
    ${optional ? `<span class="command-optional-count">${optionalParameterLabel(optional)}</span>` : ''}
  </span>`;
}

export function renderEmptyCommandCatalog(bots: readonly BotSettingsSummary[] | null, searching = false): string {
  if (searching) return `<p class="command-empty-frequency">${t('botChat.noMatchingCommands')}</p>`;
  if (bots === null) return `<p class="command-empty-frequency">${t('botChat.loadingCommands')}</p>`;
  const online = bots.filter(bot => bot.online);
  if (online.length === 0) return `<p class="command-empty-frequency">${t('botChat.noOnlineBots')}</p>`;
  return online.map(bot => {
    const permissions = bot.permissions;
    const reason = permissions?.requested === null ? 'botChat.commandsUndeclared'
      : permissions?.reviewRequired ? 'botChat.commandsReviewRequired'
        : permissions && !permissions.granted.includes('commands') ? 'botChat.commandsNotGranted'
          : 'botChat.commandsUnavailable';
    return `<section class="command-group">
      <h3>${escapeHtml(bot.name)}</h3>
      <p class="command-empty-frequency">${t(reason)}</p>
      ${bot.canManage ? `<button type="button" class="btn btn-secondary"
        data-command-bot-configure="${escapeHtml(bot.botId)}">${t('bots.configure')}</button>` : ''}
    </section>`;
  }).join('');
}

export function renderCommandCatalog(
  groups: CommandGroup[], activeIndex: number, deniedReason: (command: SlashCommand) => string | undefined = () => undefined,
  localeFor: (command: SlashCommand) => BotLocale = () => getLanguage(),
  emptyState?: string,
): string {
  if (groups.length === 0) {
    return `<div class="command-picker command-picker-empty">
      <div id="command-list-status" class="command-picker-scroll" role="status">
        ${emptyState || `<p class="command-empty-frequency">${t('botChat.noCommands')}</p>`}
      </div>
    </div>`;
  }
  let index = 0;
  let activeGroup = '';
  const sections = groups.map((group, groupIndex) => {
    const start = index;
    const rows = group.commands.map((original) => {
      const locale = localeFor(original);
      const command = localizeCommand(original, locale);
      const presentation = getCommandPresentation(original, locale);
      const rowIndex = index++;
      const denied = deniedReason(command);
      return `<div id="command-option-${rowIndex}" class="command-row ${rowIndex === activeIndex ? 'active' : ''}"
        role="option" aria-selected="${rowIndex === activeIndex}" ${denied ? 'aria-disabled="true"' : ''} data-cmd-index="${rowIndex}"
        data-bot-id="${escapeHtml(command.botId)}" data-command-name="${escapeHtml(command.name)}">
        <img class="command-row-avatar" src="${escapeHtml(getAvatarUrl(command.botAvatarUrl))}" alt="" data-fallback="avatar">
        <div class="command-row-copy">
          <div class="command-row-title"><strong>/${escapeHtml(presentation.displayName)}</strong>${renderCommandParameters(command)}</div>
          <div class="command-row-description">${escapeHtml(command.description)}</div>
          ${denied ? `<div class="bot-error command-voice-reason">${escapeHtml(denied)}</div>` : ''}
          ${command.downloadsSound ? `<div class="bot-local-download-cue">${t('botChat.localDownload')}</div>` : ''}
        </div>
        <span class="command-row-bot">${escapeHtml(command.botName)}</span>
      </div>`;
    }).join('');
    if (activeIndex >= start && activeIndex < index) activeGroup = group.id;
    return `<section class="command-group" role="group" aria-labelledby="command-group-${groupIndex}"
      data-command-section="${escapeHtml(group.id)}">
      <h3 id="command-group-${groupIndex}">${escapeHtml(group.kind === 'frequent' ? t('botChat.frequent') : group.botName ?? '')}</h3>
      ${rows || `<p class="command-empty-frequency">${t('botChat.noFrequent')}</p>`}
    </section>`;
  }).join('');
  return `<div class="command-picker">
    <nav class="command-bot-rail" aria-label="${t('botChat.commandGroups')}">
      ${groups.map((group) => `<button type="button" class="command-group-button ${group.id === activeGroup ? 'active' : ''}"
        data-command-group="${escapeHtml(group.id)}"
        title="${escapeHtml(group.kind === 'frequent' ? t('botChat.frequent') : group.botName ?? '')}"
        aria-label="${escapeHtml(group.kind === 'frequent' ? t('botChat.frequent') : group.botName ?? '')}">
        ${group.kind === 'frequent' ? '<span class="material-symbols-outlined md-22">history</span>' :
          `<img src="${escapeHtml(getAvatarUrl(group.botAvatarUrl))}" alt="" data-fallback="avatar">`}
      </button>`).join('')}
    </nav>
    <div id="command-list-options" class="command-picker-scroll" role="listbox" aria-label="${t('botChat.commands')}">
      ${sections}
    </div>
  </div>`;
}
