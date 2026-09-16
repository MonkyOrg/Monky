import { LIMITS, commandAutocompleteResultSchema, type CommandAutocompleteChoice } from '@monky/shared';

export const AUTOCOMPLETE_MIN_QUERY = 2;
export const AUTOCOMPLETE_MAX_QUERY = LIMITS.MAX_BOT_AUTOCOMPLETE_QUERY_LENGTH;
// UI pacing leaves room above the server's hard window for delivery jitter.
export const AUTOCOMPLETE_REQUEST_INTERVAL_MS = 2 * LIMITS.BOT_AUTOCOMPLETE_THROTTLE_MS;
/** Dispatches transport before its first await; local preparation belongs to the factory. */
export type PreparedAutocompleteRequest = () => Promise<unknown>;

export interface AutocompleteInput {
  query: string;
  selected?: CommandAutocompleteChoice;
}
export type AutocompleteInputs = Record<string, AutocompleteInput>;
export interface AutocompleteState {
  status: 'idle' | 'preparing' | 'loading' | 'ready' | 'empty' | 'failed';
  query: string;
  choices: CommandAutocompleteChoice[];
  hasMore?: boolean;
  loadingMore?: boolean;
  loadMoreFailed?: boolean;
  error?: string;
}

interface QueryBudget { nextRequestAt: number; lastRequest: AbortSignal | null }
const budgets = new WeakMap<object, QueryBudget>();

function waitForBudget(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** The budget belongs to the connection, not a menu that can be rebuilt. */
export class CommandAutocomplete {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private request: AbortController | null = null;
  private generation = 0;
  private query = '';
  private readonly budget: QueryBudget;
  private choices: CommandAutocompleteChoice[] = [];
  private values = new Set<string>();
  private cursors = new Set<string>();
  private page = 0;
  private cursor: string | undefined;
  private hasMore = false;
  private pending = false;

  constructor(
    connection: object,
    private prepareSearch: (query: string, signal: AbortSignal, page: number, cursor?: string) => Promise<PreparedAutocompleteRequest>,
    private update: (state: AutocompleteState) => void
  ) {
    this.budget = budgets.get(connection) ?? { nextRequestAt: -Infinity, lastRequest: null };
    budgets.set(connection, this.budget);
  }

  public setQuery(query: string): void {
    if (query === this.query) return;
    this.close();
    this.query = query;
    if (query.trim().length < AUTOCOMPLETE_MIN_QUERY) {
      this.update({ status: 'idle', query, choices: [] });
      return;
    }
    if (query.length > AUTOCOMPLETE_MAX_QUERY) {
      this.update({ status: 'failed', query, choices: [] });
      return;
    }
    this.request = new AbortController();
    this.update({ status: 'loading', query, choices: [] });
    this.schedulePage(Date.now() + LIMITS.BOT_AUTOCOMPLETE_DEBOUNCE_MS);
  }

  public loadMore(): void {
    if (!this.request || !this.hasMore || this.pending) return;
    this.pending = true;
    this.update({
      status: this.choices.length ? 'ready' : 'empty', query: this.query,
      choices: this.choices, hasMore: true, loadingMore: true,
    });
    this.schedulePage(Date.now());
  }

  private schedulePage(due: number): void {
    const { generation, query, page, cursor, request } = this;
    if (!request) return;
    this.pending = true;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (generation === this.generation && !request.signal.aborted) {
        void this.run(query, generation, request.signal, page, cursor);
      }
    }, Math.max(0, due - Date.now()));
  }

  private async run(query: string, generation: number, signal: AbortSignal, page: number, cursor?: string): Promise<void> {
    const current = (): boolean => generation === this.generation && !signal.aborted;
    const failed = (error?: unknown) => {
      if (!current()) return;
      this.pending = false;
      this.update({
        status: page === 0 ? 'failed' : this.choices.length ? 'ready' : 'empty',
        query, choices: this.choices, hasMore: this.hasMore, loadMoreFailed: page > 0,
        error: error instanceof Error ? error.message : undefined,
      });
    };
    let dispatched = false;
    try {
      const send = await this.prepareSearch(query, signal, page, cursor);
      while (current() && Date.now() < this.budget.nextRequestAt) {
        await waitForBudget(this.budget.nextRequestAt - Date.now(), signal);
      }
      if (!current()) return;
      const pending = send();
      this.budget.nextRequestAt = Date.now() + AUTOCOMPLETE_REQUEST_INTERVAL_MS;
      this.budget.lastRequest = signal;
      dispatched = true;
      const response = await pending;
      if (!current()) return;
      const parsed = commandAutocompleteResultSchema.safeParse(response);
      if (!parsed.success || parsed.data.status !== 'ok') {
        failed();
        return;
      }
      const result = parsed.data;
      if ((result.hasMore && !Number.isSafeInteger(page + 1)) ||
        (result.nextCursor !== undefined && (result.nextCursor === cursor || this.cursors.has(result.nextCursor)))) {
        failed();
        return;
      }
      const added = result.choices.filter((choice) => {
        if (this.values.has(choice.value)) return false;
        this.values.add(choice.value);
        return true;
      });
      this.choices = this.choices.concat(added);
      if (cursor !== undefined) this.cursors.add(cursor);
      this.cursor = result.nextCursor;
      this.page = page + 1;
      this.hasMore = result.hasMore ?? false;
      this.pending = false;
      this.update({
        status: this.choices.length ? 'ready' : 'empty', query, choices: this.choices, hasMore: this.hasMore,
      });
    } catch (error) {
      failed(error);
    } finally {
      if (dispatched && this.budget.lastRequest === signal) {
        this.budget.nextRequestAt = Math.max(this.budget.nextRequestAt, Date.now() + LIMITS.BOT_AUTOCOMPLETE_THROTTLE_MS);
      }
    }
  }

  public close(): void {
    this.generation++;
    this.query = '';
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.request?.abort();
    this.request = null;
    this.choices = [];
    this.values.clear();
    this.cursors.clear();
    this.page = 0;
    this.cursor = undefined;
    this.hasMore = false;
    this.pending = false;
  }
}
