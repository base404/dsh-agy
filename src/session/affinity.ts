/**
 * Session affinity management.
 *
 * Reuses the last-used account for new requests within this window (proxy for
 * one DSH conversation, which exposes no id). After the window or on failure
 * the pool re-balances.
 */

export const SESSION_AFFINITY_WINDOW_MS = 10 * 60 * 1000

export class SessionAffinityTracker {
  /**
   * Per-conversation account affinity: the account one conversation is pinned
   * to, so its turns stay together (upstream prefix cache + `sessionId`
   * continuity) instead of re-ranking per request.
   */
  private readonly affinity = new Map<string, { key: string; at: number }>()

  /** Bound on tracked conversations; least-recently-pinned entries are evicted. */
  private static readonly MAX_AFFINITY_ENTRIES = 64

  /** Bucket for callers with no session identity (standalone CLI, one-shots). */
  private static readonly ANONYMOUS_CONVERSATION = '\u0000anonymous'

  /** The map key for a conversation; anonymous callers share one bucket. */
  private conversationKeyFor(conversationKey?: string): string {
    const trimmed = conversationKey?.trim()
    return trimmed && trimmed.length > 0 ? trimmed : SessionAffinityTracker.ANONYMOUS_CONVERSATION
  }

  /** Drop expired pins and keep the map bounded. */
  prune(now: number): void {
    for (const [conversation, pin] of this.affinity) {
      if (now - pin.at >= SESSION_AFFINITY_WINDOW_MS) this.affinity.delete(conversation)
    }
    while (this.affinity.size > SessionAffinityTracker.MAX_AFFINITY_ENTRIES) {
      const oldest = this.affinity.keys().next()
      if (oldest.done) break
      this.affinity.delete(oldest.value)
    }
  }

  /** The account key this conversation is pinned to, when the pin is still fresh. */
  affinityFor(conversationKey: string | undefined, now: number): string | null {
    const pin = this.affinity.get(this.conversationKeyFor(conversationKey))
    if (!pin || now - pin.at >= SESSION_AFFINITY_WINDOW_MS) return null
    return pin.key
  }

  /** Pin one conversation to one account. Re-inserts so eviction stays LRU. */
  setAffinity(conversationKey: string | undefined, accountKey: string, now: number): void {
    const conversation = this.conversationKeyFor(conversationKey)
    this.affinity.delete(conversation)
    this.affinity.set(conversation, { key: accountKey, at: now })
    this.prune(now)
  }

  /**
   * Drop every pin pointing at one account.
   *
   * A rotation or a skip means the account just proved unusable for the
   * conversation that was pinned to it; other conversations pinned elsewhere keep
   * their pins, which the single-slot version could not express.
   */
  clearAffinityForAccount(accountKey: string): void {
    for (const [conversation, pin] of this.affinity) {
      if (pin.key === accountKey) this.affinity.delete(conversation)
    }
  }

  /** Drop the affinity pin for one conversation. */
  clearAffinityForConversation(conversationKey?: string): void {
    const key = this.conversationKeyFor(conversationKey)
    this.affinity.delete(key)
  }

  /** Clear all session affinity pins. */
  clearAllAffinity(): void {
    this.affinity.clear()
  }
}
