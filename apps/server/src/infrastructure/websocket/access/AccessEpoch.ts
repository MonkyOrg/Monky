/**
 * Versions of who may access what, on this server (S-WS-5).
 *
 * Work that checked access and then awaited compares a version read before
 * with the one after, and gives up when access moved: a member who lost a
 * channel meanwhile is not answered as if they still had it.
 */
export class AccessEpoch {
  /** Moves before and after every change to channel access run through `change`. */
  private changes = 0;
  /** Changes to channel access still running: no version is handed out meanwhile. */
  private running = 0;
  /**
   * Moves with every reconciliation of role or channel access. What was granted
   * or checked under an older generation, such as a bot's voice grant or a
   * reader of bot settings, is checked again.
   */
  generation = 0;
  /** Moves whenever who may use a bot's miniapps may have changed. */
  miniapps = 0;

  /** The version of channel access; null while a change to it runs. */
  channels(): number | null {
    return this.running > 0 ? null : this.changes + this.generation;
  }

  /** Runs a change to channel access: no version is handed out until it ends, and the one after differs. */
  async change<T>(mutation: () => Promise<T>): Promise<T> {
    this.changes++;
    this.running++;
    try {
      return await mutation();
    } finally {
      this.running--;
      this.changes++;
    }
  }
}
