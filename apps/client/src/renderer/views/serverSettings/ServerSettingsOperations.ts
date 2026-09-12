export interface ServerSettingsFailure {
  key: string;
  label: string;
  message: string;
}

export type ServerSettingsResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

interface OperationOptions {
  validate: (permission?: number) => void;
  changed: () => void;
  errorMessage: (error: unknown) => string;
}

/**
 * One queue for the entire modal, not one per tab. A queued edit already owns
 * the dismissal lock; only its actual acknowledgement releases that lock.
 */
export class ServerSettingsOperations {
  private tail: Promise<void> = Promise.resolve();
  private readonly pending = new Map<string, number>();
  private readonly errors = new Map<string, ServerSettingsFailure>();

  constructor(private readonly options: OperationOptions) {}

  public get pendingCount(): number {
    let count = 0;
    for (const value of this.pending.values()) count += value;
    return count;
  }

  public get failures(): readonly ServerSettingsFailure[] {
    return [...this.errors.values()];
  }

  public isPending(key: string): boolean {
    return this.pending.has(key);
  }

  public reportError(key: string, label: string, message: string): void {
    this.errors.set(key, { key, label, message });
    this.options.changed();
  }

  public clearError(key: string): void {
    if (this.errors.delete(key)) this.options.changed();
  }

  public run<T>(
    key: string,
    label: string,
    permission: number | undefined,
    apply: () => Promise<T>,
  ): Promise<ServerSettingsResult<T>> {
    this.pending.set(key, (this.pending.get(key) ?? 0) + 1);
    this.errors.delete(key);
    this.options.changed();

    const result = this.tail.then(async (): Promise<ServerSettingsResult<T>> => {
      // A retry queued behind a failed edit must clear that edit's error too.
      this.errors.delete(key);
      try {
        this.options.validate(permission);
        const value = await apply();
        return { ok: true, value };
      } catch (error) {
        const message = this.options.errorMessage(error);
        this.errors.set(key, { key, label, message });
        return { ok: false, message };
      } finally {
        const remaining = (this.pending.get(key) ?? 1) - 1;
        if (remaining) this.pending.set(key, remaining);
        else this.pending.delete(key);
        this.options.changed();
      }
    });
    this.tail = result.then(() => {});
    return result;
  }
}
