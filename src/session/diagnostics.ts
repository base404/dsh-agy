/**
 * Test call, credential verification, health check loop, and blob export.
 */

import type { AgyAccountSession, ManagedAccount, OAuthAuthDetails } from '../types.ts'
import type { AccountStore } from '../store/accounts.ts'
import { deriveAntigravitySessionId, generateAntigravityRequestId } from '../runtime/identity.ts'
import { accountFetch, proxiedFetch } from '../proxy.ts'
import { parseRefreshParts } from '../oauth/auth.ts'
import type { AccountHealthResult, UsageRecord } from './types.ts'

export interface DiagnosticsDeps {
  store: AccountStore
  getSession: (model?: string, accountIndex?: number) => Promise<AgyAccountSession | undefined>
  accessTokenFor: (account: ManagedAccount) => Promise<OAuthAuthDetails | undefined>
  emitUsage: (record: UsageRecord) => void
  onHealthReport?: (results: AccountHealthResult[]) => void
}

/**
 * Test call: one short streaming request against the live backend.
 * Returns the collected text or a structured error message.
 */
export async function testCall(
  model: string,
  options: {
    prompt?: string
    maxTokens?: number
    accountIndex?: number
    signal?: AbortSignal
    idleTimeoutMs?: number
  } = {},
  deps: DiagnosticsDeps,
): Promise<{ ok: boolean; text?: string; error?: string }> {
  const prompt = options.prompt ?? 'Reply with exactly: OK'
  const maxTokens = options.maxTokens ?? 1024
  const startedAt = Date.now()
  let session: AgyAccountSession | undefined
  try {
    session = await deps.getSession(model, options.accountIndex)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  if (!session) return { ok: false, error: 'No agy account configured — run `dsh-agy login` first.' }
  try {
    const account = session.account.email ?? session.account.id
    const { toAgyRequestBody } = await import('../adapter/translate.ts')
    const { fetchAgyFirstOk } = await import('../oauth/constants.ts')
    const { parseAgySse } = await import('../adapter/parse.ts')
    const requestId = generateAntigravityRequestId()
    const body = toAgyRequestBody(
      {
        provider: 'agy',
        model,
        messages: [{ id: 'test-1', role: 'user', content: [{ type: 'text', text: prompt }] }],
        maxTokens,
      } as never,
      {
        projectId: session.account.projectId,
        sessionId: deriveAntigravitySessionId(session.account.email) ?? undefined,
        requestId,
      },
    )
    const headers = {
      authorization: `Bearer ${session.auth.access}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'User-Agent': session.impersonation['User-Agent'],
      'X-Goog-Api-Client': session.impersonation['X-Goog-Api-Client'],
    }
    const routing = { proxyUrl: session.account.proxy, streaming: true }
    const response = await fetchAgyFirstOk(
      '/v1internal:streamGenerateContent?alt=sse',
      {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: options.signal,
      },
      accountFetch(routing),
      routing,
    )
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      deps.emitUsage({ account, model, source: 'test', ok: false, latencyMs: Date.now() - startedAt })
      return { ok: false, error: `HTTP ${response.status}: ${text.slice(0, 300)}` }
    }
    if (!response.body) {
      deps.emitUsage({ account, model, source: 'test', ok: false, latencyMs: Date.now() - startedAt })
      return { ok: false, error: 'no response body' }
    }
    const text: string[] = []
    let usage: UsageRecord['usage']
    let ttftMs: number | undefined
    for await (const chunk of parseAgySse(response.body, {
      signal: options.signal,
      idleTimeoutMs: options.idleTimeoutMs,
    })) {
      if (chunk.type === 'usage') {
        usage = {
          input: chunk.usage.inputTokens,
          output: chunk.usage.outputTokens,
          cacheRead: chunk.usage.cacheReadTokens ?? 0,
          cacheWrite: chunk.usage.cacheWriteTokens ?? 0,
        }
      } else if (chunk.type === 'text-delta') {
        if (ttftMs === undefined) ttftMs = Date.now() - startedAt
        text.push(chunk.text)
      }
    }
    const ok = text.length > 0
    deps.emitUsage({
      account, model, source: 'test', ok,
      ...(usage === undefined ? {} : { usage }),
      ...(ttftMs === undefined ? {} : { ttftMs }),
      latencyMs: Date.now() - startedAt,
    })
    return { ok, text: text.join(''), error: ok ? undefined : 'empty response' }
  } catch (error) {
    deps.emitUsage({ source: 'test', ok: false, latencyMs: Date.now() - startedAt })
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Export one account as a paste-credential blob (for migration to another host). */
export async function exportBlob(
  index: number,
  deps: Pick<DiagnosticsDeps, 'store' | 'accessTokenFor'>,
): Promise<{ blob?: string; error?: string }> {
  const storage = await deps.store.load()
  const account = storage.accounts[index]
  if (!account) return { error: 'account not found' }
  try {
    const auth = await deps.accessTokenFor(account)
    if (!auth) return { error: 'refresh failed (revoked?)' }
    const { encodeCredentialBlob } = await import('../oauth/blob.ts')
    const parts = parseRefreshParts(account.refresh)
    return {
      blob: encodeCredentialBlob('agy', {
        access_token: auth.access,
        refresh_token: parts.refreshToken,
        expires_in: Math.max(0, Math.round((auth.expires - Date.now()) / 1000)),
      }),
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/** Probe one account: refresh + userinfo; a live credential re-enables the account. */
export async function probeAccount(
  index: number,
  account: ManagedAccount,
  deps: Pick<DiagnosticsDeps, 'store' | 'accessTokenFor' | 'emitUsage'>,
): Promise<{ ok: boolean; email?: string; error?: string }> {
  const startedAt = Date.now()
  const key = account.email ?? account.id
  try {
    const auth = await deps.accessTokenFor(account)
    if (!auth) {
      deps.emitUsage({ account: key, source: 'verify', ok: false, latencyMs: Date.now() - startedAt })
      return { ok: false, error: 'refresh failed (revoked?)' }
    }
    const response = await proxiedFetch('https://www.googleapis.com/oauth2/v1/userinfo?alt=json', {
      headers: { Authorization: `Bearer ${auth.access}` },
    }, account.proxy ? { proxyUrl: account.proxy } : undefined)
    if (!response.ok) {
      deps.emitUsage({ account: key, source: 'verify', ok: false, latencyMs: Date.now() - startedAt })
      return { ok: false, error: `userinfo ${response.status}` }
    }
    const info = (await response.json()) as { email?: string }
    // Credentials are live again — clear any auth-failure disable so the
    // account re-enters rotation without a manual re-import.
    await deps.store.mutate((s) => {
      const target = s.accounts[index]
      if (target) {
        target.enabled = true
        target.verificationRequired = false
        target.verificationRequiredAt = undefined
        target.verificationRequiredReason = undefined
        target.verificationUrl = undefined
      }
    })
    deps.emitUsage({ account: info.email ?? key, source: 'verify', ok: true, latencyMs: Date.now() - startedAt })
    return { ok: true, email: info.email }
  } catch (error) {
    deps.emitUsage({ account: key, source: 'verify', ok: false, latencyMs: Date.now() - startedAt })
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** CLI/web helper: verify an account's credentials (refresh + userinfo). */
export async function verifyAccount(
  index: number,
  deps: Pick<DiagnosticsDeps, 'store' | 'accessTokenFor' | 'emitUsage'>,
): Promise<{ ok: boolean; email?: string; error?: string }> {
  const storage = await deps.store.load()
  const account = storage.accounts[index]
  if (!account) return { ok: false, error: 'account not found' }
  return probeAccount(index, account, deps)
}

/**
 * Batch health check over all enabled accounts (or the given indices):
 * refresh + userinfo per account, live credentials re-enable the account.
 */
export async function checkAccounts(
  indices: number[] | undefined,
  deps: DiagnosticsDeps,
): Promise<AccountHealthResult[]> {
  const storage = await deps.store.load()
  const targets = indices !== undefined
    ? indices.filter((index) => storage.accounts[index])
    : storage.accounts.map((_, index) => index).filter((index) => storage.accounts[index]!.enabled !== false)

  const results: AccountHealthResult[] = await Promise.all(targets.map(async (index) => {
    const probed = await probeAccount(index, storage.accounts[index]!, deps)
    return { index, ...probed }
  }))
  deps.onHealthReport?.(results)
  return results
}

/**
 * Start a background health probe on an interval (disposable stop handle).
 */
export function startHealthProbe(
  intervalMs: number,
  options: { unref?: boolean } = {},
  deps: DiagnosticsDeps,
): () => void {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return () => {}
  const timer = setInterval(() => {
    void checkAccounts(undefined, deps).catch(() => {})
  }, intervalMs)
  if (options.unref !== false) timer.unref?.()
  return () => clearInterval(timer)
}
