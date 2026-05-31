export abstract class PersistenceHandler {
  /**
   * Persists a serialized state payload.
   *
   * @param state Serialized state string to persist.
   */
  abstract save(state: string): Promise<void>;

  /**
   * Loads the latest serialized state payload.
   *
   * @returns The previously saved payload or `null` when no snapshot exists.
   */
  abstract load(): Promise<string | null>;

  /**
   * Releases any resources held by the persistence backend.
   */
  abstract close(): Promise<void>;

  /**
   * Deletes the persisted state, if supported by the persistence strategy.
   */
  abstract delete(): Promise<void>;
}