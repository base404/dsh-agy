/**
 * agy Settings section — the browser half orchestrating entry point.
 *
 * One `settings.section` page with five tabs (accounts, models, config, usage,
 * credentials), replacing the standalone `/agy` dashboard. Every figure comes
 * from the `/api/agy` RPC over `ctx.connection`, so this section needs no
 * host-rendered page and there is no second UI to keep in step.
 *
 * Elements are built through the local `h` helper rather than JSX or nested
 * `createElement` calls: this package configures no JSX transform for the client
 * bundle, and `h(tag, props, ...children)` keeps the element tree flat and
 * readable where nested `createElement` calls become a parenthesis maze.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { installAgyStyles } from './styles.ts'
import { en, zh, type AgyLocaleKey } from './locales.ts'
import { h } from './element.ts'
import { AgyQuotaBadge } from './quota-badge.ts'
import {
  accountRecoveryTime,
  isAccountAllQuotaExhausted,
  isSmartModeIdle,
  lastModelUsedTime,
  limitsOlderThanInterval,
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
  createRpc,
  NS,
  type AccountHandlers,
  type ConnectionLike,
  type T,
  type TabId,
} from './types.ts'
import { button, card, hint } from './components.ts'
import {
  tokenText,
  throughputTokenPerSecond,
  truncateIdentity,
} from './formatting.ts'
import {
  canActivateAccount,
  resolveSelectedAccountIndex,
  AccountsTab,
} from './accounts-tab.ts'
import {
  ThinkingBudgetCard,
  MultimodalCard,
  ModelRoutingCard,
} from './config-cards.ts'
import { UsageTab } from './usage-tab.ts'
import { CredentialsTab } from './credentials-tab.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy owned by the Antigravity Settings section. */
    agy: AgyLocaleKey
  }

  /**
   * The Session header's action row.
   *
   * The face is OWNED by `@deepseek-ai/dsh-client-ui-conversation`, which this
   * package deliberately does not depend on.
   */
  interface SlotMap {
    'conversation.session.header.actions': {
      kind: 'list'
      scope: 'session'
      owner: Record<string, never>
    }
  }
}

export {
  tokenText,
  throughputTokenPerSecond,
  truncateIdentity,
  canActivateAccount,
  resolveSelectedAccountIndex,
}

/** Required browser services: the slot registry, dictionaries, and the RPC carrier. */
export const inject = ['slots', 'locale', 'connection']

/**
 * Order models for display: enabled first, disabled sunk to the bottom.
 *
 * Exported for a direct unit test — the rule is pure and worth pinning, and the
 * client test harness does not render. Stable by construction: `Array.sort` is
 * stable per spec, so the host's own order survives inside each group.
 */
export function orderModels(models: readonly ModelView[]): ModelView[] {
  return [...models].sort((a, b) => Number(a.disabled) - Number(b.disabled))
}

function ModelsTab(props: {
  models: ModelView[]
  account: string | null
  /** Model ids whose own toggle write is in flight; everything else stays live. */
  pending: ReadonlySet<string>
  /** Model ids whose own test call is in flight (see the per-row test button). */
  testing: ReadonlySet<string>
  onToggle: (modelId: string, disabled: boolean) => void
  /** Fire one test call against this exact model on the active account. */
  onTestModel: (modelId: string) => void
  t: T
}): ReactNode {
  const { models, account, pending, testing, onToggle, onTestModel, t } = props

  const ordered = useMemo(() => orderModels(models), [models])

  if (models.length === 0) {
    return card(t('modelsTitle'), h('div', { className: 'agy-empty' }, t('emptyModels')))
  }
  const hidden = models.filter((model) => model.disabled).length

  const rows = ordered.map((model) => h('div', { className: 'agy-rowitem', key: model.id },
    h('div', { className: 'agy-rowmain' },
      h('div', { className: 'agy-rowtitle' },
        h('span', { className: 'agy-rowname' }, model.name)),
      model.name === model.id
        ? null
        : h('div', { className: 'agy-rowmeta agy-mono' }, model.id)),
    h('div', { className: 'agy-rowactions' },
      button(testing.has(model.id) ? t('modelTesting') : t('actionTestModel'),
        () => { onTestModel(model.id) },
        { size: 'sm', variant: 'ghost', disabled: testing.has(model.id) }),
      h(Switch, {
        checked: !model.disabled,
        disabled: pending.has(model.id),
        label: t('modelToggleAria', { name: model.name }),
        onChange: () => { onToggle(model.id, !model.disabled) },
      }))))

  return h('div', { className: 'agy-root' },
    card(t('modelsTitle'), h('div', { className: 'agy-rows' }, ...rows),
      hidden > 0 ? t('modelsHiddenSuffix', { count: hidden }) : account ?? undefined),
    hint(t('modelsHelp')))
}

function ConfigTab(props: { rpc: AgyRpcClient, t: T }): ReactNode {
  const { rpc, t } = props
  return h('div', { className: 'agy-root' },
    h(ThinkingBudgetCard, { rpc, t }),
    h(MultimodalCard, { rpc, t }),
    h(ModelRoutingCard, { rpc, t }))
}

// ─── root ────────────────────────────────────────────────────────────────────

/** The Settings section body. */
export function AgySettings(props: {
  rpc: AgyRpcClient
  t: T
  lang?: string
  onBadgePrefChange?: (enabled: boolean) => void
}): ReactNode {
  const { rpc, t } = props
  const [detailedQuotaReset, setDetailedQuotaReset] = useState(false)
  // The auto-refresh interval the Preferences card owns (minutes; null =
  // never). ONE setting governs every automatic quota refresh in the plugin —
  // the header badge's timer AND this section's windows — so it is read here
  // too, and kept current through the same event the badge listens to.
  const [quotaRefreshMinutes, setQuotaRefreshMinutes] = useState<number | null>(DEFAULT_QUOTA_REFRESH_MINUTES)
  /** Read by `loadLimits` without joining its identity to every prefs save. */
  const refreshMinutesRef = useRef<number | null>(DEFAULT_QUOTA_REFRESH_MINUTES)
  useEffect(() => { refreshMinutesRef.current = quotaRefreshMinutes }, [quotaRefreshMinutes])
  // Smart mode: pause the accounts tab's automatic cadence while the ACTIVE
  // account has no usable window. The ref is what `loadLimits` reads; the
  // state drives the tab's paused note (recomputed on renders the existing
  // pool poll already triggers — no timer of its own).
  const smartModeRef = useRef(DEFAULT_SMART_MODE)
  const [smartPausedUntil, setSmartPausedUntil] = useState<number | null>(null)
  const smartPausedUntilRef = useRef<number | null>(null)
  const lastModelUsedRef = useRef<number | null>(null)
  const [smartIdlePaused, setSmartIdlePaused] = useState<boolean>(false)
  const smartIdlePausedRef = useRef<boolean>(false)
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
        // Smart pause is scoped to the interval being on: with "never" there is
        // no timer left to re-open a pause, so it ends here.
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
  const [tab, setTab] = useState<TabId>('accounts')
  const [accounts, setAccounts] = useState<AccountView[]>([])
  /** Mirrors `accounts` for `loadLimits` (see its staleness rule). */
  const accountsRef = useRef<AccountView[]>(accounts)
  useEffect(() => { accountsRef.current = accounts })
  const [models, setModels] = useState<ModelView[]>([])
  const [modelAccount, setModelAccount] = useState<string | null>(null)
  /** Model-discovery failure, shown on the Models tab only (see loadModels). */
  const [modelError, setModelError] = useState<string | undefined>(undefined)
  /** Model ids whose own visibility write is in flight (see the toggle handler). */
  const [toggling, setToggling] = useState<ReadonlySet<string>>(() => new Set())
  /** Model ids whose own test call is in flight (see the per-row test button). */
  const [modelTesting, setModelTesting] = useState<ReadonlySet<string>>(() => new Set())
  const [stats, setStats] = useState<StatsView | null>(null)
  /**
   * Accounts with upstream requests in flight, from the polled `pool.status`.
   *
   * A poll, not a push: the section has no push channel, and the call is a pure
   * in-memory read on the host. A failed poll is display-only and stays silent —
   * the previous frame (including "idle") holds until the next tick, which is
   * the honest degradation for a status line.
   */
  const [poolBusy, setPoolBusy] = useState<AgyRpcResult<'pool.status'>['busy']>([])
  const [error, setError] = useState<string | undefined>(undefined)
  /** A non-fatal outcome worth reporting (e.g. a partial credential import). */
  const [notice, setNoticeState] = useState<string | undefined>(undefined)
  /**
   * The outcome of a one-shot action, timed like `notice`.
   *
   * A SEPARATE channel from `error` on purpose. `error` is also where a failed
   * `refresh()` lands, and "the account list could not be loaded" is a standing
   * condition: auto-dismissing it would leave a broken page looking fine 3.5s
   * later. Only an action's own verdict is transient, because the user already
   * knows what they clicked and the screen returns to a valid state either way.
   */
  const [actionError, setActionErrorState] = useState<string | undefined>(undefined)

  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  /** Guards state updates after the section unmounts mid-request. */
  const alive = useRef(true)

  /**
   * Show a transient message, then clear it.
   *
   * A message that never clears is indistinguishable from a stuck UI: the model
   * test's "X is working." stayed on screen forever, through every later action.
   * The deleted dashboard's toasts auto-dismissed after 3.5s for the same
   * reason; this keeps that behaviour, and a newer message simply replaces the
   * pending timer.
   *
   * One factory rather than two near-identical setters: the timer bookkeeping is
   * the part that must not drift between the success and failure channels. It
   * takes the timer ref as an argument rather than creating one, because a
   * `useCallback(timedChannel(...))` argument is evaluated on EVERY render — the
   * discarded function would still have appended its timer to the cancel list.
   * @param timer - the ref owning this channel's pending dismissal.
   * @param set - the state setter this channel writes to.
   * @returns a setter that arms the dismissal timer.
   */
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

  /** Pending dismissal timers, one per channel, cancelled together on unmount. */
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const actionErrorTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const setNotice = useCallback(timedChannel(noticeTimer, setNoticeState), [])
  const setActionError = useCallback(timedChannel(actionErrorTimer, setActionErrorState), [])

  // Cancel every pending dismissal when the section unmounts.
  useEffect(() => () => {
    if (noticeTimer.current !== undefined) clearTimeout(noticeTimer.current)
    if (actionErrorTimer.current !== undefined) clearTimeout(actionErrorTimer.current)
  }, [])

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const refresh = useCallback(async () => {
    // Deliberately NOT `Promise.all` on both calls. `account.list` can be slow
    // (it reaches upstream for quota discovery), while `stats.get` is a pure
    // local file read that cannot be — pairing them meant one slow call blanked
    // BOTH views, showing "no accounts" and a permanent spinner for data that
    // was never in doubt. Each settles on its own, so the usage tab renders
    // even if accounts lag.
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
    // Surface a failure, but only after committing the successful halves, so a
    // partial failure still renders everything it can.
    const failed = [accountOutcome, statsOutcome].find((outcome) => outcome.status === 'rejected')
    if (failed?.status === 'rejected') {
      const caught: unknown = failed.reason
      setError(caught instanceof Error ? caught.message : String(caught))
    } else {
      setError(undefined)
    }
    if (alive.current) setLoaded(true)
  }, [rpc])

  /**
   * Refresh the 5h/weekly windows and merge them into the account rows.
   *
   * A separate call from `account.list` because that reply is deliberately
   * probe-free — folding an upstream call into it once made the whole view wait
   * on the network. Here the rows render immediately from `account.list` and the
   * windows fill in when they arrive, so a slow probe costs a placeholder.
   *
   * It also works for a pool of ANY size: the scheduling quota refresh is skipped
   * for a single enabled account (measuring that one could block the only
   * account), so this endpoint is the only thing that fills `cachedLimits` there.
   *
   * @param force - re-probe inside the TTL. An EXPLICIT refresh does this; an
   *   automatic one upgrades itself to a probe only when the snapshot it just
   *   read is older than the user's auto-refresh interval — ONE setting governs
   *   every automatic quota refresh in the plugin, so a page opened onto stale
   *   numbers re-measures instead of serving the host's longer-TTL cache.
   * @param report - whether to surface the outcome. Set only when the user asked
   *   for the refresh, since an automatic one must stay silent.
   * @param index - restrict the refresh to ONE account (the limits card's
   *   refresh button). An explicit per-account request forces the probe — the
   *   click must be able to deliver something newer than the TTL holds — while
   *   the merge below is already by index, so nothing else changes.
   */
  const loadLimits = useCallback(async (force = false, report = false, index?: number, auto = false) => {
    // The interval is read through a ref so this callback's identity (and the
    // mount/tab effects that key on it) does not churn on every prefs save.
    const intervalMinutes = refreshMinutesRef.current
    // Smart pause holds BEFORE any RPC — a paused tick is free — and re-opens
    // on the first tick at/after the recovery moment it was set from or when a model is reused.
    // Scoped to the interval being on: with "never" there is no timer left to re-open
    // a pause, so smart mode stays inert there.
    if (auto && smartModeRef.current && refreshMinutesRef.current !== null) {
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
      // Automatic full-pool load + a configured interval + a measured snapshot
      // older than it → one forced re-probe. Never-measured accounts stay out
      // (the host's non-forced pass already probes those), an explicit request
      // never double-probes, and a DISABLED row's frozen snapshot is not
      // evidence the pool went stale — the host never re-measures one, so
      // counting its age would force-probe on every load.
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
        // Leave the row untouched when this refresh learned nothing, so a failed
        // probe cannot erase windows that were already showing.
        if (entry === undefined || entry.groups === null) return account
        return {
          ...account,
          limits: entry.groups,
          limitsUpdatedAt: entry.updatedAt,
          // A null rate keeps the previous one: "these two samples saw no drop"
          // is not evidence the burn stopped.
          limitBurn: entry.burn ?? account.limitBurn,
        }
      }))
      // Smart pause, judged from the data THIS probe just brought back: the
      // observation and its confirmation are the same call, so pausing spends
      // no extra upstream request. Every measured group of the probed account
      // drained (weekly 0%, or all models' 5h 0%, or a mix — any shape where
      // NO model is usable) closes the cadence until the earliest group's
      // reset; ONE group becoming usable is what re-opens it. A recovery the
      // data cannot promise (no usable reset moment) keeps the regular
      // cadence — a pause with no end would freeze the tab on stale data.
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
      // An explicit refresh reports itself. Without this a forced probe that
      // failed changed nothing on screen — no new numbers, no new timestamp —
      // so the click looked inert. "Still fresh" and "probe failed" are
      // different facts and must not read the same.
      if (report) {
        if (result.failed > 0) setActionError(t('limitsRefreshFailed', { failed: result.failed }))
        else if (result.measured > 0) setNotice(t('limitsRefreshOk', { measured: result.measured }))
        else setNotice(t('limitsRefreshFresh'))
      }
    } catch (caught) {
      // Display-only in the automatic case: a failed refresh leaves the existing
      // windows in place and must never surface an error over the account list.
      if (report) {
        setActionError(caught instanceof Error ? caught.message : String(caught))
      }
    }
  }, [rpc, setActionError, setNotice, t])

  useEffect(() => { void refresh() }, [refresh])

  // The live line's poll. Runs for the section's lifetime — the interval is
  // cheap by design (one local read), and a hidden panel skips its ticks.
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
        .catch(() => { /* display-only; the next tick retries */ })
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
    // Only on the tab that shows them, and after the rows exist so the merge has
    // something to write into.
    //
    // TTL-respecting (no `force`): this fires on mount and whenever the account
    // COUNT changes, and neither is a request for fresh numbers — `loadLimits`
    // itself upgrades the automatic load to a forced probe when the snapshot is
    // older than the configured interval. Note the dependency is the LENGTH, so
    // a plain `refresh()` — which replaces the array without changing its
    // length — does not re-run this. That is why the toolbar's Refresh calls
    // `refreshAll` rather than relying on this effect.
    if (tab === 'accounts' && accounts.length > 0) void loadLimits()
  }, [tab, accounts.length, loadLimits])

  // While the accounts tab is showing the quota cards, the configured interval
  // governs them exactly as it governs the header badge's board: a tick
  // force-probes past the host's TTL. Leaving the tab — or the browser tab
  // hiding — stops the cadence, because quota nobody can see is not probed.
  // "Never" (null) keeps the open/manual-only behavior.
  //
  // The tick probes the ACTIVE account only (`auto` marks it for smart mode's
  // pause): an automatic cadence watches the row the pool serves, while other
  // rows keep their page-open and per-row refresh paths.
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

  /**
   * The toolbar's Refresh: reload the page AND force the quota windows.
   *
   * The force is the whole point of a manual refresh — without it the click
   * could not deliver anything newer than what the 10-minute TTL already holds,
   * so "I want the latest numbers now" was unanswerable. The two halves are
   * deliberately not awaited together: `refresh()` is the fast local reload,
   * while the forced probe can take seconds, and the rows should not wait on it.
   */
  const refreshAll = useCallback(() => {
    if (smartIdlePausedRef.current) {
      smartIdlePausedRef.current = false
      setSmartIdlePaused(false)
    }
    void refresh()
    if (tab === 'accounts') void loadLimits(true, true)
  }, [loadLimits, refresh, tab])

  /**
   * The model list loads separately: it is the one call that may reach upstream
   * (model discovery), so the page must render even when it is slow or fails.
   *
   * Its failure is kept out of the shared error banner. The list is loaded
   * eagerly (the tab badge needs it), and "no account configured yet" is a
   * perfectly ordinary startup state for an accounts-first page — putting that
   * in the banner would greet every new user with an error.
   */
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

  // Models load up front, not on first visit to the Models tab: the tab badge is
  // rendered from this list, so lazy loading made the count appear only after
  // the user had already been there, and left it stale after account changes.
  // The call is not awaited by `refresh`, so a slow model discovery still does
  // not hold up the accounts view.
  useEffect(() => { void loadModels() }, [loadModels])
  useEffect(() => {
    // Retry when the Models tab is opened and the initial load failed (e.g. no
    // account existed yet at mount, and one was added afterwards).
    if (tab === 'models' && models.length === 0) void loadModels()
  }, [tab, models.length, loadModels])
  /** Run one mutating call, then reload; failures land in the banner. */
  const act = useCallback(async (run: () => Promise<unknown>) => {
    setBusy(true)
    // A fresh action supersedes the previous outcome; a stale notice next to a
    // new error would read as if both were current.
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
  }, [refresh])

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

  // The callback page posts this once the exchange succeeds.
  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      // Check the ORIGIN, not just the payload: the callback page is served from
      // this same web server, so a matching origin is what distinguishes it from
      // any other page that can reach this window. Without the check, an
      // unrelated opener could trigger a refresh by posting the same shape.
      if (event.origin !== window.location.origin) return
      if ((event.data as { type?: string } | null)?.type === 'agy_login_success') void refresh()
    }
    window.addEventListener('message', onMessage)
    return () => { window.removeEventListener('message', onMessage) }
  }, [refresh])

  // A switch made in the conversation badge's popover (this section is not the
  // only switch surface) must reach every tab here: the accounts rows re-read
  // the store, the Models tab reloads its per-account catalog, and the quota
  // windows refresh WITHOUT force — the badge's own switch already forced one,
  // and a second forced probe through every proxy would only duplicate it.
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

  /**
   * Run one one-shot action under the shared busy / clear / report envelope.
   *
   * Deliberately NOT `act()`. `act()` reads only a REJECTION and then calls
   * `refresh()`, which clears the banner — so a handler whose failure arrives
   * IN BAND (`{ ok: false }`, which is how `account.verify`, `account.test` and
   * `account.proxyTest` all report) had its verdict both discarded and erased:
   * the click fired, the host answered, and the panel showed nothing. The
   * reload is also not always wanted; each caller decides.
   *
   * A thrown error still lands here, so a request-level failure (a rejected
   * promise, e.g. "no proxy configured") reports through the same channel.
   * @param run - the action, which reports its own in-band verdict.
   */
  const runAction = useCallback(async (run: () => Promise<void>): Promise<void> => {
    setBusy(true)
    // A fresh action supersedes the previous outcome; a stale verdict next to a
    // new one would read as if both were current.
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

  const handlers: AccountHandlers = useMemo(() => ({
    t,
    onActivate: (index: number) => {
      void act(() => rpc.call('account.activate', { index })).then(() => {
        window.dispatchEvent(new CustomEvent('agy:account-changed', { detail: { index } }))
        // The activated account may carry a different catalog: reload the model
        // list now (also clearing a stale model error) instead of leaving the
        // Models tab showing the previous account's models until a remount.
        void loadModels()
      })
    },
    onRecover: (index: number) => {
      // `act` refreshes on success, so the row's cooling-until badge disappears
      // the moment the clear lands. No notice: the state change IS the feedback.
      void act(() => rpc.call('account.recover', { index }))
    },
    onVerify: (index: number) => {
      void runAction(async () => {
        const result = await rpc.call('account.verify', { index })
        // Reload BEFORE reporting: a live credential re-enables the account, so
        // the row must show the new state even when the verdict is a failure.
        if (alive.current) await refresh()
        if (!alive.current) return
        if (result.ok) setNotice(t('verifyOk', { email: result.email ?? `#${index}` }))
        else setActionError(t('verifyFail') + (result.error === undefined ? '' : `\n${result.error}`))
      })
    },
    onDelete: (index: number) => {
      if (!window.confirm(t('confirmDelete'))) return
      void act(() => rpc.call('account.delete', { index }))
    },
    onTest: (index: number) => {
      // Test needs a model id; discover the first visible one rather than
      // guessing, and report clearly when there is none.
      void runAction(async () => {
        const listed = models.length > 0 ? models : (await rpc.call('model.list', {})).models
        const target = listed.find((entry) => !entry.disabled)?.id
        if (target === undefined) throw new Error(t('noModelToTest'))
        // Carry the clicked row's index: without it the host tested whichever
        // account affinity picked and reported that result here.
        const result = await rpc.call('account.test', { model: target, index })
        // The test billed a real request, so the ledger reload is meaningful.
        if (alive.current) await refresh()
        if (!alive.current) return
        if (result.ok) setNotice(t('modelTestOk', { model: target }))
        else setActionError(t('modelTestFail', { model: target })
          + (result.error === undefined ? '' : `\n${result.error}`))
      })
    },
    onExport: (index: number) => {
      void act(async () => {
        const result = await rpc.call('account.export', { index })
        if (result.blob === undefined) throw new Error(result.error ?? t('exportFailed'))
        await copyText(result.blob)
      })
    },
    onRegenerateFingerprint: (index: number) => {
      void act(() => rpc.call('account.fingerprint', { index, action: 'regenerate' }))
    },
    onSetProxy: (index: number, proxy: string) => { void act(() => rpc.call('account.proxy', { index, proxy })) },
    /**
     * Probe the proxy and REPORT the verdict.
     *
     * `account.proxyTest` answers in band (`{ ok, masked, error? }`) and only
     * throws for a request-level failure, so the in-band verdict is read here
     * rather than left to `act()`. No `refresh()`: the probe mutates no account
     * state, so reloading would be a second `account.list` + `stats.get` round
     * trip bought for nothing.
     */
    onTestProxy: (index: number, proxy: string) => {
      void runAction(async () => {
        // The draft wins when present, so a proxy can be probed BEFORE it is
        // saved; the host normalizes it exactly as `account.proxy` does.
        const result = await rpc.call('account.proxyTest', {
          index,
          ...(proxy === '' ? {} : { proxy }),
        })
        if (!alive.current) return
        if (result.ok) setNotice(t('proxyTestOk', { proxy: result.masked }))
        else setActionError(t('proxyTestFail', { proxy: result.masked })
          + (result.error === undefined ? '' : `\n${result.error}`))
      })
    },
    /**
     * Force the quota refresh for ONE account (the limits card's refresh
     * button). Naming the index keeps a single card from probing the whole pool
     * through several proxies; the outcome reports like the toolbar's refresh.
     */
    onRefreshLimits: (index: number) => { void loadLimits(true, true, index) },
  }), [act, copyText, loadLimits, loadModels, models, refresh, rpc, runAction, setActionError, setNotice, t])

  const tabButton = (id: TabId, label: string, count?: number): ReactNode =>
    h('button', {
      key: id,
      type: 'button',
      className: 'agy-tab',
      'data-active': tab === id,
      onClick: () => { setTab(id) },
    }, label, count === undefined ? null : h('span', { className: 'agy-count' }, String(count)))

  const body = tab === 'accounts'
    ? h(AccountsTab, {
      accounts,
      busy,
      busyNow: poolBusy,
      handlers,
      lang: props.lang,
      rpc,
      t,
      detailedQuotaReset,
      smartPausedUntil,
      smartIdlePaused,
      onBadgePrefChange: props.onBadgePrefChange,
      onDetailedPrefChange: (enabled: boolean) => {
        setDetailedQuotaReset(enabled)
      },
    })
    : tab === 'models'
      ? modelError === undefined
        ? h(ModelsTab, {
          models,
          account: modelAccount,
          // The quota panel answers the same question as the visibility list
          // ("which models can I use, how much is left"), so it lives here. It is
          // read from the active account's row, which is the only one the host
          // queries (see management.ts listAccounts).
          pending: toggling,
          testing: modelTesting,
          t,
          /**
           * Optimistic, per-model toggle.
           *
           * The old handler ran the write AND a full `model.list` reload through
           * `act()`, so a click cost two network round trips (the reload reaches
           * upstream model discovery) while a single global `busy` flag disabled
           * every control on the page — hence "it hangs, everything is disabled,
           * then it switches". The write is authoritative and its result is
           * already known, so the list is updated from the response and no
           * reload is needed: the switch reflects exactly what the host stored.
           */
          onToggle: (modelId: string, disabled: boolean) => {
            setToggling((current) => new Set(current).add(modelId))
            void (async () => {
              try {
                const result = await rpc.call('model.setDisabled', { modelId, disabled })
                if (!alive.current) return
                setModels((current) => current.map((model) => (model.id === result.modelId
                  ? { ...model, disabled: result.disabled }
                  : model)))
                setError(undefined)
              } catch (caught) {
                if (!alive.current) return
                setError(caught instanceof Error ? caught.message : String(caught))
              } finally {
                if (alive.current) {
                  setToggling((current) => {
                    const next = new Set(current)
                    next.delete(modelId)
                    return next
                  })
                }
              }
            })()
          },
          /**
           * One billed test call against exactly this model, reported in the
           * shared notice line (OK) or error banner (failure). The result must
           * not be silent: a test that shows nothing looks like nothing ran.
           */
          onTestModel: (modelId: string) => {
            setError(undefined)
            setNotice(undefined)
            setModelTesting((current) => new Set(current).add(modelId))
            void (async () => {
              try {
                // The active account serves the test, which is the account whose
                // quota this list describes; passing no index keeps that contract.
                const result = await rpc.call('account.test', { model: modelId })
                if (!alive.current) return
                if (result.ok) {
                  setNotice(t('modelTestOk', { model: modelId }))
                } else {
                  setError(t('modelTestFail', { model: modelId }) + (result.error ? `\n${result.error}` : ''))
                }
              } catch (caught) {
                if (!alive.current) return
                setError(caught instanceof Error ? caught.message : String(caught))
              } finally {
                if (alive.current) {
                  setModelTesting((current) => {
                    const next = new Set(current)
                    next.delete(modelId)
                    return next
                  })
                }
              }
            })()
          },
        })
        : h('div', { className: 'agy-root' },
          h('div', { className: 'agy-error' }, modelError),
          button(t('refresh'), () => { void loadModels() }, { size: 'sm' }))
      : tab === 'config'
        ? h(ConfigTab, { rpc, t })
        : tab === 'usage'
          ? h(UsageTab, { stats, lang: props.lang, t })
          : h(CredentialsTab, {
          busy,
          t,
          onImport: (kind: 'json' | 'blob', sources: string[]) => {
            void act(async () => {
              const result = await rpc.call('account.import', { kind, sources })
              // A batch with failures is a partial success, so it must not be
              // reported through the error path — and it must not be silent
              // either, which is what discarding this result used to be.
              if (result.errors.length > 0) {
                setNotice(`${t('importPartial', {
                  imported: result.imported,
                  replaced: result.replaced,
                  failed: result.errors.length,
                })}\n${result.errors.join('\n')}`)
              } else {
                setNotice(t('importResult', {
                  imported: result.imported,
                  replaced: result.replaced,
                }))
              }
            })
          },
          onExportAll: () => {
            void act(async () => {
              const { blobs } = await rpc.call('account.exportAll', {})
              await copyText(blobs.map((entry) => entry.blob).join('\n'))
            })
          },
        })

  return h('div', { className: 'agy-root' },
    h('div', { className: 'agy-head' },
      h('div', null,
        h('div', { className: 'agy-title' }, 'Antigravity'),
        h('div', { className: 'agy-sub' }, t('subtitle'))),
      h('div', { className: 'agy-toolbar' },
        // Both header actions use the host's `outline` variant — the same one
        // Refresh already used. They are equal-weight utility actions, so they
        // must look identical; an earlier pass gave Login `toolbar` (a filled
        // variant) to avoid the near-white `primary` slab, which fixed that
        // button but left the pair visibly mismatched. Copying Refresh is the
        // correct answer: `outline` is a bordered transparent capsule that reads
        // correctly in both themes, and it needs no token reasoning of ours.
        button(t('refresh'), refreshAll, { size: 'sm', disabled: busy }),
        button(t('login'), startLogin, { size: 'sm', disabled: busy }))),
    h('div', { className: 'agy-tabs' },
      tabButton('accounts', t('tabAccounts'), accounts.length),
      tabButton('models', t('tabModels'), models.length > 0 ? models.length : undefined),
      tabButton('config', t('tabConfig')),
      tabButton('usage', t('tabUsage')),
      tabButton('credentials', t('tabCredentials'))),
    error === undefined ? null : h('div', { className: 'agy-error' }, error),
    // The action's own verdict, in the same red as a standing error because it
    // IS one — it simply expires, since the page is still usable and the user
    // already knows what they clicked. `pre-wrap` is not inherited from
    // `.agy-notice`, so the two-line "what failed + why" form relies on the
    // stylesheet keeping newlines (see `.agy-error`).
    actionError === undefined ? null : h('div', { className: 'agy-error' }, actionError),
    notice === undefined ? null : h('div', { className: 'agy-notice' }, notice),
    body,
    loaded || error !== undefined ? null : h('div', { className: 'agy-empty' }, t('loading')))
}

/**
 * Register the Antigravity Settings section while this client plugin is active.
 * @param ctx - Client Cordis context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => installAgyStyles(), 'dsh-agy: styles')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-agy: dictionaries')
  const connection = ctx.get('connection') as ConnectionLike | undefined
  if (connection === undefined) {
    ctx.logger.warn('[dsh-agy] connection service unavailable — Antigravity settings not registered')
    return
  }
  const rpc = createRpc(connection)
  // Bound once from the host's locale service: the slot content is re-created on
  // a language switch (the locale plugin bumps the ledger), so `t` stays current.
  const t = ctx.locale.bind(NS)
  // The UI language for date formatting, read once per mount for the same
  // reason. Optional-call against an older host whose locale service predates
  // `getLocale`: undefined then degrades to the browser default, which is the
  // pre-`lang` behaviour, not a crash.
  const lang = ctx.locale.getLocale?.().active
  let badgeDisposer: (() => void) | null = null

  const registerBadge = (): void => {
    if (badgeDisposer !== null) return
    badgeDisposer = ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'agy-quota-badge',
      order: 8,
      label: () => t('title'),
    }, () => h(AgyQuotaBadge, { rpc, t })))
  }

  const unregisterBadge = (): void => {
    if (badgeDisposer !== null) {
      badgeDisposer()
      badgeDisposer = null
    }
  }

  // Opt-in: only register when user preference has enabled the badge
  void rpc.call('ui.prefs.get', {}).then((prefs: UiPrefsView | null) => {
    if (prefs?.conversationBadge) {
      registerBadge()
    }
  }).catch(() => {})

  const onBadgePrefChange = (enabled: boolean): void => {
    if (enabled) {
      registerBadge()
    } else {
      unregisterBadge()
    }
  }

  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'agy',
    order: 30,
    locale: NS,
    label: () => t('title'),
  }, () => h(AgySettings, { rpc, t, lang, onBadgePrefChange }))), 'dsh-agy: Settings section')

  ctx.effect(() => () => {
    unregisterBadge()
  }, 'dsh-agy: quota badge cleanup')
}
