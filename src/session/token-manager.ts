/**
 * Token caching, pre-emptive skew refreshing, and single-flight de-duplication
 * per account.
 */

import { AgyAuthError } from '../types.ts'
import type { ManagedAccount, OAuthAuthDetails } from '../types.ts'
import { refreshAccessToken } from '../oauth/refresh.ts'
import { accessTokenExpired } from '../oauth/auth.ts'
import type { AccountStore } from '../store/accounts.ts'
import { isProxyUnreachableError } from '../proxy.ts'
import { describeFetchError } from '../runtime/classify.ts'
import type { TokenCacheEntry } from './types.ts'

/** Refresh the token this far ahead of expiry so a request never blocks on the token endpoint. */
export const REFRESH_SKEW_MS = 2 * 60 * 1000

export class TokenManager {
  private readonly tokenCache = new Map<string, TokenCacheEntry>()
  /** In-flight refresh promises keyed by account: concurrent requests share one refresh. */
  private readonly refreshInFlight = new Map<string, Promise<OAuthAuthDetails | undefined>>()

  constructor(
    private readonly store: AccountStore,
    private readonly accountKey: (account: ManagedAccount) => string,
  ) {}

  /** Clear cached token for an account (e.g. on revocation or dead credential). */
  clearToken(key: string): void {
    this.tokenCache.delete(key)
  }

  /**
   * Refresh the account's access token (single-flight per account). A transient
   * refresh failure keeps the cached token in place (retain-last-good): the old
   * token stays valid until its own expiry and a later request retries the
   * refresh. Only `invalid_grant` drops the cache.
   */
  refreshToken(key: string, account: ManagedAccount, cached?: TokenCacheEntry): Promise<OAuthAuthDetails | undefined> {
    const inFlight = this.refreshInFlight.get(key)
    if (inFlight) return inFlight

    const refreshing = (async (): Promise<OAuthAuthDetails | undefined> => {
      const result = await refreshAccessToken(
        { access: cached?.access ?? '', expires: cached?.expires ?? 0, refresh: account.refresh },
        { clientId: account.clientId, proxyUrl: account.proxy },
      )
      if (result.type === 'success') {
        if (!account.clientId && result.clientId) {
          await this.store.mutate((s) => {
            const target = s.accounts.find((candidate) => this.accountKey(candidate) === key)
            if (!target) throw new Error(`Account ${key} not found during clientId migration`)
            target.clientId = result.clientId
          })
          account.clientId = result.clientId
        }
        // Cache token strictly AFTER disk persistence has succeeded
        this.tokenCache.set(key, { access: result.auth.access, expires: result.auth.expires })
        return result.auth
      }
      if (result.type === 'failed') {
        if (cached && !accessTokenExpired({ access: cached.access, expires: cached.expires, refresh: account.refresh })) {
          return { access: cached.access, expires: cached.expires, refresh: account.refresh }
        }
        // Only an explicit per-account proxy may be judged proxy-unreachable.
        // Without one a bare ECONNRESET is a transient network error, and
        // reporting it as proxy_unreachable made a healthy single account look
        // like a dead proxy (issue #29).
        if (account.proxy && isProxyUnreachableError(result.error)) {
          throw new AgyAuthError('transport', 'proxy_unreachable', { cause: result.error })
        }
        const kind = result.error.status === 429
          ? 'rate-limit'
          : result.error.status === 0 || result.error.status === 408 || result.error.status >= 500
            ? 'transport'
            : 'invalid-credential'
        throw new AgyAuthError(kind, describeFetchError(result.error), { cause: result.error })
      }
      if (result.type === 'revoked') {
        // Account credentials are dead — mark it disabled and verificationRequired in the store
        this.tokenCache.delete(key)
        await this.store.mutate((s) => {
          const target = s.accounts.find((candidate) => this.accountKey(candidate) === key)
          if (target) {
            target.enabled = false
            target.verificationRequired = true
            target.verificationRequiredAt = Date.now()
            target.verificationRequiredReason = 'auth-failure'
          }
        })
        account.enabled = false
        account.verificationRequired = true
        account.verificationRequiredAt = Date.now()
        account.verificationRequiredReason = 'auth-failure'
        return undefined
      }
      return undefined
    })()
    this.refreshInFlight.set(key, refreshing)
    refreshing.then(
      () => this.refreshInFlight.delete(key),
      () => this.refreshInFlight.delete(key),
    )
    return refreshing
  }

  /** Resolve a usable access token for the account, pre-emptively refreshing near expiry. */
  async accessTokenFor(account: ManagedAccount): Promise<OAuthAuthDetails | undefined> {
    const key = this.accountKey(account)
    const cached = this.tokenCache.get(key)
    const now = Date.now()
    if (cached && !accessTokenExpired({ access: cached.access, expires: cached.expires, refresh: account.refresh })) {
      // Pre-emptive refresh within the skew: serve the still-valid token and
      // refresh in the background (OMP-style refresh skew).
      if (cached.expires <= now + REFRESH_SKEW_MS) {
        void this.refreshToken(key, account, cached)
      }
      return { access: cached.access, expires: cached.expires, refresh: account.refresh }
    }
    return this.refreshToken(key, account, cached)
  }
}
