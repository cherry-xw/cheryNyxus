import { PersistenceHandler } from "./persistenceHandler";

export class InMemoryPersistenceHandler extends PersistenceHandler {
  private state: string | null = null;

  /**
   * Stores a deep-copied state snapshot in process memory.
   *
   * @param state Serialized state payload.
   */
  async save(state: string): Promise<void> {
    this.state = structuredClone(state);
  }

  /**
   * Loads the most recently saved in-memory snapshot.
   *
   * @returns A copy of the current snapshot payload or `null`.
   */
  async load(): Promise<string | null> {
    return this.state ? structuredClone(this.state) : null;
  }

  /**
   * No-op for the in-memory backend.
   */
  async close(): Promise<void> {}

  async delete(): Promise<void> {
    this.state = null;
  }
}