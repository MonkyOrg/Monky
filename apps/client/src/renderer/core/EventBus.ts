export type EventCallback<T = any> = (data: T) => void;

export class EventBus {
  private listeners: Map<string, Set<EventCallback>> = new Map();

  public on<T = any>(event: string, callback: EventCallback<T>): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);

    // Return unbind function
    return () => {
      this.off(event, callback);
    };
  }

  public off(event: string, callback: EventCallback): void {
    const set = this.listeners.get(event);
    if (set) {
      set.delete(callback);
      if (set.size === 0) {
        this.listeners.delete(event);
      }
    }
  }

  public emit<T = any>(event: string, data?: T): void {
    const set = this.listeners.get(event);
    if (set) {
      // Rebinding a view during dispatch must not replay the same event forever.
      for (const cb of [...set]) {
        if (!set.has(cb)) continue;
        try {
          cb(data);
        } catch (err) {
          console.error(`Error in event handler for "${event}":`, err);
        }
      }
    }
  }

  public clear(): void {
    this.listeners.clear();
  }
}

export const appEvents = new EventBus();
