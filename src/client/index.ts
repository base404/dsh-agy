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

import { useMemo } from 'react'
import type { ReactNode } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { installAgyStyles } from './styles.ts'
import { en, zh, type AgyLocaleKey } from './locales.ts'
import { h } from './element.ts'
import { AgyQuotaBadge } from './quota-badge.ts'
import type {
  AgyRpcClient,
  ModelView,
  UiPrefsView,
} from '../rpc-contract.ts'
import {
  createRpc,
  NS,
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
import { useAgySettingsState } from './settings-state.ts'
import { useAccountHandlers } from './account-actions.ts'

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
  const state = useAgySettingsState({ rpc, t })
  const {
    tab,
    setTab,
    accounts,
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
    busy,
    loaded,
    detailedQuotaReset,
    setDetailedQuotaReset,
    smartPausedUntil,
    smartIdlePaused,
    alive,
    act,
    runAction,
    refresh,
    refreshAll,
    loadModels,
    loadLimits,
    startLogin,
    copyText,
  } = state

  const handlers = useAccountHandlers({
    rpc,
    t,
    models,
    alive,
    act,
    runAction,
    refresh,
    loadModels,
    loadLimits,
    copyText,
    setNotice,
    setActionError: state.setActionError,
  })

  const onToggleModel = (modelId: string, disabled: boolean): void => {
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
  }

  const onTestModel = (modelId: string): void => {
    setError(undefined)
    setNotice(undefined)
    setModelTesting((current) => new Set(current).add(modelId))
    void (async () => {
      try {
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
  }

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
          pending: toggling,
          testing: modelTesting,
          t,
          onToggle: onToggleModel,
          onTestModel,
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
        button(t('refresh'), refreshAll, { size: 'sm', disabled: busy }),
        button(t('login'), startLogin, { size: 'sm', disabled: busy }))),
    h('div', { className: 'agy-tabs' },
      tabButton('accounts', t('tabAccounts'), accounts.length),
      tabButton('models', t('tabModels'), models.length > 0 ? models.length : undefined),
      tabButton('config', t('tabConfig')),
      tabButton('usage', t('tabUsage')),
      tabButton('credentials', t('tabCredentials'))),
    error === undefined ? null : h('div', { className: 'agy-error' }, error),
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
  const t = ctx.locale.bind(NS)
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
