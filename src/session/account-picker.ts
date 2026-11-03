/**
 * Account selection, ranking fallback, conversation affinity checks,
 * and skip/unusable handling.
 */

import { AgyAuthError, AgyPoolBlockedError } from '../types.ts'
import type { AccountStorageV4, ManagedAccount } from '../types.ts'
import type { AccountStore } from '../store/accounts.ts'
import {
  FULL_QUOTA_COOLDOWN_MS,
  MAX_IN_FLIGHT_PER_ACCOUNT,
  clearExpiredState,
  isCoolingDown,
  isFamilyRateLimited,
  pickNextAccountIndex,
} from '../runtime/rotation.ts'
import {
  areAllModelGroupsExhausted,
  computeAccountRecoveryTime,
  familyKeyOf,
  familyQuotaFor,
  isFamilyQuotaExhausted,
  modelFamilyOf,
  rankPoolCandidates,
} from '../runtime/quota.ts'
import type { SessionAffinityTracker } from './affinity.ts'
import type { InFlightTracker } from './in-flight.ts'
import { isModelSupportedByAccount } from './account-support.ts'

export interface AccountPickerDeps {
  affinity: SessionAffinityTracker
  inFlight: InFlightTracker
  store: AccountStore
  accountKey: (account: ManagedAccount) => string
  autoRotate?: () => boolean
}

/**
 * The single message for a pool that has accounts but none can serve the
 * request — an all-disabled pool and a model no enabled account carries are
 * different facts, and BOTH used to surface as the misleading "run `dsh-agy
 * login`" hint (the user's accounts were valid the whole time).
 * `invalid-credential` is deliberate: retrying cannot heal either state within
 * the turn, and the adapter maps that kind to a terminal LlmError that shows
 * the message verbatim without touching pool state.
 */
export function throwNoEligible(storage: AccountStorageV4, model?: string): never {
  if (storage.accounts.length === 0) {
    // Callers gate on `.length === 0` themselves before calling; this branch
    // is defensive and must never be the misleading hint.
    throw new AgyAuthError('invalid-credential', 'No agy account is configured.')
  }
  const disabledCount = storage.accounts.filter((account) => account.enabled === false).length
  if (disabledCount === storage.accounts.length) {
    throw new AgyAuthError('invalid-credential', `All ${disabledCount} agy account(s) are disabled — verify or re-login.`)
  }
  if (model !== undefined) {
    throw new AgyAuthError('invalid-credential', `Model "${model}" is not available on any enabled agy account — switch account or pick another model.`)
  }
  throw new AgyAuthError('invalid-credential', 'No enabled agy account can serve this request.')
}

/**
 * Drop the session pin and move the pool cursor off an account that just
 * failed, so the next `pickAccount` in this same request tries another one.
 * State on the account itself is deliberately left untouched (no cooldown).
 */
export async function skipAccount(
  storage: AccountStorageV4,
  account: ManagedAccount,
  deps: Pick<AccountPickerDeps, 'affinity' | 'store' | 'accountKey'>,
): Promise<AccountStorageV4> {
  const key = deps.accountKey(account)
  deps.affinity.clearAffinityForAccount(key)
  const deadIndex = storage.accounts.findIndex((candidate) => deps.accountKey(candidate) === key)
  if (deadIndex !== -1) {
    const next = pickNextAccountIndex(storage.accounts, deadIndex, Date.now())
    if (next !== storage.activeIndex) {
      storage.activeIndex = next
      await deps.store.mutate((s) => { s.activeIndex = next }).catch(() => {})
    }
  }
  return deps.store.load()
}

/**
 * Pick the account for one request: the affinity pin wins while it is fresh,
 * healthy, and not quota-exhausted for the requested model; the explicitly
 * activated account wins next while it is usable; otherwise the pool is
 * ranked by family-scoped usage (OMP-aligned) and the best candidate wins.
 */
export async function pickAccount(
  storage: AccountStorageV4,
  model: string | undefined,
  conversationKey: string | undefined,
  deps: AccountPickerDeps,
): Promise<{ account: ManagedAccount; index: number } | undefined> {
  const now = Date.now()
  for (const account of storage.accounts) {
    clearExpiredState(account, now)
  }

  const family = modelFamilyOf(model)
  const familyKey = familyKeyOf(model)
  const autoRotate = deps.autoRotate?.() ?? true

  if (!autoRotate) {
    if (storage.accounts.length === 0) return undefined
    const activeIndex = storage.activeIndex >= 0 && storage.activeIndex < storage.accounts.length
      ? storage.activeIndex
      : 0
    const active = storage.accounts[activeIndex]
    if (!active) {
      throw new AgyAuthError('invalid-credential', 'No active account is configured.')
    }
    const pinnedKey = deps.affinity.affinityFor(conversationKey, now)
    if (pinnedKey !== null && pinnedKey !== deps.accountKey(active)) {
      deps.affinity.clearAffinityForConversation(conversationKey)
    }
    if (active.enabled === false) {
      throw new AgyAuthError('invalid-credential', `Active account "${active.email ?? active.id}" is disabled — enable it or select another account.`)
    }
    if (!isModelSupportedByAccount(active, model)) {
      throw new AgyAuthError('invalid-credential', `Model "${model}" is not available on active account "${active.email ?? active.id}" — switch account or pick another model.`)
    }
    if (isCoolingDown(active, now) || isFamilyQuotaExhausted(active, family, now)) {
      const recovery = computeAccountRecoveryTime(active, now)
      const blockedUntil = active.coolingDownUntil ?? recovery ?? (now + FULL_QUOTA_COOLDOWN_MS)
      const isExhausted = active.cooldownReason === 'quota-exhausted' || isFamilyQuotaExhausted(active, family, now)
      if (isExhausted && areAllModelGroupsExhausted(active, undefined, now) && !isCoolingDown(active, now) && !((active.manuallyRecoveredAt ?? 0) >= now)) {
        active.coolingDownUntil = blockedUntil
        active.cooldownReason = 'quota-exhausted'
        active.cooldownSetAt = now
        await deps.store.mutate((st) => {
          const act = st.accounts[activeIndex]
          if (act) {
            act.coolingDownUntil = blockedUntil
            act.cooldownReason = 'quota-exhausted'
            act.cooldownSetAt = now
          }
        }).catch(() => {})
      }
      throw new AgyPoolBlockedError(isExhausted ? 'quota-exhausted' : 'retryable', blockedUntil)
    }
    if (isFamilyRateLimited(active, familyKey, now)) {
      const blockedUntil = active.rateLimitResetTimes?.[familyKey] ?? active.coolingDownUntil ?? (now + 60_000)
      throw new AgyPoolBlockedError('retryable', blockedUntil)
    }
    return { account: active, index: activeIndex }
  }
  // Conversation affinity: reuse the account this conversation is already
  // pinned to while it is fresh and healthy, so one conversation stays on one
  // account. A quota-exhausted family or a cooldown breaks the pin and
  // re-ranks, mirroring OMP's pinned-until-unusable: the pin holds until the
  // account is actually spent (a measured zero, not the soft-drain threshold
  // `isFamilyDrained` applies when ranking), so the pin and the active-account
  // preference below agree on when to let go.
  const pinnedKey = deps.affinity.affinityFor(conversationKey, now)
  if (pinnedKey !== null) {
    const lastIndex = storage.accounts.findIndex((a) => deps.accountKey(a) === pinnedKey)
    if (lastIndex !== -1) {
      const last = storage.accounts[lastIndex]!
      if (
        last.enabled !== false &&
        isModelSupportedByAccount(last, model) &&
        !isCoolingDown(last, now) &&
        !isFamilyRateLimited(last, familyKey, now) &&
        !isFamilyQuotaExhausted(last, family, now)
      ) {
        return { account: last, index: lastIndex }
      }
    }
    deps.affinity.clearAffinityForConversation(conversationKey)
  }
  const eligible = storage.accounts
    .map((account, index) => ({ account, index }))
    .filter(({ account }) => account.enabled !== false && isModelSupportedByAccount(account, model))
  if (eligible.length === 0) {
    // An EMPTY store is the only case where "no account configured" is the
    // truth — return undefined so the caller's NO_CREDENTIAL fallback stays
    // accurate. When accounts EXIST but none can serve, `throwNoEligible`
    // names the real reason (see its comment for the message choices).
    if (storage.accounts.length === 0) return undefined
    throwNoEligible(storage, model)
    // unreachable; satisfies the return type
    return undefined
  }

  // Prioritize the active account as long as it is enabled, supports the model,
  // not cooling down, not family rate-limited, and not quota-exhausted.
  const active = storage.accounts[storage.activeIndex]
  const isActiveUsable = (acc: ManagedAccount | undefined): acc is ManagedAccount =>
    acc !== undefined
    && acc.enabled !== false
    && isModelSupportedByAccount(acc, model)
    && !isCoolingDown(acc, now)
    && !isFamilyRateLimited(acc, familyKey, now)
    && !isFamilyQuotaExhausted(acc, family, now)

  if (isActiveUsable(active) && deps.inFlight.inFlightCount(deps.accountKey(active), now) < MAX_IN_FLIGHT_PER_ACCOUNT) {
    return { account: active, index: storage.activeIndex }
  }

  const ranked = rankPoolCandidates(eligible, model, now, storage.activeIndex)
  // Prefer an account with in-flight headroom so concurrent conversations
  // spread across the pool; fall back to plain ranking when every candidate is
  // saturated (see `inFlight` for why this is a preference, not a gate).
  const picked =
    ranked.find((candidate) =>
      candidate.blockedUntil === null
      && deps.inFlight.inFlightCount(deps.accountKey(candidate.account), now) < MAX_IN_FLIGHT_PER_ACCOUNT)
    ?? ranked.find((candidate) => candidate.blockedUntil === null)
  if (!picked) {
    const quotaExhausted = (account: ManagedAccount): boolean => {
      if (account.cooldownReason === 'quota-exhausted' && (account.coolingDownUntil ?? 0) > now) return true
      const quota = familyQuotaFor(account, family, now)
      if (!quota) return false
      // BOTH windows, matching `rankPoolCandidates`, which blocks on a spent week
      // as well as on a spent 5-hour bucket. Reading only `remainingFraction`
      // here classified a weekly-decided block as retryable, and that path ends
      // at `RATE_LIMIT` + a ~5-day `providerRetryAfterMs`, which DSH's 10s retry
      // cap turns into giving up on the turn — a quota condition reported to the
      // user as a rate limit.
      const spent = (fraction: number | undefined, resetTime: string | undefined): boolean => {
        if (typeof fraction !== 'number' || fraction > 0 || !resetTime) return false
        const resetAt = Date.parse(resetTime)
        return !Number.isNaN(resetAt) && resetAt > now
      }
      return spent(quota.remainingFraction, quota.resetTime)
        || spent(quota.weeklyFraction, quota.weeklyResetTime)
    }
    const retryable = ranked.filter((candidate) => !quotaExhausted(candidate.account))
    const blocked = retryable.length > 0 ? retryable : ranked
    const blockedUntil = Math.min(...blocked.map((candidate) => candidate.blockedUntil ?? now))
    if (retryable.length === 0) {
      await deps.store.mutate((st) => {
        for (const candidate of ranked) {
          const acc = st.accounts[candidate.index]
          if (acc && areAllModelGroupsExhausted(acc, undefined, now) && !isCoolingDown(acc, now) && !((acc.manuallyRecoveredAt ?? 0) >= now)) {
            const recovery = computeAccountRecoveryTime(acc, now) ?? (now + FULL_QUOTA_COOLDOWN_MS)
            acc.coolingDownUntil = recovery
            acc.cooldownReason = 'quota-exhausted'
            acc.cooldownSetAt = now
          }
        }
      }).catch(() => {})
    }
    throw new AgyPoolBlockedError(retryable.length > 0 ? 'retryable' : 'quota-exhausted', blockedUntil)
  }
  if (picked.index !== storage.activeIndex) {
    storage.activeIndex = picked.index
    await deps.store.mutate((s) => {
      s.activeIndex = picked.index
    })
  }
  return { account: picked.account, index: picked.index }
}
