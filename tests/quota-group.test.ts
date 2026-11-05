/**
 * The badge's GROUP rotation: which upstream budget the conversation-header
 * badge shows, and how it cycles between them.
 *
 * The shapes here are the ones a real account reports (measured 2026-11-05):
 * three groups, one weekly-only, one spent to 0%, one at 2% — i.e. exactly the
 * pool that used to render as a single group's two windows.
 */

import { describe, expect, it } from 'vitest'
import {
  BADGE_GROUP_AUTO,
  badgeGroupLabel,
  groupAtPhase,
  groupFamily,
  isGroupWeeklyDrained,
  liveFraction,
  limitsOf,
  modelFamilyOf,
  readWindowAt,
  rotationGroups,
  windowForPhase,
} from '../src/client/quota-group.ts'
import { WEEKLY_QUOTA_THRESHOLD } from '../src/runtime/rotation.ts'
import type { AccountView } from '../src/rpc-contract.ts'
import type { QuotaGroup, QuotaWindow } from '../src/types.ts'

const NOW = Date.parse('2026-11-05T05:50:00.000Z')
/** `minutes` from NOW, as RFC3339 (negative = past). */
const at = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString()

function window_(
  bucketId: string,
  kind: '5h' | 'weekly',
  fraction: number | null,
  resetTime: string | null = at(120),
): QuotaWindow {
  return { bucketId, window: kind, remainingFraction: fraction, resetTime }
}

/** The live account's three groups, verbatim fractions. */
const GEMINI = (): QuotaGroup => ({
  name: 'Gemini Models',
  windows: [window_('gemini-5h', '5h', 0.9525048, at(20)), window_('gemini-weekly', 'weekly', 0.022692248, at(5000))],
})
const CLAUDE = (): QuotaGroup => ({
  name: 'Claude and GPT models',
  windows: [window_('3p-5h', '5h', 1, at(90)), window_('3p-weekly', 'weekly', 0, at(2000))],
})
const ARGON = (): QuotaGroup => ({
  name: 'Gemini 4 Argon',
  windows: [window_('gemini-argon-wtu-weekly', 'weekly', 0.41409934, at(9000))],
})

const POOL = [GEMINI(), CLAUDE(), ARGON()]

describe('badgeGroupLabel', () => {
  it('prints a short fixed name per family so the reading is never pushed out of the pill', () => {
    expect(POOL.map(badgeGroupLabel)).toEqual(['Gemini', 'Claude/GPT', 'Argon'])
  })

  it('keeps Claude alone when the group is not shared with GPT', () => {
    expect(badgeGroupLabel({ name: 'Claude models', windows: [window_('claude-5h', '5h', 1)] })).toBe('Claude')
  })

  it('falls back to the upstream name for an unrecognised group', () => {
    expect(badgeGroupLabel({ name: 'Mystery bucket', windows: [window_('x-5h', '5h', 1)] })).toBe('Mystery bucket')
  })
})

function account(overrides: Partial<AccountView> = {}): AccountView {
  return {
    index: 0,
    email: 'pilot@example.com',
    projectId: 'proj',
    active: true,
    state: 'active',
    cooldownUntil: null,
    cooldownReason: null,
    cooldownSetAt: null,
    verificationUrl: null,
    verificationRequired: false,
    rateLimits: null,
    fingerprint: null,
    fingerprintHistory: 0,
    proxy: null,
    usage: null,
    limits: null,
    limitsUpdatedAt: null,
    actualModel: null,
    ...overrides,
  }
}

describe('model family', () => {
  it('files argon BEFORE the gemini prefix it also starts with', () => {
    // The whole point of the ordering: an argon id is the one family the
    // standard Google budget does not fund, so reporting it as `google` shows a
    // number from a budget the model cannot spend.
    expect(modelFamilyOf('gemini-4-argon-low')).toBe('argon')
    expect(modelFamilyOf('gemini-4-argon-trial')).toBe('argon')
    expect(modelFamilyOf('gemini-3.8-flash-tiered')).toBe('google')
    expect(modelFamilyOf('claude-sonnet-4-6')).toBe('anthropic')
    expect(modelFamilyOf('gpt-oss-120b-medium')).toBe('openai')
    expect(modelFamilyOf('chat_20706')).toBeUndefined()
    expect(modelFamilyOf(null)).toBeUndefined()
    expect(modelFamilyOf(undefined)).toBeUndefined()
  })

  it('classifies a group from its machine-readable bucket ids, then its label', () => {
    expect(groupFamily(GEMINI())).toBe('google')
    expect(groupFamily(CLAUDE())).toBe('anthropic')
    expect(groupFamily(ARGON())).toBe('argon')
    // An unknown bucket vocabulary falls back to the label.
    expect(groupFamily({ name: 'Gemini 4 Argon', windows: [window_('wtu-7d', 'weekly', 0.4)] })).toBe('argon')
    expect(groupFamily({ name: 'Mystery', windows: [window_('x-5h', '5h', 0.4)] })).toBeUndefined()
  })
})

describe('rotation groups', () => {
  it('auto skips every group whose weekly budget the pool has benched', () => {
    // 2%, 0% and 41%: only Claude's spent week (and anything at or below the
    // pool's 1% threshold) is skipped, so Gemini's real 2% and Argon's 41% both
    // rotate. The skipped group is the one a request can no longer be served from.
    expect(rotationGroups(POOL, BADGE_GROUP_AUTO, NOW).map((group) => group.name))
      .toEqual(['Gemini Models', 'Gemini 4 Argon'])
    // The switch OFF admits them back, upstream order intact.
    expect(rotationGroups(POOL, 'auto', NOW, false).map((group) => group.name))
      .toEqual(['Gemini Models', 'Claude and GPT models', 'Gemini 4 Argon'])
    // Nothing drained: every group rotates, so all budgets get a turn.
    const refilled = POOL.map((group) => ({ ...group, windows: group.windows.map((w) => ({ ...w, remainingFraction: 1 })) }))
    expect(rotationGroups(refilled, 'auto', NOW).length).toBe(3)
  })

  it('pins a manual group even when its weekly is drained', () => {
    // The user chose to watch it; swapping it out for a healthier one would
    // answer a question nobody asked.
    const pinned = rotationGroups(POOL, 'Claude and GPT models', NOW)
    expect(pinned.map((group) => group.name)).toEqual(['Claude and GPT models'])
    // By family label, and case-insensitively.
    expect(rotationGroups(POOL, 'claude', NOW).map((group) => group.name)).toEqual(['Claude and GPT models'])
    expect(rotationGroups(POOL, 'gemini', NOW).map((group) => group.name)).toEqual(['Gemini Models'])
    // A stored value upstream no longer reports degrades to the first group
    // rather than to a blank badge.
    expect(rotationGroups(POOL, 'Retired Models', NOW).map((group) => group.name)).toEqual(['Gemini Models'])
  })

  it('has no rotation for an account with no measured groups', () => {
    expect(rotationGroups(null, 'auto', NOW)).toEqual([])
    expect(rotationGroups([], 'auto', NOW)).toEqual([])
    expect(limitsOf(undefined)).toEqual([])
  })

  it('cycles groups on the render phase and wraps', () => {
    const groups = POOL
    expect(groupAtPhase(groups, 0)?.name).toBe('Gemini Models')
    expect(groupAtPhase(groups, 1)?.name).toBe('Claude and GPT models')
    expect(groupAtPhase(groups, 2)?.name).toBe('Gemini 4 Argon')
    expect(groupAtPhase(groups, 3)?.name).toBe('Gemini Models')
    expect(groupAtPhase([], 7)).toBeNull()
  })

  it('alternates 5h and weekly when both exist, and shows the only kind a sparse group has', () => {
    const gemini = GEMINI()
    const argon = ARGON()
    expect(windowForPhase(gemini, 0, 'both', NOW)).toBe('5h')
    expect(windowForPhase(gemini, 1, 'both', NOW)).toBe('weekly')
    expect(windowForPhase(gemini, 2, 'both', NOW)).toBe('5h')
    // The Argon group is weekly-only. A PIN to 5h must not strand it on an em
    // dash, so the pin falls back to the window the group actually reports; the
    // alternating mode keeps its own parity because the caller reads whichever
    // window it names.
    expect(windowForPhase(argon, 0, 'both', NOW)).toBe('5h')
    expect(windowForPhase(argon, 0, '5h', NOW)).toBe('weekly')
    expect(windowForPhase(argon, 0, 'weekly', NOW)).toBe('weekly')
    // A 5h-only group under a weekly pin likewise falls back to what it reports.
    const fiveHourOnly = { name: 'g', windows: [window_('g-5h', '5h', 0.5, at(30))] }
    expect(windowForPhase(fiveHourOnly, 0, 'weekly', NOW)).toBe('5h')
  })
})

describe('live window readings', () => {
  it('refills to 100% once the reset moment has passed', () => {
    expect(liveFraction(0.02, at(60), NOW)).toBe(0.02)
    expect(liveFraction(0.02, at(-60), NOW)).toBe(1)
  })

  it('keeps a reading with no reset moment and reports unmeasured as null', () => {
    // No reset is not the same as a passed reset.
    expect(liveFraction(0.31, null, NOW)).toBe(0.31)
    expect(liveFraction(null, at(60), NOW)).toBeNull()
    expect(readWindowAt(ARGON(), '5h', NOW)).toBeNull()
    expect(readWindowAt(ARGON(), 'weekly', NOW)).toBe(0.41409934)
    expect(readWindowAt(null, 'weekly', NOW)).toBeNull()
  })

  it('judges drained on the pool\'s own weekly threshold, not on exactly zero', () => {
    expect(isGroupWeeklyDrained(CLAUDE(), NOW)).toBe(true) // 0%
    expect(isGroupWeeklyDrained(GEMINI(), NOW)).toBe(false) // 2% is real runway at a 1% threshold
    expect(isGroupWeeklyDrained(ARGON(), NOW)).toBe(false) // 41%

    const atThreshold = { name: 'g', windows: [window_('g-weekly', 'weekly', WEEKLY_QUOTA_THRESHOLD, at(60))] }
    expect(isGroupWeeklyDrained(atThreshold, NOW)).toBe(true)
    // A spent week whose reset has PASSED is a period that ended, not one we are in.
    const refilled = { name: 'g', windows: [window_('g-weekly', 'weekly', 0, at(-30))] }
    expect(isGroupWeeklyDrained(refilled, NOW)).toBe(false)
  })
})

