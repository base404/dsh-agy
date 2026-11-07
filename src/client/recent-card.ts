/**
 * Recent activity disclosure card component.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { h } from './element.ts'
import { table } from './components.ts'
import {
  formatDuration,
  recentAgo,
  tokenText,
  truncateIdentity,
} from './formatting.ts'
import type { AgyRpcClient } from '../rpc-contract.ts'
import { POOL_POLL_INTERVAL_MS, type RecentEntry, type T } from './types.ts'

/** Result vocabulary for one recent row; rotation events are their own kind. */
export function recentResultKind(entry: RecentEntry): 'ok' | 'fail' | 'limited' | 'rotation' {
  if (entry.kind === 'rotation') return 'rotation'
  if (entry.rateLimited) return 'limited'
  if (!entry.ok) return 'fail'
  return 'ok'
}

/** Localized label for a failure-classification token. */
export function failureReasonLabel(reason: string, t: T): string {
  switch (reason) {
    case 'rate-limit': return t('colRateLimited')
    case 'network-error': return t('cooldownReasonNetworkError')
    case 'auth-failure': return t('disabledCredentials')
    case 'verification-required': return t('cooldownReasonValidationRequired')
    case 'quota-exhausted': return t('cooldownReasonQuotaExhausted')
    case 'project-error': return t('cooldownReasonProjectError')
    case 'aborted': return t('reasonAborted')
    default: return reason
  }
}

/** The result cell's text. */
export function recentResultText(entry: RecentEntry, t: T): string {
  const kind = recentResultKind(entry)
  if (kind === 'rotation') {
    return entry.reason === null
      ? t('colRotations')
      : `${t('colRotations')} · ${failureReasonLabel(entry.reason, t)}`
  }
  if (kind === 'limited') return t('colRateLimited')
  if (kind === 'fail') {
    return entry.reason === null || entry.reason === 'rate-limit'
      ? t('colFailed')
      : `${t('colFailed')} · ${failureReasonLabel(entry.reason, t)}`
  }
  return t('recentOk')
}

/**
 * The "what just happened" list: the most recent records this process saw.
 */
export function RecentCard(props: { rpc: AgyRpcClient, t: T }): ReactNode {
  const { rpc, t } = props
  const [open, setOpen] = useState(false)
  const [recent, setRecent] = useState<RecentEntry[] | null>(null)
  const [error, setError] = useState<string | undefined>(undefined)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const load = useCallback((): void => {
    void rpc.call('pool.recent', {}).then((result) => {
      if (alive.current) {
        setRecent(result.recent)
        setError(undefined)
      }
    }).catch((caught: unknown) => {
      if (alive.current) setError(caught instanceof Error ? caught.message : String(caught))
    })
  }, [rpc])

  useEffect(() => { if (open && recent === null) load() }, [open, recent, load])
  useEffect(() => {
    if (!open) return
    const timer = setInterval(() => { if (!document.hidden) load() }, POOL_POLL_INTERVAL_MS)
    return () => { clearInterval(timer) }
  }, [open, load])

  const now = Date.now()

  return h('section', { className: 'agy-card agy-recent-card', 'data-open': open },
    h('div', {
      className: 'agy-card-head agy-clickable',
      role: 'button',
      tabIndex: 0,
      'aria-expanded': open,
      onClick: () => { setOpen(!open) },
      onKeyDown: (event: { key: string, preventDefault: () => void }) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          setOpen(!open)
        }
      },
    },
      h('div', { className: 'agy-card-title-wrap' },
        h('span', { className: 'agy-caret', 'data-open': open }),
        h('span', { className: 'agy-card-title' }, t('recentTitle'))),
      recent === null ? null : h('span', { className: 'agy-aside' }, String(recent.length))),
    open === false ? null : h('div', { className: 'agy-card-body' },
      error === undefined ? null : h('div', { className: 'agy-error' }, error),
      recent === null
        ? h('div', { className: 'agy-empty' }, t('loading'))
        : recent.length === 0
          ? h('div', { className: 'agy-empty' }, t('recentEmpty'))
          : h('div', { className: 'agy-table-wrap' },
            table(
              h('tr', null,
                h('th', { style: { width: '64px' } }, t('colTime')),
                h('th', { style: { width: '30%' } }, t('colAccount')),
                h('th', { style: { width: '24%' } }, t('colModel')),
                h('th', { style: { width: '96px' } }, t('colResult')),
                h('th', { style: { width: '56px' } }, t('colDuration')),
                h('th', { style: { width: '48px' } }, t('colOutput'))),
              recent.map((entry, index) => h('tr', { key: `${entry.at}-${index}` },
                h('td', null, recentAgo(entry.at, now, t)),
                h('td', null, h('span', {
                  className: 'agy-mail',
                  title: entry.account ?? undefined,
                }, entry.account === null ? '—' : truncateIdentity(entry.account))),
                h('td', null, h('span', {
                  className: 'agy-mail',
                  title: entry.model ?? undefined,
                }, entry.model === null ? '—' : truncateIdentity(entry.model))),
                h('td', null, h('span', { className: 'agy-recent-state', 'data-kind': recentResultKind(entry) }, recentResultText(entry, t))),
                h('td', null, entry.latencyMs === null ? '—' : formatDuration(entry.latencyMs)),
                h('td', { className: 'agy-num' }, entry.output === null ? '—' : tokenText(entry.output))))))))
}
