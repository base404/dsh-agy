/**
 * Usage tab component: tokens breakdown, timing, trend, and by-model/by-account tables.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import { Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import { h } from './element.ts'
import { aliasVar } from './styles.ts'
import type { AgyLocaleKey } from './locales.ts'
import type { StatsView } from '../rpc-contract.ts'
import type { UsageCounters } from '../usage-types.ts'
import type { T } from './types.ts'
import {
  average,
  cacheHitPercent,
  dayLabel,
  formatDuration,
  promptTokens,
  tokenText,
  totalTokens,
} from './formatting.ts'
import { card, defs, metric, metrics, table } from './components.ts'

export type RangeId = 'today' | 'week' | 'month' | 'all'

export const RANGE_IDS: readonly RangeId[] = ['today', 'week', 'month', 'all']

export function rangeLabel(id: RangeId, t: T): string {
  switch (id) {
    case 'today': return t('rangeToday')
    case 'week': return t('rangeWeek')
    case 'month': return t('rangeMonth')
    case 'all': return t('rangeAll')
  }
}

const NUM_COL_WIDTHS = ['48px', '56px', '56px', '56px', '64px'] as const

export function numHeader(index: number, label: string): ReactNode {
  return h('th', { className: 'agy-num', style: { width: NUM_COL_WIDTHS[index] } }, label)
}

export function tokenComposition(counters: UsageCounters, t: T): ReactNode {
  const total = totalTokens(counters)
  const rows: Array<{ id: string, labelKey: AgyLocaleKey, value: number, tone: string }> = [
    { id: 'cacheRead', labelKey: 'kpiCacheRead', value: counters.cacheRead, tone: aliasVar('brand-primary') },
    { id: 'missed', labelKey: 'kpiInputMissedLabel', value: counters.input, tone: 'var(--dsw-static-neutral-bluish-700, #8b8f96)' },
    { id: 'output', labelKey: 'kpiOutput', value: counters.output, tone: aliasVar('state-success-primary') },
  ]
  return h('div', { className: 'agy-compose' }, ...rows.map((row) => {
    const share = total > 0 ? (row.value / total) * 100 : 0
    return h('div', { className: 'agy-compose-row', key: row.id },
      h('span', { className: 'agy-compose-k' }, t(row.labelKey)),
      h('span', { className: 'agy-compose-track' },
        h('i', { style: { width: `${Math.max(share, row.value > 0 ? 1 : 0)}%`, background: row.tone } })),
      h('span', { className: 'agy-compose-v' }, tokenText(row.value)),
      h('span', { className: 'agy-compose-p' }, `${share.toFixed(1)}%`))
  }))
}

export function UsageTab(props: { stats: StatsView | null, lang?: string, t: T }): ReactNode {
  const { t } = props
  const [range, setRange] = useState<RangeId>('today')
  const stats = props.stats
  if (stats === null) return h('div', { className: 'agy-empty' }, t('loading'))
  if (stats.all.counters.requests === 0) {
    return card(t('usageTitle'), h('div', { className: 'agy-empty' }, t('emptyUsage')))
  }

  const view = range === 'today'
    ? stats.today
    : range === 'week'
      ? stats.week
      : range === 'month' ? stats.month : stats.all
  const counters = view.counters
  const hit = cacheHitPercent(counters)
  const total = totalTokens(counters)

  const rangePicker = h('div', { className: 'agy-toolbar' },
    h('div', { className: 'agy-chips' }, ...RANGE_IDS.map((id) => h(Pill, {
      key: id,
      active: range === id,
      onClick: () => { setRange(id) },
    }, rangeLabel(id, t)))),
    h('span', { className: 'agy-grow' }),
    stats.since === null
      ? null
      : h('span', { className: 'agy-aside' }, t('since', { date: new Date(stats.since).toLocaleDateString(props.lang) })))

  const summary = card(t('usageTitle'), h('div', null,
    metrics([
      metric(t('kpiTotalTokens'), total, t('kpiTotalDetail', {
        requests: counters.requests,
        failed: counters.failed,
      })),
      metric(t('kpiInput'), promptTokens(counters),
        t('kpiInputMissed', { tokens: tokenText(counters.input) })),
      metric(t('kpiCacheRead'), counters.cacheRead,
        hit === null ? t('kpiNoBilledInput') : t('kpiCacheHit', { percent: hit })),
      metric(t('kpiOutput'), counters.output, t('kpiOutputDetail')),
    ]),
    tokenComposition(counters, t)))

  const timing = card(t('fieldLatency'), defs([
    [t('fieldCacheWrite'), tokenText(counters.cacheWrite)],
    [t('fieldRateLimitRotation'), `${counters.rateLimited} / ${counters.rotations}`],
    [t('labelLatencyAverage'), formatDuration(average(counters.latencyMs, counters.latencyN))],
    [t('labelTtft'), formatDuration(average(counters.ttftMs, counters.ttftN))],
  ]))

  const trend = card(t('trendTitle'),
    h('div', { className: 'agy-table-wrap' },
      table(
        h('tr', null,
          h('th', null, t('colDay')),
          numHeader(0, t('colRequests')),
          numHeader(1, t('colFailed')),
          numHeader(2, t('colRateLimited')),
          numHeader(3, t('colRotations'))),
        stats.days.map((row) => h('tr', { key: row.day },
          h('td', null, dayLabel(row.day, props.lang)),
          h('td', { className: 'agy-num' }, String(row.requests)),
          h('td', { className: 'agy-num' }, String(row.failed)),
          h('td', { className: 'agy-num' }, String(row.rateLimited)),
          h('td', { className: 'agy-num' }, String(row.rotations)))))))

  const byModel = view.models.length === 0 ? null : card(
    t('byModel'),
    h('div', { className: 'agy-table-wrap' },
      table(
        h('tr', null,
          h('th', null, t('colModel')),
          numHeader(0, t('colRequests')),
          numHeader(1, t('kpiInput')),
          numHeader(2, t('kpiCacheRead')),
          numHeader(3, t('colOutput')),
          numHeader(4, t('colTokenShare'))),
        view.models.map((row) => h('tr', { key: row.model },
          h('td', { className: 'agy-strong' }, h('span', { className: 'agy-mail' }, row.model)),
          h('td', { className: 'agy-num' }, String(row.counters.requests)),
          h('td', { className: 'agy-num' }, tokenText(promptTokens(row.counters))),
          h('td', { className: 'agy-num' }, tokenText(row.counters.cacheRead)),
          h('td', { className: 'agy-num' }, tokenText(row.counters.output)),
          h('td', { className: 'agy-num' },
            h('span', { className: 'agy-bar' },
              h('span', { className: 'agy-track' },
                h('i', {
                  style: {
                    width: `${Math.round((totalTokens(row.counters) / Math.max(1, total)) * 100)}%`,
                  },
                })))))))))

  const byAccount = view.accounts.length === 0 ? null : card(t('byAccount'),
    h('div', { className: 'agy-table-wrap' },
      table(h('tr', null,
        h('th', null, t('colAccount')),
        numHeader(0, t('colRequests')),
        numHeader(1, t('colToken')),
        numHeader(2, t('colFailed')),
        numHeader(3, t('colRateLimited')),
        numHeader(4, t('colRotations'))),
      view.accounts.map((row) => h('tr', { key: row.account },
        h('td', { className: 'agy-strong' }, h('span', { className: 'agy-mail' }, row.account)),
        h('td', { className: 'agy-num' }, String(row.counters.requests)),
        h('td', { className: 'agy-num' }, tokenText(totalTokens(row.counters))),
        h('td', { className: 'agy-num' }, String(row.counters.failed)),
        h('td', { className: 'agy-num' }, String(row.counters.rateLimited)),
        h('td', { className: 'agy-num' }, String(row.counters.rotations))))),
    ),
  )

  return h('div', { className: 'agy-root' },
    rangePicker, summary, timing, trend, byModel, byAccount)
}
