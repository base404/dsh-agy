/**
 * Quota cache ingestion, display window probing, burn rate sampling,
 * and false-cooldown lift logic.
 */

import type { AccountStorageV4, CachedQuota, ManagedAccount, OAuthAuthDetails, QuotaGroup } from '../types.ts'
import type { AccountStore } from '../store/accounts.ts'
import {
  isCoolingDown,
} from '../runtime/rotation.ts'
import {
  cachedQuotaReadings,
  ingestFamilyQuotas,
  isLimitsStale,
  isQuotaStale,
  areAllModelGroupsExhausted,
  computeAccountRecoveryTime,
  limitGroupReadings,
  quotaCooldownContradicted,
} from '../runtime/quota.ts'
import type { QuotaWindowReading } from '../runtime/quota.ts'
import { accountFetch } from '../proxy.ts'
import type { LimitsRefreshResult, QuotaRefreshResult } from './types.ts'

/** Bound for one quota poll so selection never stalls on a hung endpoint. */
export const QUOTA_FETCH_TIMEOUT_MS = 10_000

export interface QuotaManagerOptions {
  store: AccountStore
  accountKey: (account: ManagedAccount) => string
  accessTokenFor: (account: ManagedAccount) => Promise<OAuthAuthDetails | undefined>
  noteLimitSample: (key: string, groups: QuotaGroup[], at: number) => void
  pruneNonLiveBurnSamples: (live: Set<string>) => void
}

export class SessionQuotaManager {
  /** In-flight quota fetches keyed by account: concurrent selections share one fetchAvailableModels call. */
  private readonly quotaRefreshInFlight = new Map<string, Promise<QuotaRefreshResult | null>>()
  /** In-flight retrieveUserQuotaSummary probes keyed by account. */
  private readonly quotaSummaryInFlight = new Map<string, Promise<QuotaGroup[]>>()

  constructor(private readonly options: QuotaManagerOptions) {}

  /**
   * Probe `retrieveUserQuotaSummary` for one account, sharing ONE in-flight
   * promise with every other caller in this cycle.
   *
   * Returns `[]` on any failure — the fetch itself already answers a dead
   * endpoint with an empty list — so both consumers read "no groups" the same
   * way. The promise is dropped as soon as it settles, so the NEXT cycle
   * re-probes.
   *
   * The account's proxy is honoured here or the call would egress direct and
   * leak the account's real IP, and one timeout bounds the whole endpoint
   * fallback chain.
   */
  probeQuotaSummary(account: ManagedAccount): Promise<QuotaGroup[]> {
    const key = this.options.accountKey(account)
    const existing = this.quotaSummaryInFlight.get(key)
    if (existing) return existing
    const probe = (async (): Promise<QuotaGroup[]> => {
      try {
        const auth = await this.options.accessTokenFor(account)
        if (!auth) return []
        const { fetchQuotaSummary } = await import('../adapter/quota-summary.ts')
        const routed = accountFetch({ proxyUrl: account.proxy })
        const bounded = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
          const timeout = AbortSignal.timeout(QUOTA_FETCH_TIMEOUT_MS)
          const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout
          return routed(input, { ...init, signal })
        }
        return await fetchQuotaSummary(auth.access, account.projectId, bounded)
      } catch {
        // Best-effort: an empty result is the caller's "unknown", never a throw.
        return []
      }
    })()
    this.quotaSummaryInFlight.set(key, probe)
    const release = (): void => {
      // Only drop the promise we created, so a slow settle cannot remove a later
      // cycle's probe.
      if (this.quotaSummaryInFlight.get(key) === probe) this.quotaSummaryInFlight.delete(key)
    }
    void probe.then(release, release)
    return probe
  }

  /**
   * A `quota-exhausted` cooldown is one 429's belief; both probe paths pass
   * newer evidence here. A successful probe that completed after the park was
   * set and measures NO spent window proves the park was a false positive — a
   * burst 429 whose body merely said "quota" parks a healthy account for up to
   * a day — so clear it in place.
   *
   * @returns whether the park was lifted, so the caller can mirror the clear
   *   into the same store write that persists the measurement.
   */
  liftContradictedQuotaPark(
    target: ManagedAccount,
    readings: ReadonlyArray<QuotaWindowReading>,
    measuredAt: number,
  ): boolean {
    if (!quotaCooldownContradicted(target, readings, measuredAt)) return false
    target.coolingDownUntil = undefined
    target.cooldownReason = undefined
    target.cooldownSetAt = undefined
    return true
  }

  /**
   * Refresh the display-only 5h/weekly windows for every enabled account.
   *
   * SEPARATE from `refreshQuotaCache`, and deliberately so. That method writes
   * `cachedQuota`, which feeds the scheduling path: `rankPoolCandidates` turns a
   * measured `remainingFraction <= 0` into a `blockedUntil`, so measuring a
   * pool's quota can BLOCK an account. That is safe only with a fallback, which
   * is why `getSession` gates it on `eligible.length > 1` — and that gate is also
   * why a solo account never had `cachedLimits` populated and the limits card
   * showed "not measured yet" forever.
   */
  async refreshLimits(
    storage: AccountStorageV4,
    options: { force?: boolean; indices?: number[] } = {},
  ): Promise<LimitsRefreshResult> {
    const now = Date.now()
    const candidates = storage.accounts
      .map((account, index) => ({ account, index }))
      .filter(({ account, index }) => account.enabled !== false
        && (options.indices === undefined || options.indices.includes(index)))
    const targets = options.force === true
      ? candidates
      : candidates.filter(({ account }) => isLimitsStale(account, now))
    if (targets.length === 0) {
      return { measured: [], failed: [], skipped: candidates.length }
    }

    const probes = await Promise.all(targets.map(async ({ account }) => {
      const key = this.options.accountKey(account)
      try {
        const groups = await this.probeQuotaSummary(account)
        if (groups.length === 0) return { key, ok: false as const }
        return { key, ok: true as const, groups, updatedAt: Date.now() }
      } catch {
        return { key, ok: false as const }
      }
    }))

    const updates = probes.filter((probe): probe is
      { key: string, ok: true, groups: QuotaGroup[], updatedAt: number } => probe.ok)
    const failed = probes.filter((probe) => !probe.ok).map((probe) => probe.key)
    const result: LimitsRefreshResult = {
      measured: updates.map((update) => update.key),
      failed,
      skipped: candidates.length - targets.length,
    }
    if (updates.length === 0) return result
    const liftedKeys = new Set<string>()
    for (const update of updates) {
      const target = storage.accounts.find((candidate) => this.options.accountKey(candidate) === update.key)
      if (target) {
        target.cachedLimits = { groups: update.groups, updatedAt: update.updatedAt }
        this.options.noteLimitSample(update.key, update.groups, update.updatedAt)
        if (this.liftContradictedQuotaPark(target, limitGroupReadings(update.groups), update.updatedAt)) {
          liftedKeys.add(update.key)
        } else if (areAllModelGroupsExhausted(target, undefined, update.updatedAt) && !((target.manuallyRecoveredAt ?? 0) >= update.updatedAt)) {
          const recovery = computeAccountRecoveryTime(target, update.updatedAt)
          if (recovery !== null && recovery > update.updatedAt) {
            target.coolingDownUntil = recovery
            target.cooldownReason = 'quota-exhausted'
            target.cooldownSetAt = update.updatedAt
          }
        }
      }
    }

    const live = new Set(storage.accounts.map((account) => this.options.accountKey(account)))
    this.options.pruneNonLiveBurnSamples(live)
    try {
      await this.options.store.mutate((s) => {
        for (const update of updates) {
          const target = s.accounts.find((candidate) => this.options.accountKey(candidate) === update.key)
          if (target) {
            target.cachedLimits = { groups: update.groups, updatedAt: update.updatedAt }
            if (liftedKeys.has(update.key)) {
              target.coolingDownUntil = undefined
              target.cooldownReason = undefined
              target.cooldownSetAt = undefined
            } else if (areAllModelGroupsExhausted(target, undefined, update.updatedAt) && !((target.manuallyRecoveredAt ?? 0) >= update.updatedAt)) {
              const recovery = computeAccountRecoveryTime(target, update.updatedAt)
              if (recovery !== null && recovery > update.updatedAt) {
                target.coolingDownUntil = recovery
                target.cooldownReason = 'quota-exhausted'
                target.cooldownSetAt = update.updatedAt
              }
            }
          }
        }
        for (const acc of s.accounts) {
          const key = this.options.accountKey(acc)
          if (liftedKeys.has(key)) {
            acc.coolingDownUntil = undefined
            acc.cooldownReason = undefined
            acc.cooldownSetAt = undefined
          }
        }
            })
    } catch {
      // A derived display cache; a failed write degrades gracefully.
    }
    return result
  }

  /**
   * Refresh stale per-account quota caches (family-scoped, health-based TTL).
   * Failures leave the account unmeasured: ranking treats it as a fallback
   * instead of blocking selection on a hung endpoint.
   */
  async refreshQuotaCache(storage: AccountStorageV4): Promise<void> {
    const now = Date.now()
    const stale = storage.accounts.filter((account) => account.enabled !== false && isQuotaStale(account, now))
    if (stale.length === 0) return

    const results = await Promise.all(stale.map(async (account) => {
      const key = this.options.accountKey(account)
      if (this.quotaRefreshInFlight.has(key)) return this.quotaRefreshInFlight.get(key)
      const refresh = (async () => {
        try {
          const auth = await this.options.accessTokenFor(account)
          if (!auth) return null
          const { fetchAvailableModels } = await import('../adapter/models.ts')
          const routed = accountFetch({ proxyUrl: account.proxy })
          const bounded: typeof fetch = (input, init) => {
            const timeout = AbortSignal.timeout(QUOTA_FETCH_TIMEOUT_MS)
            const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout
            return routed(input, { ...init, signal })
          }
          const [discovered, groups] = await Promise.all([
            fetchAvailableModels(auth.access, account.projectId, bounded),
            this.probeQuotaSummary(account),
          ])
          const quotas = ingestFamilyQuotas(discovered, groups, account.cachedQuota)
          const models = Object.keys(discovered.models ?? {})
          return { key, quotas, models, updatedAt: Date.now() }
        } catch {
          return null
        }
      })()
      this.quotaRefreshInFlight.set(key, refresh)
      try {
        return await refresh
      } finally {
        this.quotaRefreshInFlight.delete(key)
      }
    }))

    const updates = results.filter((r): r is { key: string; quotas: Record<string, CachedQuota>; models: string[]; updatedAt: number } => Boolean(r && Object.keys(r.quotas).length > 0))
    if (updates.length > 0) {
      const liftedKeys = new Set<string>()
      for (const update of updates) {
        const target = storage.accounts.find((candidate) => this.options.accountKey(candidate) === update.key)
        if (target) {
          target.cachedQuota = update.quotas
          target.cachedQuotaUpdatedAt = update.updatedAt
          if (update.models.length > 0) target.cachedModels = update.models
          if (this.liftContradictedQuotaPark(target, cachedQuotaReadings(update.quotas), update.updatedAt)) {
            liftedKeys.add(update.key)
          }
        }
      }
      try {
        await this.options.store.mutate((s) => {
          for (const update of updates) {
            const target = s.accounts.find((candidate) => this.options.accountKey(candidate) === update.key)
            if (target) {
              target.cachedQuota = update.quotas
              target.cachedQuotaUpdatedAt = update.updatedAt
              if (update.models.length > 0) target.cachedModels = update.models
              if (liftedKeys.has(update.key)) {
                target.coolingDownUntil = undefined
                target.cooldownReason = undefined
                target.cooldownSetAt = undefined
              }
            }
          }
        })
      } catch {
        // Quota is a derived cache — a failed write degrades gracefully.
      }
    }
  }
}
