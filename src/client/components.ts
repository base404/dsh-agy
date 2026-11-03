/**
 * Reusable UI building blocks for the Antigravity Settings section.
 */

import type { ReactNode } from 'react'
import { Button, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState, TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import { h } from './element.ts'
import { tokenText } from './formatting.ts'
import type { AccountView } from '../rpc-contract.ts'

/**
 * A host-styled button.
 */
export function button(label: string, onClick: () => void, options: {
  variant?: 'danger' | 'ghost'
  size?: 'sm'
  disabled?: boolean
  title?: string
} = {}): ReactNode {
  return h(Button, {
    variant: options.variant === 'danger' ? 'outline' : (options.variant ?? 'outline'),
    size: options.size === 'sm' ? 'sm' : 'md',
    ...(options.disabled === true ? { disabled: true } : {}),
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(options.variant === 'danger' ? { className: 'agy-btn-danger' } : {}),
    onClick: (event: { stopPropagation?: () => void }) => {
      event?.stopPropagation?.()
      onClick()
    },
  }, label)
}

/** Account state rendered with the host's state dot plus a tinted tag. */
export function stateBadge(state: AccountView['state'], label: string): ReactNode {
  const dot: StateDotState = state === 'active'
    ? 'done'
    : state === 'cooling' ? 'warning' : 'error'
  const tone: TagTone = state === 'active' ? 'success' : state === 'cooling' ? 'warning' : 'danger'
  return h('span', { className: 'agy-state' },
    h(StateDot, { state: dot, size: 8 }),
    h(Tag, { tone }, label))
}

export function subhead(title: string, aside?: string): ReactNode {
  return h('div', { className: 'agy-subhead' },
    h('span', null, title),
    aside === undefined || aside === '' ? null : h('span', { className: 'agy-aside' }, aside))
}

export function hint(text: string): ReactNode {
  return h('p', { className: 'agy-hint' }, text)
}

export function table(headers: ReactNode, rows: ReactNode[]): ReactNode {
  return h('table', { className: 'agy-table' },
    headers === null ? null : h('thead', null, headers),
    h('tbody', null, ...rows))
}

/** A titled grouping surface. */
export function card(title: ReactNode, body: ReactNode, aside?: ReactNode): ReactNode {
  return h('section', { className: 'agy-card' },
    h('div', { className: 'agy-card-head' },
      h('span', { className: 'agy-card-title' }, title),
      aside === undefined ? null : h('span', { className: 'agy-aside' }, aside)),
    h('div', { className: 'agy-card-body' }, body))
}

/** A metric strip inside a card. */
export function metrics(cells: ReactNode[]): ReactNode {
  return h('div', { className: 'agy-metrics' }, ...cells)
}

/** One metric cell: a label, a large value, and an optional detail line. */
export function metric(label: string, value: number | string, detail: string): ReactNode {
  const text = typeof value === 'number' ? tokenText(value) : value
  const match = /^([\d.]+)([MK]?)$/.exec(text)
  return h('div', { className: 'agy-metric' },
    h('div', { className: 'agy-metric-k' }, label),
    h('div', { className: 'agy-metric-v' },
      match === null ? text : match[1],
      match !== null && match[2] !== '' ? h('small', null, match[2]) : null),
    h('div', { className: 'agy-metric-d' }, detail))
}

/** Definition rows: label/value pairs with hairline separators. */
export function defs(rows: Array<[ReactNode, ReactNode]>): ReactNode {
  return h('dl', { className: 'agy-defs' },
    ...rows.flatMap(([label, value], index) => [
      h('dt', { key: `k${index}` }, label),
      h('dd', { key: `v${index}` }, value),
    ]))
}
