import { MessageType, nativeLiveFormResultsSchema, type NativeLiveForm } from '@monky/shared';
import { getLanguage, t } from '../../i18n';
import { escapeHtml } from '../../utils/html';
import { renderBotFields } from '../botFields';
import { showInfoToast } from '../CopyToast';
import { assetUrl, type CommunityContext } from './communityContext';
import {
  answerGroups, answerLabel, answerShares, answeredResponses, resultsCsv, type FormResponse,
} from './nativeFormAnswers';

const QUESTION_PAGE_SIZE = 20;
/** Free-text answers shown at first, and added each time the list is scrolled to its end. */
const TEXT_ANSWERS_BATCH = 20;
const TAB_LABELS = {
  summary: 'liveForm.resultsSummary',
  question: 'liveForm.resultsQuestion',
  individual: 'liveForm.resultsIndividual',
} as const;

/** A form's responses: a summary per question, the answers to one question, or one response at a time. */
export function openNativeFormResults(ctx: CommunityContext, form: NativeLiveForm): void {
  const { feed } = ctx;
  const modal = ctx.modal(t('liveForm.resultsTitle', { title: form.form.title }));
  modal.card.classList.add('native-live-form-results-modal');
  let responses: FormResponse[] = [];
  let loading = false;
  let exporting = false;
  let tab: keyof typeof TAB_LABELS = 'summary';
  let questionIndex = 0;
  let responseIndex = 0;
  let questionPage = 0;
  let expandedAnswerGroup: number | null = null;
  const dateFormatter = new Intl.DateTimeFormat(getLanguage(), { dateStyle: 'short', timeStyle: 'short' });
  const textAnswer = (name: string, value: unknown) => escapeHtml(answerLabel(form, name, value));
  const aggregateField = (fieldIndex: number, includeTextAnswers = true): string => {
    const field = form.form.fields[fieldIndex];
    if (!field) return '';
    const answered = answeredResponses(responses, field);
    const stats = answerShares(responses, field);
    if (!stats && !includeTextAnswers) return '';
    const useDonut = answered.length > 0 && (field.type === 'boolean' || field.type === 'select');
    const body = stats && useDonut ? `<figure class="native-form-result-donut"
        aria-label="${escapeHtml(t('liveForm.chartLabel', { question: field.label }))}">
      <svg viewBox="0 0 42 42" aria-hidden="true">
        <circle class="native-form-result-donut-track" cx="21" cy="21" r="15.9"></circle>
        ${stats.reduce((result, item, index, list) => {
          const offset = list.slice(0, index).reduce((sum, entry) => sum + entry.share, 0);
          if (!item.share) return result;
          return `${result}<circle class="native-form-result-donut-segment chart-color-${index % 8}"
            cx="21" cy="21" r="15.9" pathLength="100"
            stroke-dasharray="${item.share} ${100 - item.share}"
            stroke-dashoffset="${-offset}"></circle>`;
        }, '')}
      </svg>
      <figcaption>${stats.map((item, index) => `<div>
        <i class="chart-color-${index % 8}" aria-hidden="true"></i>
        <span>${escapeHtml(item.label)}</span><strong>${item.count} (${item.percentage}%)</strong>
      </div>`).join('')}</figcaption>
    </figure>` : stats ? `<div class="native-form-result-bars">${stats.map((item, index) => `
      <div class="native-form-result-bar ${field.type === 'rating'
        ? `rating-color-${index + 1}` : `chart-color-${index % 8}`}">
        <div><span>${escapeHtml(item.label)}</span><strong>${item.count} (${item.percentage}%)</strong></div>
        <span aria-hidden="true"><i style="width:${item.share}%"></i></span>
      </div>`).join('')}</div>` : `<ul class="native-form-text-results" data-native-summary-text="${fieldIndex}"
      data-next-offset="${Math.min(TEXT_ANSWERS_BATCH, answered.length)}" tabindex="0"
      aria-label="${escapeHtml(field.label)}">${answered.slice(0, TEXT_ANSWERS_BATCH).map(entry =>
      `        <li><span>${textAnswer(field.name, entry.response.values[field.name])}</span>
        ${entry.user ? `<small>${escapeHtml(entry.user.nickname)}</small>` : ''}</li>`,
    ).join('')}${answered.length > TEXT_ANSWERS_BATCH ? `<li class="native-form-more-answers" data-native-summary-text-more>
      ${t('liveForm.moreTextAnswers', { count: answered.length - TEXT_ANSWERS_BATCH })}</li>` : ''}</ul>`;
    return `<article class="native-form-result-question">
      <header><h3>${escapeHtml(field.label)}</h3>
        <span>${t('liveForm.answerCount', { count: answered.length })}</span></header>
      ${body}
    </article>`;
  };
  const appendSummaryTextAnswers = (list: HTMLElement): void => {
    const field = form.form.fields[Number(list.dataset.nativeSummaryText)];
    const offset = Number(list.dataset.nextOffset ?? TEXT_ANSWERS_BATCH);
    if (!field || !Number.isInteger(offset)) return;
    const answered = answeredResponses(responses, field);
    list.querySelector('[data-native-summary-text-more]')?.remove();
    for (const entry of answered.slice(offset, offset + TEXT_ANSWERS_BATCH)) {
      const item = document.createElement('li');
      const answer = document.createElement('span');
      answer.textContent = answerLabel(form, field.name, entry.response.values[field.name]);
      item.append(answer);
      if (entry.user) {
        const respondent = document.createElement('small');
        respondent.textContent = entry.user.nickname;
        item.append(respondent);
      }
      list.append(item);
    }
    const nextOffset = Math.min(offset + TEXT_ANSWERS_BATCH, answered.length);
    list.dataset.nextOffset = String(nextOffset);
    if (nextOffset < answered.length) {
      const more = document.createElement('li');
      more.className = 'native-form-more-answers';
      more.dataset.nativeSummaryTextMore = '';
      more.textContent = t('liveForm.moreTextAnswers', { count: answered.length - nextOffset });
      list.append(more);
    }
  };
  const tabs = () => `<nav class="native-form-results-tabs" role="tablist" aria-label="${escapeHtml(t('liveForm.resultsTitle', { title: form.form.title }))}">
    ${(['summary', 'question', 'individual'] as const).map(value => `<button type="button" role="tab"
      aria-selected="${tab === value}" data-native-form-results-tab="${value}">${t(TAB_LABELS[value])}</button>`).join('')}
  </nav>`;
  const navigation = (kind: 'question' | 'response', index: number, total: number) =>
    `<div class="native-live-form-results-navigation">
      <button type="button" class="btn btn-secondary" data-native-form-${kind}-previous
        aria-label="${escapeHtml(t('common.previous'))}" ${index <= 0 ? 'disabled' : ''}>
        <span class="material-symbols-outlined">chevron_left</span></button>
      <span class="native-live-form-results-position">${t(kind === 'question'
        ? 'liveForm.questionPosition' : 'liveForm.responsePosition', { current: index + 1, total })}</span>
      <button type="button" class="btn btn-secondary" data-native-form-${kind}-next
        aria-label="${escapeHtml(t('common.next'))}" ${index >= total - 1 ? 'disabled' : ''}>
        <span class="material-symbols-outlined">chevron_right</span></button>
    </div>`;
  const responseLabel = (index: number): string => {
    const entry = responses[index];
    return entry?.user?.nickname ?? t('liveForm.anonymousResponse', { number: index + 1 });
  };
  const questionAnswers = (showFieldTitle: boolean): string => {
    const field = form.form.fields[questionIndex];
    if (!field) return '';
    const entries = answerGroups(form, responses, field);
    const pages = Math.max(1, Math.ceil(entries.length / QUESTION_PAGE_SIZE));
    questionPage = Math.min(questionPage, pages - 1);
    const offset = questionPage * QUESTION_PAGE_SIZE;
    const visible = entries.slice(offset, offset + QUESTION_PAGE_SIZE);
    return `<section class="native-form-question-answers">
      <header><h3>${showFieldTitle ? escapeHtml(field.label) : t('liveForm.answers')}</h3>
        <span>${t('liveForm.answerCount', { count: responses.length })}</span></header>
      <div class="native-form-question-answer-list">${visible.map((group, pageIndex) => {
        const groupIndex = offset + pageIndex;
        const duplicate = group.responseIndices.length > 1;
        return `<article class="native-form-question-answer">
          <button type="button" data-native-form-answer-group="${groupIndex}">
            <span>${escapeHtml(group.label)}</span>
            <strong>${group.responseIndices.length}</strong>
            <span class="material-symbols-outlined md-18">${duplicate ? 'expand_more' : 'arrow_forward'}</span>
          </button>
          ${duplicate && expandedAnswerGroup === groupIndex ? `<label>${t('liveForm.chooseResponse')}
            <select class="input-field" data-native-form-answer-target>
              <option value="">${t('liveForm.chooseResponse')}</option>
              ${group.responseIndices.map(index =>
                `<option value="${index}">${escapeHtml(responseLabel(index))}</option>`,
              ).join('')}
            </select></label>` : ''}
        </article>`;
      }).join('')}</div>
      ${pages > 1 ? `<footer class="native-form-question-pagination">
        <button type="button" class="btn btn-secondary" data-native-form-question-page-previous
          aria-label="${escapeHtml(t('common.previous'))}" ${questionPage === 0 ? 'disabled' : ''}>
          <span class="material-symbols-outlined">chevron_left</span></button>
        <span>${t('liveForm.pagePosition', { current: questionPage + 1, total: pages })}</span>
        <button type="button" class="btn btn-secondary" data-native-form-question-page-next
          aria-label="${escapeHtml(t('common.next'))}" ${questionPage >= pages - 1 ? 'disabled' : ''}>
          <span class="material-symbols-outlined">chevron_right</span></button>
      </footer>` : ''}
    </section>`;
  };
  const individual = (): string => {
    const entry = responses[responseIndex];
    if (!entry) return '';
    return `<div class="native-live-form-results-toolbar">
      ${entry.user ? `<div class="native-live-form-results-person">
        <img src="${escapeHtml(assetUrl(feed, entry.user.avatarUrl))}" alt="" data-fallback="avatar">
        <div><strong>${escapeHtml(entry.user.nickname)}</strong>
          <small>${'updatedAt' in entry.response ? dateFormatter.format(entry.response.updatedAt) : ''}</small></div>
      </div>` : `<div class="native-live-form-results-person native-live-form-results-person--anonymous">
        <span class="material-symbols-outlined">visibility_off</span>
        <div><strong>${escapeHtml(responseLabel(responseIndex))}</strong>
          <small>${t('liveForm.anonymousNotice')}</small></div>
      </div>`}
      ${navigation('response', responseIndex, responses.length)}
    </div>
    ${renderBotFields(form.form.fields, entry.response.values, {
      prefix: `native-form-result-${form.id}-${responseIndex}`,
      disabled: true,
      nativeForm: true,
      readOnly: true,
      persistentSelection: true,
      members: [...feed.server.knownMembers.values()],
    })}`;
  };
  const render = () => {
    if (loading) {
      modal.content.innerHTML = `<div class="community-empty"><span class="loading-spinner" aria-hidden="true"></span>
        <h2>${t('common.loading')}</h2></div>`;
      return;
    }
    if (!responses.length) {
      modal.content.innerHTML = `<div class="community-empty"><span class="material-symbols-outlined">inbox</span>
        <h2>${t('liveForm.noResponses')}</h2><p>${t('liveForm.noResponsesHint')}</p></div>`;
      return;
    }
    questionIndex = Math.min(questionIndex, form.form.fields.length - 1);
    responseIndex = Math.min(responseIndex, responses.length - 1);
    const body = tab === 'summary'
      ? `<div class="native-form-results-summary">${form.form.fields.map((_, index) => aggregateField(index)).join('')}</div>`
      : tab === 'question'
        ? (() => {
          const aggregate = aggregateField(questionIndex, false);
          return `<div class="native-form-results-question-view">
            <div class="native-live-form-results-toolbar">${navigation('question', questionIndex, form.form.fields.length)}</div>
            ${aggregate}${questionAnswers(!aggregate)}
          </div>`;
        })()
        : individual();
    modal.content.innerHTML = `<header class="native-form-results-header">
        <strong>${t('liveForm.responsesCount', { count: responses.length })}</strong>
        <button type="button" class="btn btn-secondary" data-native-form-export
          ${exporting ? 'disabled data-loading="1" aria-busy="true"' : ''}>
          <span class="material-symbols-outlined md-18">download</span>${t('liveForm.exportCsv')}</button>
      </header>
      ${tabs()}
      <section class="native-form-results-panel">${body}</section>`;
  };
  const load = () => {
    if (loading) return;
    loading = true;
    render();
    void modal.run(async () => {
      try {
        const all: FormResponse[] = [];
        let nextCursor: string | null = null;
        do {
          const result = nativeLiveFormResultsSchema.parse(await feed.client.sendRequest(
            MessageType.NATIVE_FORM_RESULTS,
            { id: form.id, ...(nextCursor ? { cursor: nextCursor } : {}), limit: 50 },
          ));
          all.push(...result.responses);
          nextCursor = result.nextCursor;
        } while (nextCursor && !modal.signal.aborted);
        responses = all;
      } finally {
        loading = false;
        if (!modal.signal.aborted) render();
      }
    });
  };
  const exportCsv = () => {
    if (exporting || !responses.length) return;
    exporting = true;
    render();
    void modal.run(async () => {
      try {
        const baseName = form.form.title.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim() || 'form';
        const result = await window.api.saveCsvFile(resultsCsv(form, responses), `${baseName}.csv`);
        if (result.success) showInfoToast(t('liveForm.exportCsvSuccess'));
        else if (result.error) throw new Error(result.error);
      } finally {
        exporting = false;
        if (!modal.signal.aborted) render();
      }
    });
  };
  modal.content.addEventListener('click', event => {
    if (!(event.target instanceof Element)) return;
    const tabButton = event.target.closest<HTMLElement>('[data-native-form-results-tab]');
    if (tabButton) {
      const next = tabButton.dataset.nativeFormResultsTab;
      if (next === 'summary' || next === 'question' || next === 'individual') { tab = next; render(); }
      return;
    }
    if (event.target.closest('[data-native-form-question-previous]') && questionIndex > 0) {
      questionIndex--; questionPage = 0; expandedAnswerGroup = null; render(); return;
    }
    if (event.target.closest('[data-native-form-question-next]') && questionIndex < form.form.fields.length - 1) {
      questionIndex++; questionPage = 0; expandedAnswerGroup = null; render(); return;
    }
    if (event.target.closest('[data-native-form-question-page-previous]') && questionPage > 0) {
      questionPage--; expandedAnswerGroup = null; render(); return;
    }
    if (event.target.closest('[data-native-form-question-page-next]')) {
      questionPage++; expandedAnswerGroup = null; render(); return;
    }
    if (event.target.closest('[data-native-form-response-previous]') && responseIndex > 0) {
      responseIndex--; render(); return;
    }
    if (event.target.closest('[data-native-form-response-next]') && responseIndex < responses.length - 1) {
      responseIndex++; render(); return;
    }
    const answerGroup = event.target.closest<HTMLElement>('[data-native-form-answer-group]');
    if (answerGroup) {
      const field = form.form.fields[questionIndex];
      if (!field) return;
      const groupIndex = Number(answerGroup.dataset.nativeFormAnswerGroup);
      const indices = answerGroups(form, responses, field)[groupIndex]?.responseIndices;
      if (!indices?.length) return;
      if (indices.length === 1) {
        responseIndex = indices[0];
        tab = 'individual';
      } else {
        expandedAnswerGroup = expandedAnswerGroup === groupIndex ? null : groupIndex;
      }
      render();
      return;
    }
    if (event.target.closest('[data-native-form-export]')) exportCsv();
  }, { signal: modal.signal });
  modal.content.addEventListener('change', event => {
    const select = event.target instanceof Element
      ? event.target.closest<HTMLSelectElement>('[data-native-form-answer-target]') : null;
    if (!select || select.value === '') return;
    const index = Number(select.value);
    if (!Number.isInteger(index) || index < 0 || index >= responses.length) return;
    responseIndex = index;
    tab = 'individual';
    expandedAnswerGroup = null;
    render();
  }, { signal: modal.signal });
  modal.content.addEventListener('scroll', event => {
    const list = event.target instanceof HTMLElement
      ? event.target.closest<HTMLElement>('[data-native-summary-text]') : null;
    if (!list || list.scrollTop + list.clientHeight < list.scrollHeight - 40 ||
        !list.querySelector('[data-native-summary-text-more]')) return;
    appendSummaryTextAnswers(list);
  }, { capture: true, signal: modal.signal });
  render();
  load();
}
