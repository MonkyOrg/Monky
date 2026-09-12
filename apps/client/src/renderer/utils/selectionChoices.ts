import { audioPreviewSourceSchema, type AudioPreviewSource, type SelectionChoice } from '@monky/shared';
import { t } from '../i18n';
import { getAvatarUrl } from './avatar';
import { escapeHtml } from './html';
import { getAudioPreviewVolume } from '../core/AudioPreviewService';
import { formatMediaTime } from './videoPlayer';

export type { AudioPreviewSource, SelectionChoice } from '@monky/shared';

export interface RenderableSelectionChoice extends SelectionChoice {
  avatarUrl?: string | null;
  count?: number;
}

export interface SelectionChoiceListOptions {
  choices: readonly RenderableSelectionChoice[];
  label: string;
  header: string;
  activeIndex?: number;
  selectedValue?: string;
  idPrefix: string;
  keyPrefix: string;
  volumeScope?: string;
  showVolume?: boolean;
  optionAttributes: (choice: RenderableSelectionChoice, index: number) => string;
}

export function commandPreviewVolumeScope(serverId: string | undefined, botId: string, commandName: string): string {
  return JSON.stringify(['command', serverId ?? '', botId, commandName]);
}

export function choiceAudio(choice: { audio?: unknown }): AudioPreviewSource | undefined {
  const parsed = audioPreviewSourceSchema.safeParse(choice.audio);
  return parsed.success ? parsed.data : undefined;
}

export function choicesHaveAudio(choices: readonly { audio?: unknown }[]): boolean {
  return choices.some((choice) => !!choiceAudio(choice));
}

export function audioDurationLabel(durationMs?: number): string {
  return durationMs === undefined ? '--:--' : formatMediaTime(durationMs / 1000);
}

export function renderAudioPreviewVolume(scope: string): string {
  const volume = getAudioPreviewVolume(scope);
  return `<div class="bot-preview-volume-control context-menu-volume-section" data-audio-preview-volume-control
    data-audio-volume-scope="${escapeHtml(scope)}">
    <div class="context-menu-volume-header">
      <span class="context-menu-volume-title"><span class="material-symbols-outlined md-18" aria-hidden="true">volume_up</span>${t('botChat.audioPreviewVolume')}</span>
      <output class="context-menu-volume-badge" data-audio-preview-percentage>${volume}%</output>
    </div>
    <div class="context-menu-slider-container">
      <input class="user-volume-slider" type="range" min="0" max="100" step="1" value="${volume}" data-audio-preview-volume
        aria-label="${escapeHtml(t('botChat.audioPreviewVolume'))}" aria-valuetext="${volume}%" style="--slider-fill: ${volume}%">
    </div>
  </div>`;
}

function renderAudioControls(choice: RenderableSelectionChoice, key: string, volumeScope: string): string {
  const audio = choiceAudio(choice);
  if (!audio) return '';
  const duration = audioDurationLabel(audio.durationMs);
  return `<div class="bot-choice-audio-controls" data-audio-choice-controls data-audio-key="${escapeHtml(key)}" data-audio-label="${escapeHtml(choice.label)}"
    data-audio-url="${escapeHtml(audio.url)}" ${audio.fileName ? `data-audio-file-name="${escapeHtml(audio.fileName)}"` : ''}
    data-audio-volume-scope="${escapeHtml(volumeScope)}" ${audio.durationMs ? `data-audio-duration-ms="${audio.durationMs}"` : ''}
    data-audio-preview-state="idle">
    <button type="button" class="bot-choice-audio-play" data-audio-preview-action="toggle"
      aria-label="${escapeHtml(`${t('botChat.audioPreviewPlay')}: ${choice.label}`)}" title="${escapeHtml(t('botChat.audioPreviewPlay'))}">
      <span class="material-symbols-outlined md-16" data-audio-preview-icon aria-hidden="true">play_arrow</span>
    </button>
    <div class="bot-choice-audio-timeline">
      <progress class="bot-choice-audio-progress" data-audio-preview-progress value="0" max="${audio.durationMs ? audio.durationMs / 1000 : 1}"
        aria-label="${escapeHtml(`${t('botChat.audioPreviewProgress')}: ${choice.label}`)}"></progress>
      <div class="bot-choice-audio-caption">
        <span class="bot-choice-audio-status" data-audio-preview-status role="status"></span>
        <span class="bot-choice-audio-time" data-audio-preview-time>00:00 / ${duration}</span>
      </div>
    </div>
  </div>`;
}

export function renderSelectionChoiceList(options: SelectionChoiceListOptions): string {
  const activeIndex = options.activeIndex ?? -1;
  const volumeScope = options.volumeScope ?? options.keyPrefix;
  return `<div class="bot-choice-panel" data-selection-choice-panel>
    <div class="bot-choice-panel-header"><span>${escapeHtml(options.header)}</span>
      ${options.showVolume !== false && choicesHaveAudio(options.choices) ? renderAudioPreviewVolume(volumeScope) : ''}
    </div>
    <div class="bot-choice-list" role="listbox" aria-label="${escapeHtml(options.label)}">
      ${options.choices.map((choice, index) => {
        const selected = options.selectedValue !== undefined ? choice.value === options.selectedValue : index === activeIndex;
        const audio = choiceAudio(choice);
        const key = JSON.stringify([options.keyPrefix, choice.value, audio?.url, audio?.fileName]);
        return `<div class="bot-parameter-option bot-selection-choice ${selected ? 'active' : ''} ${audio ? 'has-audio' : ''}"
          id="${escapeHtml(options.idPrefix)}-${index}" role="option" tabindex="${selected ? '0' : '-1'}" aria-selected="${selected}"
          data-selection-choice ${options.optionAttributes(choice, index)}>
          ${choice.avatarUrl ? `<img src="${escapeHtml(getAvatarUrl(choice.avatarUrl))}" alt="" data-fallback="avatar">` : ''}
          <span class="bot-choice-copy"><strong>${escapeHtml(choice.label)}</strong>${choice.description ? `<small>${escapeHtml(choice.description)}</small>` : ''}</span>
          ${choice.count !== undefined ? `<span class="bot-choice-count">${escapeHtml(String(choice.count))}</span>` : ''}
          ${renderAudioControls(choice, key, volumeScope)}
        </div>`;
      }).join('')}
    </div>
  </div>`;
}
