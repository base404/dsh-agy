/**
 * Action handlers factory for account-level mutations and operations.
 */

import { useMemo } from 'react'
import type { AccountHandlers, T } from './types.ts'
import type { AgyRpcClient, ModelView } from '../rpc-contract.ts'

export interface CreateAccountHandlersOptions {
  rpc: AgyRpcClient
  t: T
  models: ModelView[]
  alive: { current: boolean }
  act: (run: () => Promise<unknown>) => Promise<void>
  runAction: (run: () => Promise<void>) => Promise<void>
  refresh: () => Promise<void>
  loadModels: () => Promise<void>
  loadLimits: (force?: boolean, report?: boolean, index?: number, auto?: boolean) => Promise<void>
  copyText: (text: string) => Promise<void>
  setNotice: (text: string | undefined) => void
  setActionError: (text: string | undefined) => void
}

export function useAccountHandlers(options: CreateAccountHandlersOptions): AccountHandlers {
  const {
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
    setActionError,
  } = options

  return useMemo(() => ({
    t,
    onActivate: (index: number) => {
      void act(async () => {
        try {
          await rpc.call('account.activate', { index })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (msg.includes('quota exhausted') || msg.includes('cooling down')) {
            return
          }
          throw err
        }
      }).then(() => {
        window.dispatchEvent(new CustomEvent('agy:account-changed', { detail: { index } }))
        void loadModels()
      })
    },
    onRecover: (index: number) => {
      void act(() => rpc.call('account.recover', { index }))
    },
    onVerify: (index: number) => {
      void runAction(async () => {
        const result = await rpc.call('account.verify', { index })
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
      void runAction(async () => {
        const listed = models.length > 0 ? models : (await rpc.call('model.list', {})).models
        const target = listed.find((entry) => !entry.disabled)?.id
        if (target === undefined) throw new Error(t('noModelToTest'))
        const result = await rpc.call('account.test', { model: target, index })
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
    onTestProxy: (index: number, proxy: string) => {
      void runAction(async () => {
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
    onRefreshLimits: (index: number) => { void loadLimits(true, true, index) },
  }), [act, alive, copyText, loadLimits, loadModels, models, refresh, rpc, runAction, setActionError, setNotice, t])
}
