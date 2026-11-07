/**
 * Which upstream quota GROUP the conversation-header badge shows, and how it
 * rotates between them.
 *
 * Separate from `quota-view.ts` on purpose: that module answers "what does a
 * reading mean" (fractions, thresholds, reset copy), this one answers "which
 * reading is on screen right now". The rule is a pure function of
 * (groups, phase, windowType), so the test suite pins it without a browser,
 * without a timer, and without the host's RPC.
 *
 * THE BUG THIS REPLACES: the badge picked one group ONCE and alternated only
 * that group's own 5h and weekly windows on the render tick. A pool with three
 * upstream groups therefore showed ONE group's two windows, and the other two
 * (a spent Claude week at 0%, a healthy Gemini 4 Argon at 41%) were never
 * printed at all. The reading looked like the whole pool when it was one group,
 * and a group that had run out could not be told apart from one never measured.
 *
 * The rule now lives in `rotationGroups` and `windowForPhase`.
 */

import type { QuotaGroup } from '../types.ts'
import { WEEKLY_QUOTA_THRESHOLD } from '../runtime/rotation.ts'
import type { AccountView } from '../rpc-contract.ts'

/** The `auto` value stored under `badgeModelGroup` (the "rotate all" mode). */
export const BADGE_GROUP_AUTO = 'auto'

/** The quota families a badge rotation can be grouped by. */
export type BadgeGroupFamily = 'argon' | 'google' | 'anthropic' | 'openai'

/**
 * The family a model id belongs to.
 *
 * A cut-down port of `runtime/quota.ts`'s `modelFamilyOf`: the scheduler is not
 * in the browser bundle, and this is the only id-to-bucket rule the client needs.
 * `argon` is checked BEFORE the `gemini-` prefix, because `gemini-4-argon-*`
 * starts with `gemini-` and would otherwise be filed under the standard Google
 * budget and hide the group that actually serves it (measured: the adapter sends
 * `gemini-4-argon-low`, upstream routes it as `gemini-4-argon-trial`, and the
 * quota summary reports it under its own `Gemini 4 Argon` group).
 */
export function modelFamilyOf(modelId?: string | null): BadgeGroupFamily | undefined {
  if (!modelId) return undefined
  const id = modelId.toLowerCase()
  if (id.includes('argon')) return 'argon'
  if (id.startsWith('claude-')) return 'anthropic'
  if (id.startsWith('gemini-') || id.startsWith('gemma-')) return 'google'
  if (id.startsWith('gpt-') || id.startsWith('openai/')) return 'openai'
  return undefined
}

/**
 * The upstream family a group's buckets belong to, or undefined when nothing
 * recognisable names one.
 *
 * Bucket ids are the machine-readable half (`gemini-*`, `gemini-argon-*`,
 * `3p-*`, ...) and win; the label is the fallback. `3p-` covers Claude AND GPT
 * together upstream, so it answers `anthropic`. Argon is checked first for the
 * same prefix-shadowing reason `modelFamilyOf` checks it first.
 */
export function groupFamily(group: QuotaGroup): BadgeGroupFamily | undefined {
  for (const window of group.windows) {
    const bucketId = window.bucketId.toLowerCase()
    if (bucketId.includes('argon')) return 'argon'
    if (bucketId.startsWith('gemini-') || bucketId.startsWith('gemma-')) return 'google'
    if (bucketId.startsWith('3p-') || bucketId.startsWith('third_party-')) return 'anthropic'
    if (bucketId.startsWith('claude-')) return 'anthropic'
    if (bucketId.startsWith('gpt-') || bucketId.startsWith('openai-')) return 'openai'
  }
  const name = group.name.toLowerCase()
  if (name.includes('argon')) return 'argon'
  if (name.includes('gemini') || name.includes('google')) return 'google'
  if (name.includes('claude')) return 'anthropic'
  if (name.includes('gpt')) return 'openai'
  return undefined
}

/**
 * The short, fixed-length name the conversation-header badge prints for a group.
 *
 * The badge is a fixed-width pill (215px, 170px on narrow screens): upstream's
 * `Claude and GPT models` filled it on its own and pushed the window + percent
 * off the clipped edge, so the Claude week could not be read at all. Each family
 * gets a stable short name — Argon stays apart from Gemini for the same reason
 * the badge never used `modelLabelForGroup` (two budgets must not read as one).
 * The Claude bucket is shared with GPT upstream (`3p-*`), so its name keeps both.
 * An unrecognised group falls back to its upstream name, which the badge's CSS
 * ellipsizes. Only the badge pill uses this; cards and pickers keep full names.
 */
export function badgeGroupLabel(group: QuotaGroup): string {
  switch (groupFamily(group)) {
    case 'argon': return 'Argon'
    case 'google': return 'Gemini'
    case 'anthropic': {
      const sharedWithGpt = group.name.toLowerCase().includes('gpt')
        || group.windows.some((w) => /^(3p|third_party)-/i.test(w.bucketId))
      return sharedWithGpt ? 'Claude/GPT' : 'Claude'
    }
    case 'openai': return 'GPT'
    default: return group.name
  }
}

/**
 * A window's live fraction, or null when unmeasured.
 *
 * A reset that has already passed means the window refilled, so a cached 0% is
 * not evidence about the period we are in — the same rule `effectiveFraction` in
 * `quota-view.ts` applies, restated here so this module has no dependency on it.
 */
export function liveFraction(value: number | null | undefined, resetTime: string | null | undefined, now: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (resetTime) {
    const resetAt = Date.parse(resetTime)
    if (!Number.isNaN(resetAt) && resetAt <= now) return 1
  }
  return value
}

/**
 * The live fraction of one window kind in one group, or null.
 *
 * A group may carry more than one bucket of a kind and the TIGHTEST wins, the
 * same rule `accountQuotaRead` applies across groups: the pool blocks on the
 * smallest runway, so that is the number the badge must print.
 */
export function readWindowAt(group: QuotaGroup | null | undefined, token: '5h' | 'weekly', now: number): number | null {
  if (!group) return null
  let best: number | null = null
  for (const window of group.windows) {
    if (window.window.toLowerCase() !== token) continue
    const fraction = liveFraction(window.remainingFraction, window.resetTime, now)
    if (fraction === null) continue
    const value = Math.max(fraction, 0)
    if (best === null || value < best) best = value
  }
  return best
}

/**
 * Whether a group's weekly budget is drained.
 *
 * The SAME threshold the pool itself benches a family on
 * (`WEEKLY_QUOTA_THRESHOLD`, 1%), so the badge can never advertise as the
 * headline a group the scheduler has already stopped trusting. A 2% week is
 * real runway and stays in the rotation.
 */
export function isGroupWeeklyDrained(group: QuotaGroup, now: number): boolean {
  const weekly = readWindowAt(group, 'weekly', now)
  return weekly !== null && weekly <= WEEKLY_QUOTA_THRESHOLD
}

/**
 * The groups the badge rotates over, in upstream's own payload order.
 *
 * `auto` keeps every group whose weekly window is not drained when
 * `skipDrainedWeekly` is on (the shipped default), and every group when it is
 * off — so the 0% week a user is worried about can be read on purpose instead of
 * being silently hidden behind a healthy sibling. A MANUAL selection returns
 * exactly the matching group in either case, and deliberately does NOT drop it
 * for being drained: the user asked for that group, so it is shown, 0% and all.
 * An empty `limits` list is an empty rotation, never a synthesized row.
 */
export function rotationGroups(
  limits: readonly QuotaGroup[] | null | undefined,
  selection: string | null | undefined,
  now: number,
  skipDrainedWeekly: boolean = true,
): QuotaGroup[] {
  if (!limits || limits.length === 0) return []
  const key = (selection ?? BADGE_GROUP_AUTO).trim()
  if (key === '' || key.toLowerCase() === BADGE_GROUP_AUTO) {
    return skipDrainedWeekly
      ? limits.filter((group) => !isGroupWeeklyDrained(group, now))
      : limits.slice()
  }
  const family = familyOfSelection(key)
  if (family !== undefined) {
    const match = limits.filter((group) => groupFamily(group) === family)
    if (match.length > 0) return match
  }
  const exact = limits.filter((group) => group.name.toLowerCase() === key.toLowerCase())
  if (exact.length > 0) return exact
  // A stale stored value (upstream renamed the group): the first group is still
  // a reading of this account, and an empty badge reads as "nothing configured".
  return [limits[0]!]
}

/** The family named by one of the picker's token values, when it names one. */
function familyOfSelection(selection: string): BadgeGroupFamily | undefined {
  switch (selection.toLowerCase()) {
    case 'argon': return 'argon'
    case 'gemini': return 'google'
    case 'claude': return 'anthropic'
    case 'gpt': return 'openai'
    default: return undefined
  }
}

/**
 * The group on screen at a given render phase.
 *
 * `phase` is the SAME `Math.floor(now / RENDER_TICK_MS)` the 5h/weekly flip uses,
 * so the two rotations share one clock and cannot drift apart: three groups and
 * two windows both complete over the same tick grid, and no jump on the badge
 * ever restarts one without the other. Modulo (not clamping) makes the cycle
 * wrap: passing the last group continues at the first.
 */
export function groupAtPhase(
  groups: readonly QuotaGroup[],
  phase: number,
): QuotaGroup | null {
  return groups.length === 0 ? null : groups[phase % groups.length]!
}

/**
 * Which window inside the current group is on screen, given the phase.
 *
 * `'both'` alternates 5h and weekly on the phase's parity; the explicit window
 * types pin one. A group that does NOT report the pinned kind falls back to the
 * kind it does report (the Argon group is weekly-only), so a pin can never strand
 * the badge on an em dash.
 */
export function windowForPhase(
  group: QuotaGroup | null | undefined,
  phase: number,
  windowType: 'both' | '5h' | 'weekly',
  now: number,
): '5h' | 'weekly' {
  const has5h = readWindowAt(group, '5h', now) !== null
  const hasWeekly = readWindowAt(group, 'weekly', now) !== null

  if (windowType === 'both') {
    if (has5h && hasWeekly) return phase % 2 === 1 ? 'weekly' : '5h'
    if (hasWeekly) return 'weekly'
    return '5h'
  }

  if (windowType === 'weekly') {
    if (hasWeekly) return 'weekly'
    if (has5h) return '5h'
    return 'weekly'
  }

  // windowType === '5h'
  if (has5h) return '5h'
  if (hasWeekly) return 'weekly'
  return '5h'
}

/** The account's `limits` groups, or an empty list. */
export function limitsOf(view: AccountView | undefined): readonly QuotaGroup[] {
  return view?.limits ?? []
}
