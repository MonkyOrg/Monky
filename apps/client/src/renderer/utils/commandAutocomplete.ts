import { LIMITS, commandAutocompleteResultSchema, type CommandAutocompleteChoice } from '@monky/shared';

export const AUTOCOMPLETE_MIN_QUERY = 2;
export const AUTOCOMPLETE_MAX_QUERY = 100;
export const AUTOCOMPLETE_VISIBLE_CHOICES = 10;

export interface AutocompleteInput {
  query: string;
  selected?: CommandAutocompleteChoice;
}
export type AutocompleteInputs = Record<string, AutocompleteInput>;
export interface AutocompleteState {
  status: 'idle' | 'loading' | 'ready' | 'empty' | 'failed';
  query: string;
  choices: CommandAutocompleteChoice[];
  error?: string;
}

interface QueryBudget { lastStartedAt: number }
const budgets = new WeakMap<object, QueryBudget>();

function normalizeAutocompleteChoices(response: unknown): CommandAutocompleteChoice[] | null {
  const parsed = commandAutocompleteResultSchema.safeParse(response);
  return parsed.success && parsed.data.status === 'ok' ? parsed.data.choices : null;
}

/** The budget belongs to the connection, not a menu that can be rebuilt. */
export class CommandAutocomplete {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private request: AbortController | null = null;
  private generation = 0;
  private query = '';
  private budget: QueryBudget;

  constructor(
    connection: object,
    private search: (query: string, signal: AbortSignal) => Promise<unknown>,
    private update: (state: AutocompleteState) => void
  ) {
    this.budget = budgets.get(connection) ?? { lastStartedAt: -Infinity };
    budgets.set(connection, this.budget);
  }

  public setQuery(query: string): void {
    if (query === this.query) return;
    this.close();
    this.query = query;
    const generation = this.generation;
    if (query.trim().length < AUTOCOMPLETE_MIN_QUERY) {
      this.update({ status: 'idle', query, choices: [] });
      return;
    }
    if (query.length > AUTOCOMPLETE_MAX_QUERY) {
      this.update({ status: 'failed', query, choices: [] });
      return;
    }
    this.update({ status: 'loading', query, choices: [] });
    const due = Date.now() + LIMITS.BOT_AUTOCOMPLETE_DEBOUNCE_MS;
    const schedule = () => {
      if (generation !== this.generation) return;
      const delay = Math.max(due, this.budget.lastStartedAt + LIMITS.BOT_AUTOCOMPLETE_THROTTLE_MS) - Date.now();
      this.timer = setTimeout(() => {
        this.timer = null;
        if (generation !== this.generation) return;
        if (Date.now() < this.budget.lastStartedAt + LIMITS.BOT_AUTOCOMPLETE_THROTTLE_MS) { schedule(); return; }
        this.budget.lastStartedAt = Date.now();
        const request = new AbortController();
        this.request = request;
        void this.search(query, request.signal).then((response) => {
          if (generation !== this.generation || request.signal.aborted) return;
          const choices = normalizeAutocompleteChoices(response);
          if (!choices) {
            this.update({ status: 'failed', query, choices: [] });
            return;
          }
          const visibleChoices = choices.slice(0, AUTOCOMPLETE_VISIBLE_CHOICES);
          this.update({ status: visibleChoices.length ? 'ready' : 'empty', query, choices: visibleChoices });
        }, (error: unknown) => {
          if (generation === this.generation && !request.signal.aborted) {
            this.update({ status: 'failed', query, choices: [], error: error instanceof Error ? error.message : undefined });
          }
        }).finally(() => { if (this.request === request) this.request = null; });
      }, Math.max(0, delay));
    };
    schedule();
  }

  public close(): void {
    this.generation++;
    this.query = '';
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.request?.abort();
    this.request = null;
  }
}
