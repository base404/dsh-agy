/**
 * Config tab cards: Thinking Budget, Multimodal inline cap, and Model Routing.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { h } from './element.ts'
import { card, hint, table } from './components.ts'
import { levelLabel } from './formatting.ts'
import type {
  AgyRpcClient,
  ModelRoutingTarget,
  MultimodalView,
  ThinkingBudgets,
} from '../rpc-contract.ts'
import {
  CLAUDE_BUDGET_MAX,
  CLAUDE_BUDGET_MIN,
  THINKING_LEVELS,
} from '../thinking-types.ts'
import {
  MULTIMODAL_DEFAULT_MB,
  MULTIMODAL_MAX_MB,
  MULTIMODAL_MIN_MB,
} from '../multimodal-types.ts'
import { ACTION_MESSAGE_TTL_MS, type T } from './types.ts'

export function thinkingRow(
  id: string,
  label: string,
  value: string,
  t: T,
  handlers: {
    onInput: (value: string) => void
    onCommit: (value: string) => void
    chips?: Array<{ label: string, value: string }>
  },
): ReactNode {
  return h('div', { className: 'agy-thinking-row', key: id },
    h('span', { className: 'agy-thinking-k' }, label),
    h(Input, {
      value,
      placeholder: t('thinkingAuto'),
      inputMode: 'numeric',
      onChange: (event: { target: { value: string } }) => { handlers.onInput(event.target.value) },
      onBlur: (event: { target: { value: string } }) => { handlers.onCommit(event.target.value) },
    }),
    handlers.chips === undefined
      ? null
      : h('span', { className: 'agy-thinking-chips' }, ...handlers.chips.map((chip) =>
        h('button', {
          key: chip.label,
          type: 'button',
          className: 'agy-thinking-chip',
          onClick: () => { handlers.onInput(chip.value); handlers.onCommit(chip.value) },
        }, chip.label))))
}

const THINKING_SAMPLES: ReadonlyArray<{
  level: string
  easy: number | null
  medium: number | null
  hard: number | null
}> = [
  { level: 'Default', easy: 135, medium: 1_100, hard: 48_700 },
  { level: 'Low', easy: 50, medium: 0, hard: 9_000 },
  { level: 'Medium', easy: 150, medium: 870, hard: 60_400 },
  { level: 'High', easy: 165, medium: 1_855, hard: 63_400 },
  { level: 'max', easy: 185, medium: 2_130, hard: 62_900 },
]

export function ThinkingSamples({ t }: { t: T }): ReactNode {
  const [show, setShow] = useState(false)
  const cell = (value: number | null): ReactNode =>
    h('td', { className: 'agy-num' }, value === null ? '-' : value === 0 ? '0' : `~${value.toLocaleString()}`)
  return h('div', { className: 'agy-disclosure', 'data-open': show },
    h('button', {
      type: 'button',
      className: 'agy-disclosure-toggle',
      'aria-expanded': show,
      onClick: () => { setShow(!show) },
    },
    h('span', { className: 'agy-caret' }),
    h('span', null, t('thinkingSamplesTitle'))),
    show
      ? h('div', { className: 'agy-disclosure-body' },
        h('p', { className: 'agy-hint' }, t('thinkingSamplesIntro')),
        h('p', { className: 'agy-hint' }, t('thinkingSamplesCaption')),
        h('div', { className: 'agy-table-wrap' },
          table(h('tr', null,
            h('th', null, t('thinkingSamplesLevel')),
            h('th', { className: 'agy-num' }, t('thinkingSamplesEasy')),
            h('th', { className: 'agy-num' }, t('thinkingSamplesMedium')),
            h('th', { className: 'agy-num' }, t('thinkingSamplesHard'))),
          THINKING_SAMPLES.map((row) => h('tr', { key: row.level },
            h('td', { className: 'agy-strong' },
              row.level === 'max' ? t('thinkingSamplesMaxRow') : row.level),
            cell(row.easy), cell(row.medium), cell(row.hard))))),
        h('p', { className: 'agy-hint agy-table-note' }, t('thinkingSamplesComparison')),
        h('p', { className: 'agy-hint agy-table-note' }, t('thinkingSamplesSources')),
        h('p', { className: 'agy-hint agy-table-note' }, t('thinkingSamplesZero')))
      : null)
}

export function ThinkingBudgetCard(props: { rpc: AgyRpcClient, t: T }): ReactNode {
  const { rpc, t } = props
  const [budgets, setBudgets] = useState<ThinkingBudgets>({})
  const [tieredBudget, setTieredBudget] = useState<number | null>(null)
  const [claudeBudget, setClaudeBudget] = useState<number | null>(null)
  const [claudeDraft, setClaudeDraft] = useState('')
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | undefined>(undefined)
  const [loaded, setLoaded] = useState(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const load = useCallback((): void => {
    void (async () => {
      try {
        const result = await rpc.call('thinking.get', {})
        if (!alive.current) return
        setBudgets(result.budgets)
        setTieredBudget(result.tieredBudget)
        setDrafts((c) => ({ ...c, tiered: result.tieredBudget === null ? '' : String(result.tieredBudget) }))
        setClaudeBudget(result.claudeBudget)
        setClaudeDraft(result.claudeBudget === null ? '' : String(result.claudeBudget))
        setDrafts(Object.fromEntries(
          THINKING_LEVELS.map((level) => [level, result.budgets[level] === undefined ? '' : String(result.budgets[level])]),
        ))
        setError(undefined)
      } catch (caught) {
        if (!alive.current) return
        setError(caught instanceof Error ? caught.message : String(caught))
      } finally {
        if (alive.current) setLoaded(true)
      }
    })()
  }, [rpc])

  useEffect(() => { load() }, [load])

  const save = (level: string, raw: string): void => {
    const trimmed = raw.trim()
    const value = trimmed === '' ? null : Number(trimmed)
    if (value !== null && !Number.isInteger(value)) {
      setError(t('thinkingInvalid'))
      return
    }
    void (async () => {
      try {
        const result = await rpc.call('thinking.set', { level, budget: value })
        if (!alive.current) return
        setBudgets(result.budgets)
        setError(undefined)
      } catch (caught) {
        if (!alive.current) return
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    })()
  }

  const saveTiered = (raw: string): void => {
    const trimmed = raw.trim()
    const value = trimmed === '' ? null : Number(trimmed)
    if (value !== null && !Number.isInteger(value)) {
      setError(t('thinkingInvalid'))
      return
    }
    void (async () => {
      try {
        const result = await rpc.call('thinking.setTiered', { budget: value })
        if (!alive.current) return
        setTieredBudget(result.tieredBudget)
        setError(undefined)
      } catch (caught) {
        if (!alive.current) return
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    })()
  }

  const saveClaude = (raw: string): void => {
    const trimmed = raw.trim()
    const value = trimmed === '' ? null : Number(trimmed)
    if (value !== null && !Number.isInteger(value)) {
      setError(t('thinkingInvalid'))
      return
    }
    void (async () => {
      try {
        const result = await rpc.call('thinking.setClaude', { budget: value })
        if (!alive.current) return
        setClaudeBudget(result.claudeBudget)
        setError(undefined)
      } catch (caught) {
        if (!alive.current) return
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    })()
  }

  const configured = THINKING_LEVELS.filter((level) => budgets[level] !== undefined).length
    + (tieredBudget === null ? 0 : 1)
  const aside = configured === 0 ? t('thinkingDefaultAll') : t('thinkingConfigured', { count: configured })

  const body = h('div', { className: 'agy-card-body-padded' },
    error === undefined ? null : h('div', { className: 'agy-error' }, error),
    h('div', { className: 'agy-thinking-group' },
      h('div', { className: 'agy-thinking-group-name' }, t('thinkingGeminiGroup')),
      h('p', { className: 'agy-hint' }, t('thinkingGeminiHint')),
      h('ul', { className: 'agy-thinking-notes agy-thinking-effects' },
        h('li', null, t('thinkingEffectLowUp')),
        h('li', null, t('thinkingEffectHighDown')),
        h('li', null, t('thinkingEffectMax')),
        h('li', null, t('thinkingEffectReset')),
        h('li', null, t('thinkingEffectProLevels'))),
      thinkingRow('tiered', t('thinkingTieredLabel'), drafts.tiered ?? '', t, {
        onInput: (value) => { setDrafts((c) => ({ ...c, tiered: value })) },
        onCommit: (value) => {
          const stored = tieredBudget === null ? '' : String(tieredBudget)
          if (value.trim() !== stored) saveTiered(value)
        },
        chips: [{ label: t('thinkingChipClear'), value: '' }],
      }),
      ...THINKING_LEVELS.map((level) => thinkingRow(level, levelLabel(level, t), drafts[level] ?? '', t, {
        onInput: (value) => { setDrafts((c) => ({ ...c, [level]: value })) },
        onCommit: (value) => {
          const stored = budgets[level] === undefined ? '' : String(budgets[level])
          if (value.trim() !== stored) save(level, value)
        },
      })),
      h(ThinkingSamples, { t })),
    h('div', { className: 'agy-thinking-group' },
      h('div', { className: 'agy-thinking-group-name' }, t('thinkingClaudeGroup')),
      h('ul', { className: 'agy-thinking-notes' },
        h('li', null, t('thinkingClaudeNoLevels', { min: CLAUDE_BUDGET_MIN, max: CLAUDE_BUDGET_MAX })),
        h('li', null, t('thinkingClaudeMaxTokens')),
        h('li', null, t('thinkingClaudeNoReport'))),
      thinkingRow('claude', t('thinkingClaudeLabel'), claudeDraft, t, {
        onInput: (value) => { setClaudeDraft(value) },
        onCommit: (value) => {
          const stored = claudeBudget === null ? '' : String(claudeBudget)
          if (value.trim() !== stored) saveClaude(value)
        },
        chips: [{ label: t('thinkingChipClear'), value: '' }],
      })))

  return card(t('thinkingTitle'), body, aside)
}

export function ModelRoutingCard(props: { rpc: AgyRpcClient; t: T }): ReactNode {
  const { rpc, t } = props
  const [target, setTarget] = useState<ModelRoutingTarget>('tiered')
  const [source, setSource] = useState<string>('default')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const errorTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      if (errorTimer.current !== undefined) clearTimeout(errorTimer.current)
    }
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        const res = await rpc.call('modelRouting.get', {})
        if (!alive.current) return
        setTarget(res.target)
        setSource(res.source)
        setLoading(false)
      } catch {
        if (!alive.current) return
        setLoading(false)
      }
    })()
  }, [rpc])

  const handleChange = useCallback(
    async (nextTarget: ModelRoutingTarget) => {
      setSaving(true)
      const prev = target
      setTarget(nextTarget)
      if (errorTimer.current !== undefined) clearTimeout(errorTimer.current)
      try {
        const res = await rpc.call('modelRouting.set', { target: nextTarget })
        if (!alive.current) return
        setTarget(res.target)
        setSource(res.source)
        setError(null)
      } catch (err) {
        if (!alive.current) return
        setTarget(prev)
        setError(t('prefSaveFailed', { message: err instanceof Error ? err.message : String(err) }))
        errorTimer.current = setTimeout(() => setError(null), ACTION_MESSAGE_TTL_MS)
      } finally {
        if (alive.current) setSaving(false)
      }
    },
    [rpc, target, t],
  )

  const sourceCaption =
    source === 'env'
      ? t('modelRoutingSourceEnv')
      : source === 'stored'
        ? t('modelRoutingSourceStored')
        : t('modelRoutingSourceDefault')

  return card(
    t('modelRoutingTitle'),
    h(
      'div',
      { className: 'agy-model-routing-body' },
      h('div', { className: 'agy-model-routing-desc' }, t('modelRoutingDesc')),
      h(
        'div',
        { className: 'agy-model-routing-row' },
        h('span', { className: 'agy-model-routing-label' }, t('modelRoutingLabel')),
        h(
          'select',
          {
            className: 'agy-select agy-model-routing-select',
            value: target,
            disabled: loading || saving || source === 'env',
            title: t('modelRoutingLabel'),
            'aria-label': t('modelRoutingLabel'),
            onChange: (e: { target: { value: string } }) => {
              void handleChange(e.target.value as ModelRoutingTarget)
            },
          },
          h('option', { value: 'tiered' }, t('modelRoutingOptionTiered')),
          h('option', { value: 'high' }, t('modelRoutingOptionHigh')),
          h('option', { value: 'medium' }, t('modelRoutingOptionMedium')),
          h('option', { value: 'low' }, t('modelRoutingOptionLow')),
        ),
      ),
      h('div', { className: 'agy-model-routing-source' }, sourceCaption),
      error ? h('div', { className: 'agy-error' }, error) : null,
    ),
  )
}

export function MultimodalCard(props: { rpc: AgyRpcClient, t: T }): ReactNode {
  const { rpc, t } = props
  const [view, setView] = useState<MultimodalView | null>(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)
  const [loaded, setLoaded] = useState(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const load = useCallback((): void => {
    void (async () => {
      try {
        const result = await rpc.call('multimodal.get', {})
        if (!alive.current) return
        setView(result)
        setDraft(result.value === null ? '' : String(result.value))
        setError(undefined)
      } catch (caught) {
        if (!alive.current) return
        setError(caught instanceof Error ? caught.message : String(caught))
      } finally {
        if (alive.current) setLoaded(true)
      }
    })()
  }, [rpc])

  useEffect(() => { load() }, [load])

  const commit = (value: number | null): void => {
    void (async () => {
      try {
        const result = await rpc.call('multimodal.set', { maxInlineMb: value })
        if (!alive.current) return
        setView(result)
        setDraft(result.value === null ? '' : String(result.value))
        setError(undefined)
      } catch (caught) {
        if (!alive.current) return
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    })()
  }

  const save = (raw: string): void => {
    const trimmed = raw.trim()
    if (trimmed === '') {
      commit(null)
      return
    }
    const value = Number(trimmed)
    if (!Number.isInteger(value)) {
      setError(t('multimodalInvalid'))
      return
    }
    if (value < MULTIMODAL_MIN_MB || value > MULTIMODAL_MAX_MB) {
      setError(t('multimodalRange', { min: MULTIMODAL_MIN_MB, max: MULTIMODAL_MAX_MB }))
      return
    }
    commit(value)
  }

  const source = view === null
    ? null
    : view.source === 'env'
      ? t('multimodalSourceEnv')
      : view.source === 'stored' ? t('multimodalSourceStored') : t('multimodalSourceDefault', { default: MULTIMODAL_DEFAULT_MB })

  return card(t('multimodalTitle'), [
    h('div', { className: 'agy-thinking-row' },
      h('span', { className: 'agy-thinking-k' }, t('multimodalLabel')),
      h(Input, {
        value: draft,
        placeholder: t('multimodalAuto'),
        inputMode: 'numeric',
        disabled: !loaded,
        onChange: (event: { target: { value: string } }) => { setDraft(event.target.value) },
        onBlur: (event: { target: { value: string } }) => { save(event.target.value) },
      }),
      h('span', { className: 'agy-input-unit' },
        t('multimodalUnit'),
        h('button', {
          type: 'button',
          className: 'agy-thinking-chip',
          onClick: () => { setDraft(''); commit(null) },
        }, t('multimodalClear')))),
    source === null ? null : h('div', { className: 'agy-hint' }, source),
    hint(t('multimodalHint')),
    error === undefined ? null : h('div', { className: 'agy-error' }, error),
  ])
}
