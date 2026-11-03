/**
 * Shared types, RPC definitions, and slot module augmentations for the client UI.
 */

import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AgyLocaleKey } from './locales.ts'
import type { AgyRpcClient, AgyRpcResult } from '../rpc-contract.ts'

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

/** Dictionary namespace this plugin owns. */
export const NS = 'agy'

/** This section's translator. */
export type T = TranslateNS<typeof NS>

/** One row of the recent-activity list (`pool.recent`). */
export type RecentEntry = AgyRpcResult<'pool.recent'>['recent'][number]

/** RPC channel and endpoint the host registers as `/api/agy`. */
export const RPC_CHANNEL = '/api'
export const RPC_ENDPOINT = 'agy'

export type TabId = 'accounts' | 'models' | 'config' | 'usage' | 'credentials'

/**
 * How long a one-shot action's verdict stays on screen.
 */
export const ACTION_MESSAGE_TTL_MS = 3_500

/**
 * How often the section re-reads the pool's in-flight snapshot.
 */
export const POOL_POLL_INTERVAL_MS = 3_000

/** Connection shape this plugin needs (structural, so no host-only import). */
export interface ConnectionLike {
  rpc: {
    call: (channel: string, endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>
  }
}

/** Call one management method and unwrap the Connection RPC envelope. */
export function createRpc(connection: ConnectionLike): AgyRpcClient {
  return {
    async call(method, payload, signal) {
      const raw = await connection.rpc.call(
        RPC_CHANNEL,
        RPC_ENDPOINT,
        { method, payload },
        signal,
      ) as { ok?: boolean; value?: unknown; error?: { message?: string } } | undefined
      if (raw?.ok === true) return raw.value as never
      if (raw?.ok === false) throw new Error(raw.error?.message ?? `${method} failed`)
      // An unrecognized envelope means the transport misbehaved; surfacing it
      // beats returning undefined as though the call had succeeded.
      throw new Error(`${method}: malformed RPC response`)
    },
  }
}

export interface AccountHandlers {
  /** Localized copy, resolved per render so a language switch applies. */
  t: T
  onActivate: (index: number) => void
  /** Lift a cooling account's cooldown and rate-limit walls (manual recovery). */
  onRecover: (index: number) => void
  onVerify: (index: number) => void
  onDelete: (index: number) => void
  onTest: (index: number) => void
  onExport: (index: number) => void
  onRegenerateFingerprint: (index: number) => void
  onSetProxy: (index: number, proxy: string) => void
  /**
   * Probe a proxy. The draft is passed alongside the index so an UNSAVED value
   * can be tested; an empty string means "use the account's stored proxy".
   */
  onTestProxy: (index: number, proxy: string) => void
  /**
   * Force a quota refresh for THIS account (the limits card's refresh button).
   */
  onRefreshLimits: (index: number) => void
}
