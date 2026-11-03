/**
 * Account identity, fingerprint headers, and model compatibility helpers.
 */

import type { AgyAccountSession, ManagedAccount } from '../types.ts'
import { getFingerprintData, getStableHeaders } from '../runtime/fingerprint.ts'
import { currentAgyVersion } from '../oauth/constants.ts'

/** Derives the canonical unique key for an account. */
export function accountKey(account: ManagedAccount): string {
  return account.id ?? account.email ?? `idx-${account.refresh}`
}

/** Whether a specific account is known to support the requested model. */
export function isModelSupportedByAccount(account: ManagedAccount, model?: string): boolean {
  if (!model || !account.cachedModels || account.cachedModels.length === 0) return true
  if (account.cachedModels.includes(model)) return true
  const tieredMatch = /^(.*)-tiered$/.exec(model)
  if (tieredMatch) {
    const base = tieredMatch[1]
    if (account.cachedModels.some((m) => m === model || m.startsWith(base + '-'))) return true
  }
  const levelMatch = /^(.*)-(?:low|medium|high)$/.exec(model)
  if (levelMatch) {
    const base = levelMatch[1]
    if (account.cachedModels.some((m) => m === model || m === `${base}-tiered` || m.startsWith(base + '-'))) return true
  }
  return false
}

/**
 * Resolve the impersonation headers for one request from the account's
 * persistent fingerprint (stable identity).
 *
 * The fallback below is only reachable when an account has no stored identity —
 * normal operation creates one on first use (see `getSession`). It is therefore
 * deliberately DETERMINISTIC rather than randomized: a per-request platform or
 * version would make one account appear to be several different machines, which
 * is the anomaly this identity exists to avoid. It reads
 * {@link getFingerprintData} so a `$DSH_HOME/agy/agy-fingerprint-data.json` override
 * still applies on this path.
 */
export function impersonationHeadersFor(account: ManagedAccount): AgyAccountSession['impersonation'] {
  const fingerprint = account.fingerprint
  if (fingerprint) {
    return {
      'User-Agent': fingerprint.userAgent,
      'X-Goog-Api-Client': fingerprint.apiClient,
      clientMetadata: fingerprint.clientMetadata,
    }
  }
  return getStableHeaders(getFingerprintData(), currentAgyVersion())
}
