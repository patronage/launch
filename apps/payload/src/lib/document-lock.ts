/**
 * Whether another editor has a document open, read from Payload's own lock
 * documents the way Payload reads them before it saves a collection
 * document. Payload's REST endpoint for a global does not make that check:
 * it saves over the lock and removes it. So `getEditingInfo` reports the
 * lock, and the MCP gateway leaves a locked global alone.
 */

/** Payload's own default for how long a lock holds after its last update. */
export const DEFAULT_LOCK_SECONDS = 300;

/** The part of a lock document the check reads. */
export interface StoredLock {
  /** When the editor's admin last renewed the lock. */
  updatedAt: string;
  /** The editor who holds it, as a relationship read at depth 0. */
  user?: { value?: unknown } | null;
}

export interface LockCheck {
  /** Now, in milliseconds. */
  now: number;
  /** How long a lock holds: `lockDocuments.duration`, in seconds. */
  seconds: number;
  /** The id of the editor asking. Their own lock does not stop them. */
  userId: number | string | undefined;
}

/**
 * True while the lock is another editor's and has not run out. A lock whose
 * time cannot be read is treated as held.
 */
export const heldByAnother = (lock: StoredLock, check: LockCheck): boolean => {
  if (check.userId !== undefined && lock.user?.value === check.userId) {
    return false;
  }

  const renewed = new Date(lock.updatedAt).getTime();

  return Number.isNaN(renewed) || check.now - renewed <= check.seconds * 1000;
};
