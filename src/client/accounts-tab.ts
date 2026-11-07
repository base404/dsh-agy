/**
 * Accounts tab component and account selection helpers.
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { h } from './element.ts'
import type { AccountView, AgyRpcClient, AgyRpcResult } from '../rpc-contract.ts'
import type { AccountHandlers, T } from './types.ts'
import { clockTime } from './formatting.ts'
import { button, card, hint, stateBadge } from './components.ts'
import { agoText, formatDetailedReset, stateLabel } from './quota-view.ts'
import { AccountDetail } from './account-detail.ts'
import { RecentCard } from './recent-card.ts'

/**
 * Whether the row should offer "set as current".
 */
export function canActivateAccount(account: AccountView): boolean {
  return !account.active && account.state !== 'disabled'
}

/**
 * Pick the selected account index: defaults to the active account (badge "current")
 * when present, otherwise falls back to index 0. Clamps to valid bounds.
 */
export function resolveSelectedAccountIndex(
  accounts: readonly AccountView[],
  selected: number | null,
): number {
  if (accounts.length === 0) return 0
  if (selected !== null) {
    if (selected >= 0 && selected < accounts.length) return selected
    const activePos = accounts.findIndex((a) => a.active)
    return activePos >= 0 ? activePos : Math.min(Math.max(selected, 0), accounts.length - 1)
  }
  const activePos = accounts.findIndex((a) => a.active)
  return activePos >= 0 ? activePos : 0
}

export function AccountsTab(props: {
  accounts: AccountView[]
  busy: boolean
  /** Accounts with upstream requests in flight, from the latest pool.status. */
  busyNow: AgyRpcResult<'pool.status'>['busy']
  /** RPC carrier, for the recent-activity card's own polling. */
  rpc: AgyRpcClient
  handlers: AccountHandlers
  /** UI language for locale-sensitive date formatting ('zh' | 'en'). */
  lang?: string
  t: T
  detailedQuotaReset?: boolean
  /**
   * When smart mode has parked the automatic quota cadence (Unix ms), or null.
   */
  smartPausedUntil?: number | null
  smartIdlePaused?: boolean
  onBadgePrefChange?: (enabled: boolean) => void
  onDetailedPrefChange?: (enabled: boolean) => void
}): ReactNode {
  const { accounts, busy, handlers, t } = props
  const [selected, setSelected] = useState<number | null>(null)
  const selectedRef = useRef<HTMLDivElement | null>(null)
  const now = Date.now()

  const liveLine = props.busyNow.length === 0 ? null : (() => {
    const total = props.busyNow.reduce((sum, entry) => sum + entry.count, 0)
    const [first] = props.busyNow
    const subject = first === undefined ? '' : first.email ?? `#${first.index}`
    return h('div', { className: 'agy-live' },
      h(StateDot, { state: 'ongoing', size: 8 }),
      h('span', null, props.busyNow.length === 1
        ? t('liveOne', { email: subject, count: total })
        : t('liveMany', { count: total, accounts: props.busyNow.length })))
  })()

  const index = resolveSelectedAccountIndex(accounts, selected)
  const current = accounts[index]

  useEffect(() => {
    selectedRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [index])

  if (accounts.length === 0) {
    return card(t('colAccount'), h('div', { className: 'agy-empty' }, t('emptyAccounts')))
  }

  const rows = accounts.map((account, at) => h('div', {
    key: String(account.index),
    ref: at === index ? selectedRef : undefined,
    className: 'agy-rowitem',
    'data-clickable': 'true',
    'data-selected': at === index,
    role: 'button',
    tabIndex: 0,
    'aria-pressed': at === index,
    onClick: () => { setSelected(at) },
    onKeyDown: (event: { key: string, preventDefault: () => void }) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      setSelected(at)
    },
  },
  h('div', { className: 'agy-rowmain' },
    h('div', { className: 'agy-rowtitle' },
      h('span', { className: 'agy-rowname' }, account.email ?? `#${account.index}`),
      account.active ? h(Tag, { tone: 'info' }, t('currentAccount')) : null),
      h('div', { className: 'agy-rowmeta' },
        (account.projectId ?? t('noProject')),
        account.usage === null || account.usage.totals.requests === 0
          ? null
          : ` · ${t('rowRequestsTotal', { n: account.usage.totals.requests })}`,
        account.usage === null || account.usage.lastUsedAt === null
          ? null
          : ` · ${t('lastActive', { ago: agoText(new Date(account.usage.lastUsedAt).toISOString(), t, now) })}`)),
  h('div', { className: 'agy-rowactions' },
    stateBadge(account.state, account.state === 'cooling'
      ? `${t('coolingUntil')} ${clockTime(account.cooldownUntil, props.lang)}`
      : account.state === 'verification-required'
        ? t('verificationRetry', { time: clockTime(account.cooldownUntil, props.lang) })
        : stateLabel(account.state, t)),
    canActivateAccount(account) ? button(t('actionActivate'), () => {
      setSelected(at)
      handlers.onActivate(account.index)
    }, { size: 'sm', disabled: busy }) : null,
    account.state === 'cooling'
      ? button(t('actionRecover'), () => { handlers.onRecover(account.index) }, { size: 'sm', disabled: busy })
      : null,
    button(t('actionVerify'), () => { handlers.onVerify(account.index) }, { size: 'sm', disabled: busy }))))

  return h('div', { className: 'agy-root' },
    h('div', { className: 'agy-split-wrap' },
      h('div', { className: 'agy-split' },
        card(t('colAccount'),
          h('div', null,
            liveLine,
            props.smartPausedUntil != null
              ? hint(t('smartPausedNote', {
                  time: formatDetailedReset('5h', new Date(props.smartPausedUntil).toISOString(), t, now) ?? '—',
                }))
              : props.smartIdlePaused
                ? hint(t('smartIdlePausedNote'))
                : null,
            h('div', { className: 'agy-rows' }, ...rows)),
          `${accounts.length}`),
        current === undefined
          ? null
          : h(AccountDetail, {
            key: String(current.index),
            account: current,
            busy,
            handlers: {
              ...handlers,
              onDelete: (idx: number) => {
                setSelected(null)
                handlers.onDelete(idx)
              },
            },
            lang: props.lang,
            t,
            detailedQuotaReset: props.detailedQuotaReset,
          })),
    h(RecentCard, { rpc: props.rpc, t })))
}
