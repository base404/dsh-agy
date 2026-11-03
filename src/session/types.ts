/**
 * Types and interfaces for the session management domain.
 */

import type { AccountStore } from '../store/accounts.ts'
import type { CachedQuota, FailureKind } from '../types.ts'

export interface SessionManagerOptions {
  store: AccountStore
  /** Called after rotation changes the active index (for logging/UI). */
  onRotate?: (fromIndex: number, toIndex: number, reason: FailureKind) => void
  /** Called after a health check finishes (batch probe results). */
  onHealthReport?: (results: AccountHealthResult[]) => void
  /**
   * Receives one usage record per account-scoped upstream call made outside the
   * chat path (verification, test calls, CLI invocations).
   */
  recordUsage?: (record: UsageRecord) => void
}

/** A usage record emitted by the session manager's non-chat call paths. */
export interface UsageRecord {
  account?: string
  model?: string
  source: 'chat' | 'cli' | 'verify' | 'test'
  ok: boolean
  rateLimited?: boolean
  /** Token usage, when the call parsed an upstream stream. */
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number }
  latencyMs?: number
  ttftMs?: number
  /**
   * A pool-level event (a rotation) rather than a request of its own.
   */
  poolEvent?: boolean
  /** Marks a rotation in a pool event. */
  rotated?: boolean
  /**
   * The failure classification ('rate-limit', 'network-error', ...), when the
   * record failed.
   */
  reason?: string
}

/** One account's health check result (refresh + userinfo). */
export interface AccountHealthResult {
  index: number
  email?: string
  ok: boolean
  error?: string
}

/**
 * What one 5h/weekly window refresh actually did.
 */
export interface LimitsRefreshResult {
  /** Account keys whose windows were measured and written. */
  measured: string[]
  /** Account keys whose probe was attempted and failed. */
  failed: string[]
  /** Accounts not probed because their snapshot was still fresh. */
  skipped: number
}

/**
 * One quota-fraction snapshot, for the burn rate. Memory only.
 */
export interface LimitSample {
  at: number
  /** bucketId -> remaining fraction; null fractions are omitted. */
  fractions: Record<string, number>
}

export interface TokenCacheEntry {
  access: string
  expires: number
}

export interface QuotaRefreshResult {
  key: string
  quotas: Record<string, CachedQuota>
  updatedAt: number
}
