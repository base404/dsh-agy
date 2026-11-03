/**
 * Formatters and string conversion helpers for Antigravity Settings UI.
 */

import type { UsageCounters } from '../usage-types.ts'
import type { T } from './types.ts'
import { agoText, MINUTE_MS } from './quota-view.ts'

/** Token-count units, largest first. */
const TOKEN_UNITS: ReadonlyArray<readonly [number, string]> = [
  [1_000_000_000_000, 'T'],
  [1_000_000_000, 'B'],
  [1_000_000, 'M'],
  [1_000, 'K'],
]

/**
 * Compact token count: `1.2M` / `284K` / `512`. Counts below 1000 render in
 * full — a suffix starts at 1K.
 */
export function tokenText(value: number): string {
  if (value < 1_000) return String(value)
  const render = (scaled: number, suffix: string): string =>
    `${scaled < 100 ? scaled.toFixed(1) : String(Math.round(scaled))}${suffix}`

  const start = TOKEN_UNITS.findIndex(([divisor]) => value >= divisor)
  for (let index = start; index >= 0; index--) {
    const [divisor, suffix] = TOKEN_UNITS[index]!
    const scaled = Math.round((value / divisor) * 10) / 10
    if (scaled < 1_000) return render(scaled, suffix)
  }
  const [divisor, suffix] = TOKEN_UNITS[0]!
  return render(Math.round((value / divisor) * 10) / 10, suffix)
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  if (ms < 1_000) return `${Math.round(ms)}ms`
  const seconds = ms / 1_000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const whole = Math.round(seconds)
  return `${Math.floor(whole / 60)}m${String(whole % 60).padStart(2, '0')}s`
}

/** Cache-hit share of prompt-side input; null when nothing was billed. */
export function cacheHitPercent(counters: UsageCounters): number | null {
  const billed = counters.input + counters.cacheRead + counters.cacheWrite
  if (billed <= 0) return null
  return Math.round((counters.cacheRead / billed) * 100)
}

export function average(total: number, count: number): number {
  return count > 0 ? total / count : 0
}

/** Total tokens across the four disjoint buckets. */
export function totalTokens(counters: UsageCounters): number {
  return counters.input + counters.output + counters.cacheRead + counters.cacheWrite
}

/**
 * Cumulative average OUTPUT rate for one scope, in tokens per second.
 */
export function throughputTokenPerSecond(totals: UsageCounters): number | null {
  if (totals.latencyN === 0 || totals.ttftN === 0 || totals.output <= 0) return null
  const decodeMs = totals.latencyMs / totals.latencyN - totals.ttftMs / totals.ttftN
  if (decodeMs <= 0) return null
  return Math.round(totals.output / totals.latencyN / (decodeMs / 1_000))
}

/**
 * The whole prompt side: everything the model read, cached or not.
 */
export function promptTokens(counters: UsageCounters): number {
  return counters.input + counters.cacheRead + counters.cacheWrite
}

/** Localized label for a reasoning level. */
export function levelLabel(level: string, t: T): string {
  switch (level) {
    case 'low': return t('thinkingLevelLow')
    case 'medium': return t('thinkingLevelMedium')
    case 'high': return t('thinkingLevelHigh')
    default: return level
  }
}

/** A wall-clock moment for a state label. */
export function clockTime(iso: string | null, lang?: string): string {
  if (iso === null) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const now = new Date()
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate()
  return sameDay
    ? date.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleString(lang, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** A ledger day key ('YYYY-MM-DD') as a short label. */
export function dayLabel(day: string, lang?: string): string {
  const [y, m, d] = day.split('-').map(Number)
  if (y === undefined || m === undefined || d === undefined || Number.isNaN(y)) return day
  return new Date(y, m - 1, d).toLocaleDateString(lang, { month: 'short', day: 'numeric' })
}

/** Localized label for a cooldown reason. */
export function cooldownReasonLabel(reason: string, t: T): string {
  switch (reason) {
    case 'network-error': return t('cooldownReasonNetworkError')
    case 'quota-exhausted': return t('cooldownReasonQuotaExhausted')
    case 'validation-required': return t('cooldownReasonValidationRequired')
    case 'project-error': return t('cooldownReasonProjectError')
    default: return reason
  }
}

/** Ago label with seconds resolution, for the recent list. */
export function recentAgo(at: number, now: number, t: T): string {
  const diff = now - at
  if (diff < 10_000) return t('relJustNow')
  if (diff < MINUTE_MS) return t('relSeconds', { n: Math.floor(diff / 1_000) })
  return agoText(new Date(at).toISOString(), t, now)
}

/** Middle-truncate an identity for display. */
export function truncateIdentity(text: string, max = 22): string {
  if (text.length <= max) return text
  const head = Math.ceil((max - 1) / 2)
  const tail = max - 1 - head
  return `${text.slice(0, head)}…${text.slice(-tail)}`
}
