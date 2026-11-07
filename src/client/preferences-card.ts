/**
 * Preferences card for Antigravity settings.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Input, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { h } from './element.ts'
import { card } from './components.ts'
import type { AccountView, AgyRpcClient } from '../rpc-contract.ts'
import { ACTION_MESSAGE_TTL_MS, type T } from './types.ts'
import {
  DEFAULT_BADGE_DETAILED_MODE,
  DEFAULT_BADGE_MODEL_GROUP,
  DEFAULT_BADGE_SKIP_ZERO_WEEKLY,
  DEFAULT_BADGE_WINDOW_TYPE,
  DEFAULT_QUOTA_REFRESH_MINUTES,
  DEFAULT_AUTO_ROTATE_ACCOUNTS,
  DEFAULT_SMART_MODE,
  QUOTA_REFRESH_MAX_MINUTES,
  QUOTA_REFRESH_MIN_MINUTES,
  type BadgeWindowType,
} from '../ui-prefs-types.ts'

export function PreferencesCard(props: {
  rpc: AgyRpcClient
  t: T
  accounts?: AccountView[]
  onBadgePrefChange?: (enabled: boolean) => void
  onDetailedPrefChange?: (enabled: boolean) => void
}): ReactNode {
  const { rpc, t, accounts, onBadgePrefChange, onDetailedPrefChange } = props
  const [badgeEnabled, setBadgeEnabled] = useState(false)
  const [detailedReset, setDetailedReset] = useState(false)
  const [badgeDetailedMode, setBadgeDetailedMode] = useState(DEFAULT_BADGE_DETAILED_MODE)
  const [badgeModelGroup, setBadgeModelGroup] = useState<string>(DEFAULT_BADGE_MODEL_GROUP)
  const [badgeWindowType, setBadgeWindowType] = useState<BadgeWindowType>(DEFAULT_BADGE_WINDOW_TYPE)
  const [badgeSkipZeroWeekly, setBadgeSkipZeroWeekly] = useState(DEFAULT_BADGE_SKIP_ZERO_WEEKLY)
  const [smartMode, setSmartMode] = useState(DEFAULT_SMART_MODE)
  const [autoRotateAccounts, setAutoRotateAccounts] = useState(DEFAULT_AUTO_ROTATE_ACCOUNTS)
  const [refreshMinutes, setRefreshMinutes] = useState<number | null>(DEFAULT_QUOTA_REFRESH_MINUTES)
  const [minutesDraft, setMinutesDraft] = useState(String(DEFAULT_QUOTA_REFRESH_MINUTES))
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const errorTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => {
    if (errorTimer.current !== undefined) clearTimeout(errorTimer.current)
  }, [])

  const detailedPrefRef = useRef(onDetailedPrefChange)
  useEffect(() => {
    detailedPrefRef.current = onDetailedPrefChange
  })

  useEffect(() => {
    let active = true
    void rpc.call('ui.prefs.get', {}).then((prefs) => {
      if (active) {
        setBadgeEnabled(prefs?.conversationBadge === true)
        setDetailedReset(prefs?.detailedQuotaReset === true)
        const minutes = prefs === null ? DEFAULT_QUOTA_REFRESH_MINUTES : prefs.quotaRefreshMinutes
        setRefreshMinutes(minutes)
        setMinutesDraft(minutes === null ? '' : String(minutes))
        setBadgeDetailedMode(prefs?.badgeDetailedMode === true)
        setBadgeModelGroup(prefs?.badgeModelGroup ?? DEFAULT_BADGE_MODEL_GROUP)
        setBadgeWindowType(prefs?.badgeWindowType ?? DEFAULT_BADGE_WINDOW_TYPE)
        setBadgeSkipZeroWeekly(prefs?.badgeSkipZeroWeekly ?? DEFAULT_BADGE_SKIP_ZERO_WEEKLY)
        setSmartMode(prefs?.smartMode ?? DEFAULT_SMART_MODE)
        setAutoRotateAccounts(prefs?.autoRotateAccounts ?? DEFAULT_AUTO_ROTATE_ACCOUNTS)
        detailedPrefRef.current?.(prefs?.detailedQuotaReset === true)
        setLoading(false)
      }
    }).catch(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [rpc])

  const toggleAutoRotateAccounts = useCallback(async (checked: boolean) => {
    setSaving(true)
    setAutoRotateAccounts(checked)
    if (errorTimer.current !== undefined) clearTimeout(errorTimer.current)
    try {
      const res = await rpc.call('ui.prefs.set', { autoRotateAccounts: checked })
      setAutoRotateAccounts(res.autoRotateAccounts)
      setSaveError(null)
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('agy:ui-prefs-changed', { detail: res }))
      }
    } catch (err) {
      setAutoRotateAccounts(!checked)
      setSaveError(t('prefSaveFailed', { message: err instanceof Error ? err.message : String(err) }))
      errorTimer.current = setTimeout(() => setSaveError(null), ACTION_MESSAGE_TTL_MS)
    } finally {
      setSaving(false)
    }
  }, [rpc, t])

  const toggleBadge = useCallback(async (checked: boolean) => {
    setSaving(true)
    setBadgeEnabled(checked)
    if (errorTimer.current !== undefined) clearTimeout(errorTimer.current)
    try {
      const res = await rpc.call('ui.prefs.set', { conversationBadge: checked })
      setBadgeEnabled(res.conversationBadge)
      setSaveError(null)
      onBadgePrefChange?.(res.conversationBadge)
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('agy:ui-prefs-changed', { detail: res }))
      }
    } catch (err) {
      setBadgeEnabled(!checked)
      setSaveError(t('prefSaveFailed', { message: err instanceof Error ? err.message : String(err) }))
      errorTimer.current = setTimeout(() => setSaveError(null), ACTION_MESSAGE_TTL_MS)
    } finally {
      setSaving(false)
    }
  }, [rpc, t, onBadgePrefChange])

  const toggleDetailed = useCallback(async (checked: boolean) => {
    setSaving(true)
    setDetailedReset(checked)
    if (errorTimer.current !== undefined) clearTimeout(errorTimer.current)
    try {
      const res = await rpc.call('ui.prefs.set', { detailedQuotaReset: checked })
      setDetailedReset(res.detailedQuotaReset)
      setSaveError(null)
      onDetailedPrefChange?.(res.detailedQuotaReset)
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('agy:ui-prefs-changed', { detail: res }))
      }
    } catch (err) {
      setDetailedReset(!checked)
      setSaveError(t('prefSaveFailed', { message: err instanceof Error ? err.message : String(err) }))
      errorTimer.current = setTimeout(() => setSaveError(null), ACTION_MESSAGE_TTL_MS)
    } finally {
      setSaving(false)
    }
  }, [rpc, t, onDetailedPrefChange])

  const toggleDetailedMode = useCallback(async (checked: boolean) => {
    setSaving(true)
    setBadgeDetailedMode(checked)
    if (errorTimer.current !== undefined) clearTimeout(errorTimer.current)
    try {
      const res = await rpc.call('ui.prefs.set', { badgeDetailedMode: checked })
      setBadgeDetailedMode(res.badgeDetailedMode)
      setSaveError(null)
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('agy:ui-prefs-changed', { detail: res }))
      }
    } catch (err) {
      setBadgeDetailedMode(!checked)
      setSaveError(t('prefSaveFailed', { message: err instanceof Error ? err.message : String(err) }))
      errorTimer.current = setTimeout(() => setSaveError(null), ACTION_MESSAGE_TTL_MS)
    } finally {
      setSaving(false)
    }
  }, [rpc, t])

  const saveBadgeModelGroup = useCallback(async (group: string) => {
    setSaving(true)
    const prev = badgeModelGroup
    setBadgeModelGroup(group)
    if (errorTimer.current !== undefined) clearTimeout(errorTimer.current)
    try {
      const res = await rpc.call('ui.prefs.set', { badgeModelGroup: group })
      setBadgeModelGroup(res.badgeModelGroup)
      setSaveError(null)
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('agy:ui-prefs-changed', { detail: res }))
      }
    } catch (err) {
      setBadgeModelGroup(prev)
      setSaveError(t('prefSaveFailed', { message: err instanceof Error ? err.message : String(err) }))
      errorTimer.current = setTimeout(() => setSaveError(null), ACTION_MESSAGE_TTL_MS)
    } finally {
      setSaving(false)
    }
  }, [rpc, t, badgeModelGroup])

  const saveBadgeWindowType = useCallback(async (type: BadgeWindowType) => {
    setSaving(true)
    const prev = badgeWindowType
    setBadgeWindowType(type)
    if (errorTimer.current !== undefined) clearTimeout(errorTimer.current)
    try {
      const res = await rpc.call('ui.prefs.set', { badgeWindowType: type })
      setBadgeWindowType(res.badgeWindowType)
      setSaveError(null)
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('agy:ui-prefs-changed', { detail: res }))
      }
    } catch (err) {
      setBadgeWindowType(prev)
      setSaveError(t('prefSaveFailed', { message: err instanceof Error ? err.message : String(err) }))
      errorTimer.current = setTimeout(() => setSaveError(null), ACTION_MESSAGE_TTL_MS)
    } finally {
      setSaving(false)
    }
  }, [rpc, t, badgeWindowType])

  const toggleSkipZeroWeekly = useCallback(async (checked: boolean) => {
    setSaving(true)
    setBadgeSkipZeroWeekly(checked)
    if (errorTimer.current !== undefined) clearTimeout(errorTimer.current)
    try {
      const res = await rpc.call('ui.prefs.set', { badgeSkipZeroWeekly: checked })
      setBadgeSkipZeroWeekly(res.badgeSkipZeroWeekly)
      setSaveError(null)
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('agy:ui-prefs-changed', { detail: res }))
      }
    } catch (err) {
      setBadgeSkipZeroWeekly(!checked)
      setSaveError(t('prefSaveFailed', { message: err instanceof Error ? err.message : String(err) }))
      errorTimer.current = setTimeout(() => setSaveError(null), ACTION_MESSAGE_TTL_MS)
    } finally {
      setSaving(false)
    }
  }, [rpc, t])

  const toggleSmartMode = useCallback(async (checked: boolean) => {
    setSaving(true)
    setSmartMode(checked)
    if (errorTimer.current !== undefined) clearTimeout(errorTimer.current)
    try {
      const res = await rpc.call('ui.prefs.set', { smartMode: checked })
      setSmartMode(res.smartMode)
      setSaveError(null)
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('agy:ui-prefs-changed', { detail: res }))
      }
    } catch (err) {
      setSmartMode(!checked)
      setSaveError(t('prefSaveFailed', { message: err instanceof Error ? err.message : String(err) }))
      errorTimer.current = setTimeout(() => setSaveError(null), ACTION_MESSAGE_TTL_MS)
    } finally {
      setSaving(false)
    }
  }, [rpc, t])

  const saveRefreshMinutes = useCallback(async (minutes: number | null) => {
    setSaving(true)
    const prev = refreshMinutes
    const prevDraft = minutesDraft
    setRefreshMinutes(minutes)
    if (minutes !== null) setMinutesDraft(String(minutes))
    if (errorTimer.current !== undefined) clearTimeout(errorTimer.current)
    try {
      const res = await rpc.call('ui.prefs.set', { quotaRefreshMinutes: minutes })
      setRefreshMinutes(res.quotaRefreshMinutes)
      setSaveError(null)
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('agy:ui-prefs-changed', { detail: res }))
      }
    } catch (err) {
      setRefreshMinutes(prev)
      setMinutesDraft(prevDraft)
      setSaveError(t('prefSaveFailed', { message: err instanceof Error ? err.message : String(err) }))
      errorTimer.current = setTimeout(() => setSaveError(null), ACTION_MESSAGE_TTL_MS)
    } finally {
      setSaving(false)
    }
  }, [rpc, t, refreshMinutes, minutesDraft])

  const toggleAutoRefresh = useCallback(async (checked: boolean) => {
    if (!checked) {
      await saveRefreshMinutes(null)
      return
    }
    const parsed = Number.parseInt(minutesDraft, 10)
    const minutes = Number.isInteger(parsed)
      && parsed >= QUOTA_REFRESH_MIN_MINUTES
      && parsed <= QUOTA_REFRESH_MAX_MINUTES
      ? parsed
      : DEFAULT_QUOTA_REFRESH_MINUTES
    setMinutesDraft(String(minutes))
    await saveRefreshMinutes(minutes)
  }, [minutesDraft, saveRefreshMinutes])

  const commitMinutesDraft = useCallback(() => {
    if (refreshMinutes === null) return
    const parsed = Number.parseInt(minutesDraft, 10)
    if (!Number.isInteger(parsed) || parsed < QUOTA_REFRESH_MIN_MINUTES || parsed > QUOTA_REFRESH_MAX_MINUTES) {
      setSaveError(t('prefQuotaRefreshInvalid'))
      errorTimer.current = setTimeout(() => setSaveError(null), ACTION_MESSAGE_TTL_MS)
      setMinutesDraft(String(refreshMinutes))
      return
    }
    if (parsed === refreshMinutes) return
    void saveRefreshMinutes(parsed)
  }, [minutesDraft, refreshMinutes, t, saveRefreshMinutes])

  const activeAccount = accounts?.find((a) => a.active) ?? accounts?.[0]
  const availableGroups = (activeAccount?.limits ?? accounts?.flatMap((a) => a.limits ?? []) ?? [])
    .filter((g, idx, arr) => arr.findIndex((x) => x.name === g.name) === idx)

  const autoRotateRow = h('div', { className: 'agy-pref-row', key: 'autoRotate' },
    h('div', { className: 'agy-pref-info' },
      h('div', { className: 'agy-pref-name' }, t('prefAutoRotateAccounts')),
      h('div', { className: 'agy-pref-desc' }, t('prefAutoRotateAccountsDesc'))),
    h(Switch, {
      label: t('prefAutoRotateAccounts'),
      checked: autoRotateAccounts,
      disabled: loading || saving,
      onChange: (checked: boolean) => void toggleAutoRotateAccounts(checked),
    }))

  const detailedResetRow = h('div', { className: 'agy-pref-row', key: 'detailed' },
    h('div', { className: 'agy-pref-info' },
      h('div', { className: 'agy-pref-name' }, t('prefDetailedQuotaReset')),
      h('div', { className: 'agy-pref-desc' }, t('prefDetailedQuotaResetDesc'))),
    h(Switch, {
      label: t('prefDetailedQuotaReset'),
      checked: detailedReset,
      disabled: loading || saving,
      onChange: (checked: boolean) => void toggleDetailed(checked),
    }))

  const refreshRow = h('div', { className: 'agy-pref-row', key: 'refresh' },
    h('div', { className: 'agy-pref-info' },
      h('div', { className: 'agy-pref-name' }, t('prefQuotaRefresh')),
      h('div', { className: 'agy-pref-desc' }, t('prefQuotaRefreshDesc'))),
    h('div', { className: 'agy-pref-refresh' },
      h(Input, {
        value: minutesDraft,
        placeholder: t('prefQuotaRefreshNever'),
        inputMode: 'numeric',
        disabled: loading || saving || refreshMinutes === null,
        title: t('prefQuotaRefreshInterval'),
        'aria-label': t('prefQuotaRefreshInterval'),
        onChange: (event: { target: { value: string } }) => { setMinutesDraft(event.target.value) },
        onBlur: commitMinutesDraft,
        onKeyDown: (event: { key: string }) => { if (event.key === 'Enter') commitMinutesDraft() },
      }),
      ...(refreshMinutes !== null
        ? [h('span', { className: 'agy-pref-unit', key: 'unit' }, t('prefQuotaRefreshUnit'))]
        : []),
      h(Switch, {
        label: t('prefQuotaRefresh'),
        checked: refreshMinutes !== null,
        disabled: loading || saving,
        onChange: (checked: boolean) => void toggleAutoRefresh(checked),
      })))

  const smartModeRow = refreshMinutes !== null
    ? h('div', { className: 'agy-pref-row agy-pref-subrow', key: 'smartMode' },
        h('div', { className: 'agy-pref-info' },
          h('div', { className: 'agy-pref-name' }, t('prefSmartMode')),
          h('div', { className: 'agy-pref-desc' }, t('prefSmartModeDesc'))),
        h(Switch, {
          label: t('prefSmartMode'),
          checked: smartMode,
          disabled: loading || saving,
          onChange: (checked: boolean) => void toggleSmartMode(checked),
        }))
    : null

  const badgeRow = h('div', { className: 'agy-pref-row', key: 'badge' },
    h('div', { className: 'agy-pref-info' },
      h('div', { className: 'agy-pref-name' }, t('prefConversationBadge')),
      h('div', { className: 'agy-pref-desc' }, t('prefConversationBadgeDesc'))),
    h(Switch, {
      label: t('prefConversationBadge'),
      checked: badgeEnabled,
      disabled: loading || saving,
      onChange: (checked: boolean) => void toggleBadge(checked),
    }))

  const detailedModeRow = badgeEnabled
    ? h('div', { className: 'agy-pref-row agy-pref-subrow', key: 'detailedMode' },
        h('div', { className: 'agy-pref-info' },
          h('div', { className: 'agy-pref-name' }, t('prefBadgeDetailedMode')),
          h('div', { className: 'agy-pref-desc' }, t('prefBadgeDetailedModeDesc'))),
        h(Switch, {
          label: t('prefBadgeDetailedMode'),
          checked: badgeDetailedMode,
          disabled: loading || saving,
          onChange: (checked: boolean) => void toggleDetailedMode(checked),
        }))
    : null

  const modelGroupRow = badgeEnabled && badgeDetailedMode
    ? h('div', { className: 'agy-pref-row agy-pref-subrow agy-pref-subrow-nested', key: 'modelGroup' },
        h('div', { className: 'agy-pref-info' },
          h('div', { className: 'agy-pref-name' }, t('prefBadgeModelGroup'))),
        h('select', {
          className: 'agy-select agy-pref-select',
          value: badgeModelGroup,
          disabled: loading || saving,
          title: t('prefBadgeModelGroup'),
          'aria-label': t('prefBadgeModelGroup'),
          onChange: (e: { target: { value: string } }) => void saveBadgeModelGroup(e.target.value),
        },
        h('option', { value: 'auto' }, t('prefBadgeModelGroupAuto')),
        ...availableGroups.map((g) => h('option', { key: g.name, value: g.name }, g.name))))
    : null

  const windowTypeRow = badgeEnabled && badgeDetailedMode
    ? h('div', { className: 'agy-pref-row agy-pref-subrow agy-pref-subrow-nested', key: 'windowType' },
        h('div', { className: 'agy-pref-info' },
          h('div', { className: 'agy-pref-name' }, t('prefBadgeWindowType'))),
        h('select', {
          className: 'agy-select agy-pref-select',
          value: badgeWindowType,
          disabled: loading || saving,
          title: t('prefBadgeWindowType'),
          'aria-label': t('prefBadgeWindowType'),
          onChange: (e: { target: { value: string } }) => void saveBadgeWindowType(e.target.value as BadgeWindowType),
        },
        h('option', { value: 'both' }, t('prefBadgeWindowBoth')),
        h('option', { value: '5h' }, t('prefBadgeWindow5h')),
        h('option', { value: 'weekly' }, t('prefBadgeWindowWeekly'))))
    : null

  const skipZeroWeeklyRow = badgeEnabled && badgeDetailedMode && badgeWindowType === 'both'
    ? h('div', { className: 'agy-pref-row agy-pref-subrow agy-pref-subrow-nested', key: 'skipZeroWeekly' },
        h('div', { className: 'agy-pref-info' },
          h('div', { className: 'agy-pref-name' }, t('prefBadgeSkipZeroWeekly')),
          h('div', { className: 'agy-pref-desc' }, t('prefBadgeSkipZeroWeeklyDesc'))),
        h(Switch, {
          label: t('prefBadgeSkipZeroWeekly'),
          checked: badgeSkipZeroWeekly,
          disabled: loading || saving,
          onChange: (checked: boolean) => void toggleSkipZeroWeekly(checked),
        }))
    : null

  return card(t('prefTitle'),
    h('div', null,
      h('div', { className: 'agy-pref-group', key: 'groupRotation' },
        h('div', { className: 'agy-pref-group-title' }, t('prefGroupRotation')),
        autoRotateRow),
      h('div', { className: 'agy-pref-group', key: 'groupRefresh' },
        h('div', { className: 'agy-pref-group-title' }, t('prefGroupRefresh')),
        refreshRow,
        ...(smartModeRow ? [smartModeRow] : []),
        detailedResetRow),
      h('div', { className: 'agy-pref-group', key: 'groupBadge' },
        h('div', { className: 'agy-pref-group-title' }, t('prefGroupBadge')),
        badgeRow,
        ...(detailedModeRow ? [detailedModeRow] : []),
        ...(modelGroupRow ? [modelGroupRow] : []),
        ...(windowTypeRow ? [windowTypeRow] : []),
        ...(skipZeroWeeklyRow ? [skipZeroWeeklyRow] : [])),
      saveError === null ? null : h('div', { className: 'agy-error' }, saveError)))
}
