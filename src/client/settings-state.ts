/**
 * State management, auto-refresh cadences, smart mode pause handling,
 * and timed notification channels for the Settings section.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { installAgyStyles } from './styles.ts'
import {
  isSmartModeIdle,
  lastModelUsedTime,
  limitsOlderThanInterval,
  isAccountAllQuotaExhausted,
  accountRecoveryTime,
} from './quota-view.ts'
import type {
  AccountView,
  AgyRpcClient,
  AgyRpcResult,
  ModelView,
  StatsView,
  UiPrefsView,
} from '../rpc-contract.ts'
import { DEFAULT_QUOTA_REFRESH_MINUTES, DEFAULT_SMART_MODE } from '../ui-prefs-types.ts'
import {
  ACTION_MESSAGE_TTL_MS,
  POOL_POLL_INTERVAL_MS,
  type T,
  type TabId,
} from './types.ts'

export interface UseAgySettingsStateOptions {
  rpc: AgyRpcClient
  t: T
}

export function useAgySettingsState(options: UseAgySettingsStateOptions) {
  const { rpc, t } = options
  const [detailedQuotaReset, setDetailedQuotaReset] = useState(false)
  const [quotaRefreshMinutes, setQuotaRefreshMinutes] = useState<number | null>(DEFAULT_QUOTA_REFRESH_MINUTES)
  const refreshMinutesRef = useRef<number | null>(DEFAULT_QUOTA_REFRESH_MINUTES)
  useEffect(() => { refreshMinutesRef.current = quotaRefreshMinutes }, [quotaRefreshMinutes])

  const smartModeRef = useRef(DEFAULT_SMART_MODE)
  const [smartPausedUntil, setSmartPausedUntil] = useState<number | null>(null)
  const smartPausedUntilRef = useRef<number | null>(null)
  const lastModelUsedRef = useRef<number | null>(null)
  const [smartIdlePaused, setSmartIdlePaused] = useState<boolean>(false)
  const smartIdlePausedRef = useRef<boolean>(false)

  const [tab, setTab] = useState<TabId>('accounts')
  const [accounts, setAccounts] = useState<AccountView[]>([])
  const accountsRef = useRef<AccountView[]>(accounts)
  useEffect(() => { accountsRef.current = accounts })

  const [models, setModels] = useState<ModelView[]>([])
  const [modelAccount, setModelAccount] = useState<string | null>(null)
  const [modelError, setModelError] = useState<string | undefined>(undefined)
  const [toggling, setToggling] = useState<ReadonlySet<string>>(() => new Set())
  const [modelTesting, setModelTesting] = useState<ReadonlySet<string>>(() => new Set())
  const [stats, setStats] = useState<StatsView | null>(null)
  const [poolBusy, setPoolBusy] = useState<AgyRpcResult<'pool.status'>['busy']>([])
  const [error, setError] = useState<string | undefined>(undefined)
  const [notice, setNoticeState] = useState<string | undefined>(undefined)
  const [actionError, setActionErrorState] = useState<string | undefined>(undefined)

  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const alive = useRef(true)

  useEffect(() => {
    installAgyStyles()
    void rpc.call('ui.prefs.get', {}).then((prefs) => {
      if (alive.current && prefs) {
        setDetailedQuotaReset(prefs.detailedQuotaReset === true)
        if (prefs.quotaRefreshMinutes !== undefined) setQuotaRefreshMinutes(prefs.quotaRefreshMinutes)
        smartModeRef.current = prefs.smartMode ?? DEFAULT_SMART_MODE
      }
    }).catch(() => {})
    const onPrefsChange = (e: Event): void => {
      const detail = (e as CustomEvent<UiPrefsView>).detail
      if (detail?.quotaRefreshMinutes !== undefined && alive.current) {
        setQuotaRefreshMinutes(detail.quotaRefreshMinutes)
        if (detail.quotaRefreshMinutes === null) {
          if (smartPausedUntilRef.current !== null) {
            smartPausedUntilRef.current = null
            setSmartPausedUntil(null)
          }
          if (smartIdlePausedRef.current) {
            smartIdlePausedRef.current = false
            setSmartIdlePaused(false)
          }
        }
      }
      if (typeof detail?.smartMode === 'boolean' && alive.current) {
        smartModeRef.current = detail.smartMode
      }
    }
    window.addEventListener('agy:ui-prefs-changed', onPrefsChange)
    return () => { window.removeEventListener('agy:ui-prefs-changed', onPrefsChange) }
  }, [rpc])

  const timedChannel = (
    timer: { current: ReturnType<typeof setTimeout> | undefined },
    set: (text: string | undefined) => void,
  ): ((text: string | undefined) => void) => (text) => {
    if (timer.current !== undefined) clearTimeout(timer.current)
    timer.current = undefined
    set(text)
    if (text === undefined) return
    timer.current = setTimeout(() => {
      timer.current = undefined
      if (alive.current) set(undefined)
    }, ACTION_MESSAGE_TTL_MS)
  }

  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const actionErrorTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const setNotice = useCallback(timedChannel(noticeTimer, setNoticeState), [])
  const setActionError = useCallback(timedChannel(actionErrorTimer, setActionErrorState), [])

  useEffect(() => () => {
    if (noticeTimer.current !== undefined) clearTimeout(noticeTimer.current)
    if (actionErrorTimer.current !== undefined) clearTimeout(actionErrorTimer.current)
  }, [])

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const refresh = useCallback(async () => {
    const [accountOutcome, statsOutcome] = await Promise.allSettled([
      rpc.call('account.list', {}),
      rpc.call('stats.get', {}),
    ])
    if (!alive.current) return
    if (accountOutcome.status === 'fulfilled') {
      setAccounts(accountOutcome.value.accounts)
      if (accountOutcome.value.lastModelUsedAt) {
        lastModelUsedRef.current = accountOutcome.value.lastModelUsedAt
      } else if (lastModelUsedRef.current === null) {
        lastModelUsedRef.current = lastModelUsedTime(accountOutcome.value.accounts)
      }
    }
    if (statsOutcome.status === 'fulfilled') setStats(statsOutcome.value)
    const failed = [accountOutcome, statsOutcome].find((outcome) => outcome.status === 'rejected')
    if (failed?.status === 'rejected') {
      const caught: unknown = failed.reason
      setError(caught instanceof Error ? caught.message : String(caught))
    } else {
      setError(undefined)
    }
    if (alive.current) setLoaded(true)
  }, [rpc])

  const loadLimits = useCallback(async (force = false, report = false, index?: number, auto = false) => {
    const intervalMinutes = refreshMinutesRef.current
    const isManual = report
    if (!isManual && smartModeRef.current && refreshMinutesRef.current !== null) {
      if (smartPausedUntilRef.current !== null) {
        const until = smartPausedUntilRef.current
        if (Date.now() < until) return
        smartPausedUntilRef.current = null
        setSmartPausedUntil(null)
      }
      if (isSmartModeIdle(lastModelUsedRef.current, Date.now())) {
        smartIdlePausedRef.current = true
        setSmartIdlePaused(true)
        return
      }
      if (smartIdlePausedRef.current) {
        smartIdlePausedRef.current = false
        setSmartIdlePaused(false)
        force = true
      }
    }
    try {
      const payload: { force?: boolean, index?: number } = force || index !== undefined
        ? { force: true, ...(index === undefined ? {} : { index }) }
        : {}
      let result = await rpc.call('account.limits', payload)
      if (!alive.current) return
      if (!force && index === undefined && intervalMinutes !== null) {
        const enabledIndexes = new Set(accountsRef.current
          .filter((account) => account.state !== 'disabled')
          .map((account) => account.index))
        const expired = limitsOlderThanInterval(
          result.limits
            .filter((entry) => enabledIndexes.has(entry.index))
            .map((entry) => entry.updatedAt),
          intervalMinutes,
          Date.now(),
        )
        if (expired) {
          result = await rpc.call('account.limits', { force: true })
          if (!alive.current) return
        }
      }
      const byIndex = new Map(result.limits.map((entry) => [entry.index, entry]))
      setAccounts((current) => current.map((account) => {
        const entry = byIndex.get(account.index)
        if (entry === undefined || entry.groups === null) return account
        return {
          ...account,
          limits: entry.groups,
          limitsUpdatedAt: entry.updatedAt,
          limitBurn: entry.burn ?? account.limitBurn,
        }
      }))
      if (auto && smartModeRef.current && refreshMinutesRef.current !== null && index !== undefined) {
        const entry = byIndex.get(index)
        const row = accountsRef.current.find((account) => account.index === index)
        if (entry?.groups && row) {
          const freshNow = Date.now()
          const freshView = { ...row, limits: entry.groups, limitsUpdatedAt: entry.updatedAt }
          if (isAccountAllQuotaExhausted(freshView, freshNow)) {
            const recoverAt = accountRecoveryTime(freshView, freshNow)
            if (recoverAt !== null) {
              smartPausedUntilRef.current = recoverAt
              setSmartPausedUntil(recoverAt)
            }
          } else if (smartPausedUntilRef.current !== null) {
            smartPausedUntilRef.current = null
            setSmartPausedUntil(null)
          }
        }
      }
      if (report) {
        if (result.failed > 0) setActionError(t('limitsRefreshFailed', { failed: result.failed }))
        else if (result.measured > 0) setNotice(t('limitsRefreshOk', { measured: result.measured }))
        else setNotice(t('limitsRefreshFresh'))
      }
    } catch (caught) {
      if (report) {
        setActionError(caught instanceof Error ? caught.message : String(caught))
      }
    }
  }, [rpc, setActionError, setNotice, t])

  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => {
    const tick = (): void => {
      if (document.hidden) return
      void rpc.call('pool.status', {})
        .then((result) => {
          if (alive.current) {
            setPoolBusy(result.busy)
            if (result.lastModelUsedAt) {
              lastModelUsedRef.current = result.lastModelUsedAt
              if (smartIdlePausedRef.current && !isSmartModeIdle(result.lastModelUsedAt, Date.now())) {
                smartIdlePausedRef.current = false
                setSmartIdlePaused(false)
                const active = accountsRef.current.find((candidate) => candidate.active) ?? accountsRef.current[0]
                void loadLimits(true, false, active?.index, true)
                window.dispatchEvent(new CustomEvent('agy:model-used', { detail: { at: result.lastModelUsedAt } }))
              }
            }
          }
        })
        .catch(() => {})
    }
    tick()
    const onModelUsed = (e: Event): void => {
      const at = (e as CustomEvent<{ at?: number }>).detail?.at ?? Date.now()
      lastModelUsedRef.current = at
      if (smartIdlePausedRef.current) {
        smartIdlePausedRef.current = false
        setSmartIdlePaused(false)
        const active = accountsRef.current.find((candidate) => candidate.active) ?? accountsRef.current[0]
        void loadLimits(true, false, active?.index, true)
      }
    }
    window.addEventListener('agy:model-used', onModelUsed)
    const timer = setInterval(tick, POOL_POLL_INTERVAL_MS)
    return () => {
      clearInterval(timer)
      window.removeEventListener('agy:model-used', onModelUsed)
    }
  }, [loadLimits, rpc])

  useEffect(() => {
    if (tab === 'accounts' && accounts.length > 0) {
      if (smartModeRef.current && refreshMinutesRef.current !== null && isSmartModeIdle(lastModelUsedRef.current, Date.now())) {
        return
      }
      void loadLimits()
    }
  }, [tab, accounts.length, loadLimits])

  useEffect(() => {
    if (tab !== 'accounts' || quotaRefreshMinutes === null) return
    const timer = setInterval(() => {
      if (!document.hidden && alive.current) {
        const active = accountsRef.current.find((candidate) => candidate.active) ?? accountsRef.current[0]
        void loadLimits(true, false, active?.index, true)
      }
    }, quotaRefreshMinutes * 60_000)
    return () => { clearInterval(timer) }
  }, [tab, quotaRefreshMinutes, loadLimits])

  const refreshAll = useCallback(() => {
    if (smartIdlePausedRef.current) {
      smartIdlePausedRef.current = false
      setSmartIdlePaused(false)
    }
    void refresh()
    if (tab === 'accounts') void loadLimits(true, true)
  }, [loadLimits, refresh, tab])

  const loadModels = useCallback(async () => {
    try {
      const result = await rpc.call('model.list', {})
      if (!alive.current) return
      setModels(result.models)
      setModelAccount(result.account)
      setModelError(undefined)
    } catch (caught) {
      if (!alive.current) return
      setModelError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [rpc])

  useEffect(() => { void loadModels() }, [loadModels])
  useEffect(() => {
    if (tab === 'models' && models.length === 0) void loadModels()
  }, [tab, models.length, loadModels])

  const act = useCallback(async (run: () => Promise<unknown>) => {
    setBusy(true)
    setNotice(undefined)
    try {
      await run()
      await refresh()
      setError(undefined)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      if (alive.current) setBusy(false)
    }
  }, [refresh, setNotice])

  const startLogin = useCallback(() => {
    setBusy(true)
    rpc.call('auth.url', {}).then((result) => {
      window.open(result.url, 'agy-oauth', 'width=520,height=680')
      setError(undefined)
    }).catch((caught: unknown) => {
      setError(caught instanceof Error ? caught.message : String(caught))
    }).finally(() => {
      if (alive.current) setBusy(false)
    })
  }, [rpc])

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (event.origin !== window.location.origin) return
      if ((event.data as { type?: string } | null)?.type === 'agy_login_success') void refresh()
    }
    window.addEventListener('message', onMessage)
    return () => { window.removeEventListener('message', onMessage) }
  }, [refresh])

  useEffect(() => {
    const onAccountChanged = (): void => {
      void refresh()
      void loadModels()
      void loadLimits(false)
    }
    window.addEventListener('agy:account-changed', onAccountChanged)
    return () => { window.removeEventListener('agy:account-changed', onAccountChanged) }
  }, [loadLimits, loadModels, refresh])

  const copyText = useCallback(async (text: string) => {
    await navigator.clipboard?.writeText(text)
  }, [])

  const runAction = useCallback(async (run: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setNotice(undefined)
    setActionError(undefined)
    try {
      await run()
    } catch (caught) {
      if (alive.current) {
        setActionError(caught instanceof Error ? caught.message : String(caught))
      }
    } finally {
      if (alive.current) setBusy(false)
    }
  }, [setActionError, setNotice])

  return {
    tab,
    setTab,
    accounts,
    setAccounts,
    models,
    setModels,
    modelAccount,
    modelError,
    toggling,
    setToggling,
    modelTesting,
    setModelTesting,
    stats,
    poolBusy,
    error,
    setError,
    notice,
    setNotice,
    actionError,
    setActionError,
    busy,
    loaded,
    detailedQuotaReset,
    setDetailedQuotaReset,
    smartPausedUntil,
    smartIdlePaused,
    alive,
    refresh,
    loadLimits,
    refreshAll,
    loadModels,
    act,
    startLogin,
    copyText,
    runAction,
  }
}
