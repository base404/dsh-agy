/**
 * Limit burn rate calculation and tracking.
 *
 * Upstream reports windows as a remaining FRACTION with no capacity, so the
 * only honest way to a "how long until this runs dry" figure is the fraction's
 * own rate of change: keep the previous snapshot, and the next one yields
 * fraction-per-hour.
 */

import type { ManagedAccount, QuotaGroup } from '../types.ts'
import type { LimitSample } from './types.ts'

/** Two samples closer than this are noise (a forced refresh seconds apart). */
export const MIN_BURN_SAMPLE_MS = 5 * 60 * 1000

/**
 * Fraction-per-hour per window bucket, from two snapshots.
 *
 * Pure and exported for a direct unit test. Rules:
 * - the FIRST sample yields nothing (no baseline yet), and so does a pair
 *   closer than `MIN_BURN_SAMPLE_MS` — two probes seconds apart measure the
 *   probe jitter, not the burn;
 * - a RISING fraction is a reset (or refresh noise), never negative burn;
 * - a bucket with no baseline simply has no rate yet.
 *
 * Returns null when no bucket produced a rate, so the caller can keep the
 * previous rates instead of overwriting them with an empty read.
 */
export function sampleLimitBurn(prev: LimitSample | undefined, next: LimitSample): Record<string, number> | null {
  if (prev === undefined) return null
  const elapsedH = (next.at - prev.at) / 3_600_000
  if (elapsedH < MIN_BURN_SAMPLE_MS / 3_600_000) return null
  const perHour: Record<string, number> = {}
  for (const [bucketId, fraction] of Object.entries(next.fractions)) {
    const before = prev.fractions[bucketId]
    if (before !== undefined && before > fraction) {
      perHour[bucketId] = (before - fraction) / elapsedH
    }
  }
  return Object.keys(perHour).length > 0 ? perHour : null
}

export class LimitBurnTracker {
  /** Last fraction snapshot per account, for `sampleLimitBurn` (memory only). */
  private readonly limitFractions = new Map<string, LimitSample>()
  /** Latest burn rate per account: bucketId -> fraction/hour (memory only). */
  private readonly limitBurn = new Map<string, { perHour: Record<string, number> }>()

  noteLimitSample(key: string, groups: QuotaGroup[], at: number): void {
    const fractions: Record<string, number> = {}
    for (const group of groups) {
      for (const window of group.windows) {
        if (window.remainingFraction !== null) fractions[window.bucketId] = window.remainingFraction
      }
    }
    const next: LimitSample = { at, fractions }
    const burn = sampleLimitBurn(this.limitFractions.get(key), next)
    // A null result keeps the previous rate: "no drop since the last sample"
    // is not evidence the burn stopped, just that these two samples saw none.
    if (burn !== null) this.limitBurn.set(key, { perHour: burn })
    this.limitFractions.set(key, next)
  }

  /**
   * Drop samples for accounts that no longer exist, so the maps stay bounded
   * by the live pool rather than by every account ever seen.
   */
  pruneNonLive(live: ReadonlySet<string>): void {
    for (const key of this.limitFractions.keys()) {
      if (!live.has(key)) this.limitFractions.delete(key)
    }
    for (const key of this.limitBurn.keys()) {
      if (!live.has(key)) this.limitBurn.delete(key)
    }
  }

  /**
   * Burn rates per account INDEX, for the `account.limits` reply.
   */
  limitBurnRates(
    accounts: readonly ManagedAccount[],
    accountKeyFn: (account: ManagedAccount) => string,
  ): Array<{ index: number; perHour: Record<string, number> }> {
    const out: Array<{ index: number; perHour: Record<string, number> }> = []
    for (const [index, account] of accounts.entries()) {
      const entry = this.limitBurn.get(accountKeyFn(account))
      if (entry !== undefined) out.push({ index, perHour: entry.perHour })
    }
    return out
  }
}
