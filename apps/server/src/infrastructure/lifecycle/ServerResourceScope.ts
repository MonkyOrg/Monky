export function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ServerResourceScope {
  private readonly entries: { name: string; release: () => void | Promise<void> }[] = [];
  private closing: Promise<void> | null = null;

  public defer(name: string, release: () => void | Promise<void>): void {
    this.entries.push({ name, release });
  }

  public close(): Promise<void> {
    if (this.closing) return this.closing;
    const operation = Promise.resolve().then(async () => {
      const failures: unknown[] = [];
      const messages: string[] = [];
      for (const entry of [...this.entries].reverse()) {
        try {
          await entry.release();
          this.entries.splice(this.entries.indexOf(entry), 1);
        } catch (error) {
          failures.push(error);
          messages.push(`${entry.name}: ${describeFailure(error)}`);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, `Server cleanup failed (${messages.join('; ')})`);
      }
    });
    this.closing = operation;
    const settled = () => { if (this.closing === operation) this.closing = null; };
    void operation.then(settled, settled);
    return operation;
  }

  public async fail(error: unknown): Promise<never> {
    try {
      await this.close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Server setup failed: ${describeFailure(error)}. ${describeFailure(cleanupError)}`,
        { cause: error },
      );
    }
    throw error;
  }
}
