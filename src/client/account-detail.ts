/**
 * Single account detail view: identity, cumulative usage, proxy, and actions.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import { Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { h } from './element.ts'
import type { AccountView } from '../rpc-contract.ts'
import type { AccountHandlers, T } from './types.ts'
import {
  average,
  cacheHitPercent,
  cooldownReasonLabel,
  formatDuration,
  promptTokens,
  throughputTokenPerSecond,
  tokenText,
} from './formatting.ts'
import { button, card, defs, hint, metric, metrics } from './components.ts'
import {
  agoText,
  barColorFor,
  effectiveFraction,
  formatQuotaReset,
  windowLabel,
} from './quota-view.ts'

/** One account's detail: identity, cumulative usage, proxy, and its actions. */
export function AccountDetail(props: {
  account: AccountView
  busy: boolean
  handlers: AccountHandlers
  /** UI language for locale-sensitive date formatting ('zh' | 'en'). */
  lang?: string
  t: T
  detailedQuotaReset?: boolean
}): ReactNode {
  const { account, busy, handlers, t } = props
  const [proxyDraft, setProxyDraft] = useState('')
  const usage = account.usage
  const now = Date.now()
  const throughput = usage === null ? null : throughputTokenPerSecond(usage.totals)

  const identityRows: Array<[ReactNode, ReactNode]> = [
    [t('fieldProject'), account.projectId ?? t('noProject')],
    [t('fieldProxy'), h('span', { className: 'agy-mono' }, account.proxy ?? t('proxyDirect'))],
    [t('fieldFingerprint'), account.fingerprint === null
      ? t('fingerprintNone')
      : t('fingerprintRegenerated', {
        count: account.fingerprintHistory,
        date: new Date(account.fingerprint.createdAt).toLocaleDateString(props.lang),
      })],
    ...(account.cooldownReason === null ? [] : [[
      t('fieldCooldownReason'),
      `${cooldownReasonLabel(account.cooldownReason, t)} · ${agoText(account.cooldownSetAt, t, now)}`,
    ] as [ReactNode, ReactNode]]),
    [t('fieldSources'), usage === null
      ? t('noProject')
      : t('sourcesSummary', {
        chat: usage.sources.chat,
        cli: usage.sources.cli,
        verify: usage.sources.verify,
        test: usage.sources.test,
      })],
    [t('fieldLatency'), usage === null
      ? t('noProject')
      : `${t('latencyAverage', { value: formatDuration(average(usage.totals.latencyMs, usage.totals.latencyN)) })}`
        + ` · ${t('latencyTtft', { value: formatDuration(average(usage.totals.ttftMs, usage.totals.ttftN)) })}`],
    ...(throughput === null ? [] : [[
      t('fieldThroughput'),
      `${t('throughputValue', { n: throughput })} · ${t('throughputNote')}`,
    ] as [ReactNode, ReactNode]]),
  ]

  if (account.state === 'disabled') {
    identityRows.push([t('fieldDisabled'), account.disabledAt === null
      ? t('disabledCredentials')
      : `${t('disabledCredentials')} · ${t('disabledSince', { ago: agoText(account.disabledAt, t, now) })}`])
  }
  if (account.verificationRequired) {
    identityRows.push([t('fieldVerification'), account.verificationUrl === null
      ? t('verificationNoUrl')
      : h('a', {
        className: 'agy-link',
        href: account.verificationUrl,
        target: '_blank',
        rel: 'noreferrer noopener',
      }, t('verificationOpen'))])
  }

  const identity = card(t('detailTitle'),
    h('div', null,
      defs(identityRows),
      account.state === 'disabled' ? hint(t('disabledHint')) : null),
    account.email ?? `#${account.index}`)

  const actions = card(t('colActions'), h('div', { className: 'agy-actions' },
    button(t('actionTest'), () => { handlers.onTest(account.index) }, { disabled: busy }),
    account.state === 'cooling'
      ? button(t('actionRecover'), () => { handlers.onRecover(account.index) }, { disabled: busy })
      : null,
    button(t('actionExport'), () => { handlers.onExport(account.index) }, { disabled: busy }),
    button(t('actionRegenerateFingerprint'), () => { handlers.onRegenerateFingerprint(account.index) }, { disabled: busy }),
    button(t('actionDelete'), () => { handlers.onDelete(account.index) }, { variant: 'danger', disabled: busy })))

  const limitsAside = button(t('refresh'),
    () => { handlers.onRefreshLimits(account.index) },
    { size: 'sm', variant: 'ghost', disabled: busy })
  const limitsBlock = card(t('limitsTitle'),
    account.limits === null || account.limits.length === 0
      ? h('div', { className: 'agy-empty' }, t('limitsUnavailable'))
      : h('div', { className: 'agy-limits' },
        account.limitsUpdatedAt === null
          ? null
          : h('div', { className: 'agy-limit-age' },
            t('limitsMeasured', { ago: agoText(new Date(account.limitsUpdatedAt).toISOString(), t, now) })),
        ...account.limits.map((group) => {
          const weeklyWindow = group.windows.find((w) => w.window === 'weekly')
          const groupWeekly = weeklyWindow ? effectiveFraction(weeklyWindow, now) : null
          return h('div', { className: 'agy-limit-group', key: group.name },
            h('div', { className: 'agy-limit-group-name' }, group.name),
            ...group.windows.map((window) => {
              const fraction = effectiveFraction(window, now)
              return h('div', { key: window.bucketId },
                h('div', { className: 'agy-limit-row' },
                  h('span', { className: 'agy-limit-k' }, windowLabel(window.window, t)),
                  h('span', { className: 'agy-limit-track' },
                    fraction === null
                      ? null
                      : h('i', { style: { width: `${Math.round(fraction * 100)}%`, background: barColorFor(window.window, fraction, groupWeekly) } })),
                  h('span', { className: 'agy-limit-p' }, fraction === null ? t('valueUnknown') : `${Math.round(fraction * 100)}%`),
                  h('span', { className: 'agy-limit-reset' },
                    window.resetTime === null ? null : formatQuotaReset(window.window, window.resetTime, t, now, props.detailedQuotaReset))))
            }))
        })),
    limitsAside)

  const usageBlock = usage === null ? null : card(
    t('usageCumulative'),
    metrics([
      metric(t('kpiInput'), promptTokens(usage.totals), t('kpiInputMissed', {
        tokens: tokenText(usage.totals.input),
      })),
      metric(t('kpiOutput'), usage.totals.output, t('kpiOutputDetail')),
      metric(t('kpiCacheRead'), usage.totals.cacheRead, t('kpiCacheHit', { percent: cacheHitPercent(usage.totals) ?? 0 })),
      metric(t('kpiRequests'), String(usage.totals.requests), t('kpiRequestsDetail', {
        succeeded: usage.totals.succeeded,
        failed: usage.totals.failed,
      })),
    ]),
  )

  const saveProxy = (): void => {
    const value = proxyDraft.trim()
    if (value === '') return
    handlers.onSetProxy(account.index, value)
    setProxyDraft('')
  }

  const proxyBlock = card(t('fieldProxy'), h('div', { className: 'agy-actions' },
    h(Input, {
      value: proxyDraft,
      placeholder: t('proxyPlaceholder'),
      onChange: (event: { target: { value: string } }) => { setProxyDraft(event.target.value) },
    }),
    button(t('actionSave'), saveProxy, { disabled: busy || proxyDraft.trim() === '' }),
    button(t('actionClear'), () => {
      handlers.onSetProxy(account.index, '')
      setProxyDraft('')
    }, { disabled: busy || account.proxy === null }),
    (() => {
      const noTarget = proxyDraft.trim() === '' && account.proxy === null
      return button(t('actionTestProxy'),
        () => { handlers.onTestProxy(account.index, proxyDraft.trim()) },
        { disabled: busy || noTarget, ...(noTarget ? { title: t('proxyTestNoTarget') } : {}) })
    })()))

  return h('div', { className: 'agy-detail' }, identity, actions, limitsBlock, usageBlock, proxyBlock)
}
