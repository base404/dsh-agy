/**
 * In-flight upstream request tracking per account.
 *
 * Spreads concurrent fan-out across the pool instead of stacking every stream
 * on one account.
 */

import { IN_FLIGHT_STALE_MS } from '../runtime/rotation.ts'
import type { ManagedAccount } from '../types.ts'

export class InFlightTracker {
  /**
   * In-flight upstream requests per account, so selection can spread concurrent
   * fan-out across the pool instead of stacking every stream on one account.
   */
  private readonly inFlight = new Map<string, { count: number; at: number }>()

  /** In-flight count for one account, discarding a leaked entry past its TTL. */
  inFlightCount(accountKey: string, now: number): number {
    const entry = this.inFlight.get(accountKey)
    if (entry === undefined) return 0
    if (now - entry.at > IN_FLIGHT_STALE_MS) {
      this.inFlight.delete(accountKey)
      return 0
    }
    return entry.count
  }

  /** Record that one upstream request for this account has started. */
  noteRequestStarted(accountKey: string, now: number): void {
    this.inFlight.set(accountKey, { count: this.inFlightCount(accountKey, now) + 1, at: now })
  }

  /** Record that one upstream request for this account has settled, on any path. */
  noteRequestSettled(accountKey: string, now: number): void {
    const count = this.inFlightCount(accountKey, now)
    if (count <= 1) this.inFlight.delete(accountKey)
    else this.inFlight.set(accountKey, { count: count - 1, at: now })
  }

  /**
   * Which accounts have upstream requests in flight, for the UI's live line.
   */
  inFlightAccounts(
    accounts: readonly ManagedAccount[],
    accountKeyFn: (account: ManagedAccount) => string,
    now: number,
  ): Array<{ index: number; email: string | null; count: number }> {
    const busy: Array<{ index: number; email: string | null; count: number }> = []
    for (const [index, account] of accounts.entries()) {
      const count = this.inFlightCount(accountKeyFn(account), now)
      if (count > 0) busy.push({ index, email: account.email ?? null, count })
    }
    return busy
  }
}
