/**
 * Account session manager: the shared runtime glue between the store, the
 * OAuth refresh path, rotation/fingerprint logic, and the adapter. Used by the
 * in-harness plugin shell, the CLI, and the web routes.
 */

import { AgyAuthError } from './types.ts'
import type { AccountStorageV4, AgyAccountSession, FailureKind, ManagedAccount, QuotaGroup } from './types.ts'
import { parseRefreshParts, formatRefreshParts } from './oauth/auth.ts'
import type { AccountStore } from './store/accounts.ts'
import {
  FULL_QUOTA_COOLDOWN_MS,
  MAX_RATE_LIMIT_COOLDOWN_MS,
  RATE_LIMIT_COOLDOWN_MS,
  decideRotation,
  parseFutureResetMs,
  pickNextAccountIndex,
  recordRateLimit,
} from './runtime/rotation.ts'
import {
  familyKeyOf,
} from './runtime/quota.ts'
import {
  generateFingerprint,
  recordFingerprintVersion,
  updateFingerprintVersion,
} from './runtime/fingerprint.ts'
import { fingerprintMode } from './runtime/risk.ts'
import { peekCachedAntigravityVersion, resolveAntigravityVersionBounded } from './runtime/version.ts'
import { currentAgyVersion } from './oauth/constants.ts'
import { isProxyUnreachableError, probeFetch } from './proxy.ts'
import type { Fingerprint } from './types.ts'

import type {
  AccountHealthResult,
  LimitsRefreshResult,
  LimitSample,
  SessionManagerOptions,
  UsageRecord,
} from './session/types.ts'
import {
  SESSION_AFFINITY_WINDOW_MS,
  SessionAffinityTracker,
} from './session/affinity.ts'
import { InFlightTracker } from './session/in-flight.ts'
import {
  MIN_BURN_SAMPLE_MS,
  LimitBurnTracker,
  sampleLimitBurn,
} from './session/burn-rate.ts'
import {
  accountKey,
  impersonationHeadersFor,
  isModelSupportedByAccount,
} from './session/account-support.ts'
import { TokenManager, REFRESH_SKEW_MS } from './session/token-manager.ts'
import { SessionQuotaManager, QUOTA_FETCH_TIMEOUT_MS } from './session/quota-manager.ts'
import {
  pickAccount,
  skipAccount,
  throwNoEligible,
} from './session/account-picker.ts'
import {
  checkAccounts,
  exportBlob,
  startHealthProbe,
  testCall,
  verifyAccount,
  type DiagnosticsDeps,
} from './session/diagnostics.ts'

export {
  SESSION_AFFINITY_WINDOW_MS,
  MIN_BURN_SAMPLE_MS,
  sampleLimitBurn,
  isModelSupportedByAccount,
  impersonationHeadersFor,
}
export type {
  SessionManagerOptions,
  UsageRecord,
  AccountHealthResult,
  LimitsRefreshResult,
  LimitSample,
}

export class AgySessionManager {
  private readonly store: AccountStore
  private readonly onRotate: SessionManagerOptions['onRotate']
  private readonly onHealthReport: SessionManagerOptions['onHealthReport']
  private readonly recordUsageOption: SessionManagerOptions['recordUsage']

  private readonly failureCounts = new Map<string, number>()
  /** Accounts whose request-time project discovery already failed (no retry per request). */
  private readonly projectRetryFailed = new Set<string>()

  /** Bound for one quota poll so selection never stalls on a hung endpoint. */
  private static readonly QUOTA_FETCH_TIMEOUT_MS = QUOTA_FETCH_TIMEOUT_MS
  /** Refresh the token this far ahead of expiry so a request never blocks on the token endpoint. */
  private static readonly REFRESH_SKEW_MS = REFRESH_SKEW_MS

  /** Per-conversation account affinity tracker. */
  private readonly affinity = new SessionAffinityTracker()

  /** In-flight upstream requests per account tracker. */
  private readonly inFlight = new InFlightTracker()

  /** Limit burn rate tracker (fraction-per-hour). */
  private readonly burnTracker = new LimitBurnTracker()

  /** Token caching & refresh manager. */
  private readonly tokens: TokenManager

  /** Quota cache and display window probe manager. */
  private readonly quotaManager: SessionQuotaManager

  constructor(options: SessionManagerOptions) {
    this.store = options.store
    this.onRotate = options.onRotate
    this.onHealthReport = options.onHealthReport
    this.recordUsageOption = options.recordUsage

    this.tokens = new TokenManager(this.store, (a) => this.accountKey(a))
    this.quotaManager = new SessionQuotaManager({
      store: this.store,
      accountKey: (a) => this.accountKey(a),
      accessTokenFor: (a) => this.tokens.accessTokenFor(a),
      noteLimitSample: (k, g, at) => { this.burnTracker.noteLimitSample(k, g, at) },
      pruneNonLiveBurnSamples: (live) => { this.burnTracker.pruneNonLive(live) },
    })
  }

  private accountKey(account: ManagedAccount): string {
    return accountKey(account)
  }

  /** Emit one non-chat usage record; a ledger failure never breaks the call. */
  private emitUsage(record: UsageRecord): void {
    try {
      this.recordUsageOption?.(record)
    } catch {
      // Swallowed by design: statistics are diagnostics.
    }
  }

  private get diagnosticsDeps(): DiagnosticsDeps {
    return {
      store: this.store,
      getSession: (model, accountIndex) => this.getSession(model, accountIndex),
      accessTokenFor: (account) => this.tokens.accessTokenFor(account),
      emitUsage: (record) => { this.emitUsage(record) },
      onHealthReport: this.onHealthReport,
    }
  }

  /** Record that one upstream request for this account has started. */
  noteRequestStarted(account: ManagedAccount): void {
    this.inFlight.noteRequestStarted(this.accountKey(account), Date.now())
  }

  /** Record that one upstream request for this account has settled, on any path. */
  noteRequestSettled(account: ManagedAccount): void {
    this.inFlight.noteRequestSettled(this.accountKey(account), Date.now())
  }

  /**
   * Which accounts have upstream requests in flight, for the UI's live line.
   */
  async inFlightAccounts(): Promise<Array<{ index: number; email: string | null; count: number }>> {
    const storage = await this.store.load()
    return this.inFlight.inFlightAccounts(storage.accounts, (a) => this.accountKey(a), Date.now())
  }

  /**
   * Burn rates per account INDEX, for the `account.limits` reply.
   */
  async limitBurnRates(): Promise<Array<{ index: number; perHour: Record<string, number> }>> {
    const storage = await this.store.load()
    return this.burnTracker.limitBurnRates(storage.accounts, (a) => this.accountKey(a))
  }

  /**
   * Drop the affinity pin for one conversation.
   */
  clearAffinityForConversation(conversationKey?: string): void {
    this.affinity.clearAffinityForConversation(conversationKey)
  }

  /**
   * Clear all session affinity pins.
   */
  clearAllAffinity(): void {
    this.affinity.clearAllAffinity()
  }

  private _lastModelUsedAt: number | null = null

  /** Timestamp (epoch ms) when an Antigravity model was last used. */
  getLastModelUsedAt(): number | null {
    return this._lastModelUsedAt
  }

  /** Record that an Antigravity model was just used. */
  recordModelUsed(now = Date.now()): void {
    this._lastModelUsedAt = now
  }

  /**
   * Explicitly activate an account by index: sets `storage.activeIndex = index`,
   * clears session affinity pins so conversations immediately switch to the
   * activated account, and resets transient failure counts.
   */
  async activateAccount(index: number): Promise<void> {
    await this.store.mutate((storage) => {
      if (index < 0 || index >= storage.accounts.length) {
        throw new Error('account not found')
      }
      storage.activeIndex = index
    })
    this.clearAllAffinity()
  }

  /**
   * Manually lift one account's cooldown ("冷却至 …") and its rate-limit walls.
   */
  async recoverAccount(index: number): Promise<void> {
    let key: string | undefined
    await this.store.mutate((storage) => {
      const account = storage.accounts[index]
      if (!account) {
        throw new Error('account not found')
      }
      key = this.accountKey(account)
      account.coolingDownUntil = undefined
      account.cooldownReason = undefined
      account.cooldownSetAt = undefined
      account.rateLimitResetTimes = undefined
    })
    if (key !== undefined) this.failureCounts.delete(key)
  }

  /**
   * Refresh the display-only 5h/weekly windows for every enabled account.
   */
  async refreshLimits(
    storage: AccountStorageV4,
    options: { force?: boolean; indices?: number[] } = {},
  ): Promise<LimitsRefreshResult> {
    return this.quotaManager.refreshLimits(storage, options)
  }

  /**
   * Adapter hook: resolve the active session (refresh if needed), healing a
   * missing projectId at request time.
   */
  async getSession(
    model?: string,
    accountIndex?: number,
    conversationKey?: string,
  ): Promise<AgyAccountSession | undefined> {
    let storage = await this.store.load()
    if (accountIndex !== undefined) {
      const account = storage.accounts[accountIndex]
      if (!account) throw new Error(`account #${accountIndex} not found`)
      if (account.enabled === false) throw new Error(`account #${accountIndex} is disabled`)
    }
    const maxAttempts = accountIndex === undefined
      ? storage.accounts.filter((account) => account.enabled !== false).length
      : 1
    let proxyUnreachableCount = 0
    let lastTransportError: unknown

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const eligible = storage.accounts.filter((account) => account.enabled !== false)
      if (accountIndex === undefined && eligible.length > 1) {
        await this.quotaManager.refreshQuotaCache(storage)
      }
      const picked = accountIndex === undefined
        ? await pickAccount(storage, model, conversationKey, {
          affinity: this.affinity,
          inFlight: this.inFlight,
          store: this.store,
          accountKey: (a) => this.accountKey(a),
        })
        : (() => {
          const account = storage.accounts[accountIndex]
          if (!account) throw new Error(`account #${accountIndex} not found`)
          if (account.enabled === false) throw new Error(`account #${accountIndex} is disabled`)
          return { account, index: accountIndex }
        })()
      if (!picked) return undefined

      let auth
      try {
        auth = await this.tokens.accessTokenFor(picked.account)
      } catch (error) {
        if (Boolean(picked.account.proxy) && isProxyUnreachableError(error)) {
          proxyUnreachableCount++
          if (accountIndex !== undefined) throw error
          storage = await skipAccount(storage, picked.account, {
            affinity: this.affinity,
            store: this.store,
            accountKey: (a) => this.accountKey(a),
          })
          continue
        }
        lastTransportError = error
        if (accountIndex !== undefined) throw error
        storage = await skipAccount(storage, picked.account, {
          affinity: this.affinity,
          store: this.store,
          accountKey: (a) => this.accountKey(a),
        })
        continue
      }
      if (!auth) {
        if (accountIndex !== undefined) {
          throw new Error(`account #${accountIndex} credential is no longer valid — run \`dsh-agy login\``)
        }
        this.affinity.clearAffinityForAccount(this.accountKey(picked.account))
        storage = await this.store.load()
        continue
      }

      const key = this.accountKey(picked.account)
      if (!picked.account.projectId && !this.projectRetryFailed.has(key)) {
        try {
          const { loadCodeAssist } = await import('./oauth/exchange.ts')
          const { projectId } = await loadCodeAssist(auth.access, { proxyUrl: picked.account.proxy })
          if (projectId) {
            await this.store.mutate((s) => {
              const account = s.accounts.find((candidate) => this.accountKey(candidate) === key)
              if (account) {
                account.projectId = projectId
                const parts = parseRefreshParts(account.refresh)
                account.refresh = formatRefreshParts({
                  refreshToken: parts.refreshToken,
                  projectId,
                  managedProjectId: parts.managedProjectId,
                })
              }
            })
            picked.account.projectId = projectId
          } else {
            this.projectRetryFailed.add(key)
          }
        } catch {
          this.projectRetryFailed.add(key)
        }
      }

      if (!picked.account.fingerprint) {
        const fingerprint = generateFingerprint(undefined, currentAgyVersion())
        const history = recordFingerprintVersion(picked.account.fingerprintHistory, fingerprint, 'initial')
        await this.store.mutate((s) => {
          const account = s.accounts.find((candidate) => this.accountKey(candidate) === key)
          if (account && !account.fingerprint) {
            account.fingerprint = fingerprint
            account.fingerprintHistory = history
          }
        })
        picked.account.fingerprint = fingerprint
        picked.account.fingerprintHistory = history
      }

      if (accountIndex === undefined) {
        this.affinity.setAffinity(conversationKey, key, Date.now())
        this.recordModelUsed(Date.now())
      }
      return {
        auth,
        account: picked.account,
        index: picked.index,
        impersonation: impersonationHeadersFor(picked.account),
      }
    }

    if (proxyUnreachableCount === maxAttempts && maxAttempts > 0) {
      throw new AgyAuthError('transport', 'proxy_unreachable')
    }
    if (lastTransportError !== undefined) throw lastTransportError
    if (storage.accounts.length === 0) return undefined
    throwNoEligible(storage, model)
    return undefined
  }

  /** Adapter hook: apply rotation decisions and fingerprint regeneration. */
  async reportFailure(
    kind: FailureKind,
    session: AgyAccountSession,
    info?: {
      retryAfterMs?: number
      status?: number
      rateLimitCategory?: import('./runtime/classify.ts').RateLimitCategory
      resetTime?: string
      model?: string
      verificationUrl?: string
    },
  ): Promise<void> {
    if (!session?.account) return
    const key = this.accountKey(session.account)
    const consecutive = (this.failureCounts.get(key) ?? 0) + 1
    this.failureCounts.set(key, consecutive)
    let nextIndexToRotate: number | null = null
    const fpCachedVersion = kind === 'rate-limit' ? peekCachedAntigravityVersion() : null
    const fpResolvedVersion = kind === 'rate-limit'
      ? (fpCachedVersion ?? (await resolveAntigravityVersionBounded(750, probeFetch(session.account.proxy))) ?? currentAgyVersion())
      : currentAgyVersion()

    this.recordModelUsed(Date.now())
    await this.store.mutate((storage) => {
      const account = storage.accounts.find((a) => this.accountKey(a) === key)
      if (!account) return

      const decision = decideRotation(kind, account, consecutive, info?.retryAfterMs, info?.rateLimitCategory, info?.resetTime, info?.model)

      if (kind === 'verification-required' && info?.verificationUrl) {
        account.verificationUrl = info.verificationUrl
      }

      if (kind === 'rate-limit' && info?.rateLimitCategory !== 'soft_rate_limit') {
        const familyKey = familyKeyOf(info?.model)
        const resetMs = parseFutureResetMs(info?.resetTime, Date.now()) ??
          (Date.now() + (info?.rateLimitCategory === 'quota_exhausted' ? FULL_QUOTA_COOLDOWN_MS : Math.min(info?.retryAfterMs ?? RATE_LIMIT_COOLDOWN_MS, MAX_RATE_LIMIT_COOLDOWN_MS)))
        recordRateLimit(account, familyKey, resetMs)
      }

      if (decision.action === 'revoke') {
        this.tokens.clearToken(key)
        this.failureCounts.delete(key)
        const currentIndex = storage.accounts.findIndex((a) => this.accountKey(a) === key)
        const nextIndex = pickNextAccountIndex(storage.accounts, currentIndex >= 0 ? currentIndex : storage.activeIndex, Date.now())
        if (nextIndex !== storage.activeIndex) {
          storage.activeIndex = nextIndex
          nextIndexToRotate = nextIndex
        }
        this.affinity.clearAffinityForAccount(key)
        return
      }

      if (kind === 'rate-limit' && info?.rateLimitCategory !== 'soft_rate_limit') {
        if (!account.fingerprint) {
          account.fingerprint = generateFingerprint(undefined, fpResolvedVersion)
          account.fingerprintHistory = recordFingerprintVersion(account.fingerprintHistory, account.fingerprint, 'initial')
        } else {
          if (fpCachedVersion) updateFingerprintVersion(account.fingerprint, fpCachedVersion)
          if (fingerprintMode() !== 'stable' && consecutive >= 2) {
            const fresh = generateFingerprint(undefined, fpResolvedVersion)
            account.fingerprintHistory = recordFingerprintVersion(account.fingerprintHistory, fresh, 'regenerated')
            account.fingerprint = fresh
          }
        }
      }

      if (decision.action === 'rotate' || decision.action === 'cool') {
        const currentIndex = storage.accounts.findIndex((a) => this.accountKey(a) === key)
        const familyKey = familyKeyOf(info?.model)
        const nextIndex = pickNextAccountIndex(storage.accounts, currentIndex >= 0 ? currentIndex : storage.activeIndex, Date.now(), familyKey)
        if (nextIndex !== storage.activeIndex) {
          storage.activeIndex = nextIndex
          nextIndexToRotate = nextIndex
        }
        this.affinity.clearAffinityForAccount(key)
      }
    })

    if (nextIndexToRotate !== null) {
      this.onRotate?.(session.index, nextIndexToRotate, kind)
      this.emitUsage({
        ...(session.account.email === undefined && session.account.id === undefined
          ? {}
          : { account: session.account.email ?? session.account.id }),
        source: 'chat',
        ok: false,
        rotated: true,
        poolEvent: true,
        reason: kind,
      })
    }
  }

  /** Adapter hook: reset the failure counter after a clean completion. */
  async markSuccess(session: AgyAccountSession): Promise<void> {
    const account = session.account
    const key = this.accountKey(account)
    this.failureCounts.delete(key)
    this.recordModelUsed(Date.now())
  }

  /**
   * Test call: one short streaming request against the live backend.
   * Returns the collected text or a structured error message.
   */
  async testCall(
    model: string,
    options: {
      prompt?: string
      maxTokens?: number
      accountIndex?: number
      signal?: AbortSignal
      idleTimeoutMs?: number
    } = {},
  ): Promise<{ ok: boolean; text?: string; error?: string }> {
    return testCall(model, options, this.diagnosticsDeps)
  }

  /** Export one account as a paste-credential blob (for migration to another host). */
  async exportBlob(index: number): Promise<{ blob?: string; error?: string }> {
    return exportBlob(index, this.diagnosticsDeps)
  }

  /** CLI/web helper: verify an account's credentials (refresh + userinfo). */
  async verifyAccount(index: number): Promise<{ ok: boolean; email?: string; error?: string }> {
    return verifyAccount(index, this.diagnosticsDeps)
  }

  /**
   * Batch health check over all enabled accounts (or the given indices):
   * refresh + userinfo per account, live credentials re-enable the account.
   */
  async checkAccounts(indices?: number[]): Promise<AccountHealthResult[]> {
    return checkAccounts(indices, this.diagnosticsDeps)
  }

  /**
   * Start a background health probe on an interval (disposable stop handle).
   */
  startHealthProbe(intervalMs: number, options: { unref?: boolean } = {}): () => void {
    return startHealthProbe(intervalMs, options, this.diagnosticsDeps)
  }
}

export type { Fingerprint }
