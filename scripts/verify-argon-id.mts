// Measure which model id `streamGenerateContent` actually accepts for the
// Gemini 4 Argon family on the ACTIVE account.
//
// Background (issue: argon selection yields `agy upstream error (404):
// Requested entity was not found. [NOT_FOUND]`): the pinned catalog
// (`catalog.ts`) lists `gemini-4-argon-low/-medium/-high`, and discovery
// (`fetchAvailableModels`) advertises those ids on a provisioned account —
// yet the generation endpoint rejects every one with 404 NOT_FOUND. A second
// account shows `gemini-4-argon-disabled` (a `-disabled` gating suffix), so
// the real argon id shape is in doubt.
//
// This script fires one minimal generation probe per candidate id and prints
// status + error code. A 200 identifies the id the adapter must send.
//
// Requires a real account. Usage: pnpm run verify:argon-id
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { refreshAccessToken } from '../src/oauth/refresh.ts'
import { loadMasterKey, resolveDshHome, deriveKey, createAesGcmCodec } from '../src/store/keyring.ts'
import { decryptStorage } from '../src/store/accounts.ts'
import { toAgyRequestBody } from '../src/adapter/translate.ts'
import { AGY_ENDPOINT_DAILY } from '../src/oauth/constants.ts'

const dshHome = resolveDshHome()
const masterKey = loadMasterKey(dshHome)
if (!masterKey) {
  console.error('No AGY_MASTER_KEY — run `dsh-agy login` first.')
  process.exit(1)
}
const codec = createAesGcmCodec(deriveKey(masterKey))
const storage = decryptStorage(JSON.parse(readFileSync(join(dshHome, 'agy', 'agy-accounts.json'), 'utf8')), codec)
const account = storage.accounts[0]
if (!account) {
  console.error('No accounts. Run `dsh-agy login`.')
  process.exit(1)
}

const refreshed = await refreshAccessToken({ access: '', expires: 0, refresh: account.refresh })
if (refreshed.type !== 'success') {
  console.error('refresh failed')
  process.exit(1)
}
const access = refreshed.auth.access

// Replicate the adapter's real wire identity (account fingerprint), not a
// generic CLI UA — the impersonation surface is exactly two headers.
const fp = account.fingerprint
const headers: Record<string, string> = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${access}`,
  Accept: 'text/event-stream',
}
if (fp) {
  headers['User-Agent'] = fp.userAgent
  headers['X-Goog-Api-Client'] = fp.apiClient
} else {
  headers['User-Agent'] = 'antigravity/cli/1.19.0 (aidev_client; os_type=macos; arch=arm64; auth_method=consumer)'
}

console.log(`account: ${account.email}  projectId=${account.projectId}`)
console.log(`cached argon ids in store discovery snapshot: ${
  (account.cachedModels ?? []).filter((m: string) => /argon/i.test(m)).join(', ') || '(none)'}`)

// Confirm the LIVE discovery still advertises argon (cachedModels may be stale).
try {
  const disc = await fetch(`${AGY_ENDPOINT_DAILY}/v1internal:fetchAvailableModels`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${access}`,
      'User-Agent': headers['User-Agent'],
    },
    body: JSON.stringify(account.projectId ? { project: account.projectId } : {}),
  })
  if (disc.ok) {
    const body = (await disc.json()) as { models?: Record<string, unknown> }
    const argonIds = Object.keys(body.models ?? {}).filter((m) => /argon/i.test(m))
    console.log(`live discovery argon ids: ${argonIds.join(', ') || '(none)'}`)
    const all = Object.keys(body.models ?? {}).filter((m) => /gemini|argon|gpt|claude/i.test(m))
    console.log(`\nALL live discovery model ids (${all.length}):`)
    for (const id of all) console.log(`  - ${id}`)
  } else {
    console.log(`live discovery HTTP ${disc.status} (could not confirm)`)
  }
} catch (error) {
  console.log(`live discovery error: ${(error as Error).message}`)
}

const CANDIDATES = [
  // control — known-good Gemini id on this endpoint
  'gemini-3-flash-agent',
  // current pinned catalog shape (issue: all 404)
  'gemini-4-argon-low',
  'gemini-4-argon-medium',
  'gemini-4-argon-high',
  // no-level / other plausible shapes
  'gemini-4-argon',
  'gemini-4-argon-tiered',
  'gemini-4-argon-preview',
  'gemini-argon',
  'gemini-argon-medium',
  'gemini-argon-low',
  // the gating id observed on a non-provisioned account
  'gemini-4-argon-disabled',
  'gemini-argon-disabled',
  // -trial variants (user reports gemini-4 is only generatable via -trial)
  'gemini-4-argon-trial',
  'gemini-4-argon-trial-low',
  'gemini-4-argon-trial-medium',
  'gemini-4-argon-trial-high',
  'gemini-argon-trial',
  // non-argon gemini-4 / gemini-4.0 families, incl. -trial (user hint)
  'gemini-4-trial',
  'gemini-4.0-trial',
  'gemini-4-flash-trial',
  'gemini-4-pro-trial',
  'gemini-4-nano-trial',
  'gemini-4.0-argon',
  'gemini-4.0-argon-trial',
]

async function statusFor(model: string): Promise<{ status: number; code?: string; message?: string }> {
  const body = toAgyRequestBody(
    {
      provider: 'agy',
      model,
      messages: [{ id: 't1', role: 'user', content: [{ type: 'text', text: 'Reply with exactly: OK' }] }],
    } as never,
    { projectId: account.projectId, sessionId: 'verify-argon-id' },
  )
  const response = await fetch(`${AGY_ENDPOINT_DAILY}/v1internal:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let code: string | undefined
  let message: string | undefined
  try {
    const parsed = JSON.parse(text) as { error?: { status?: string; message?: string } }
    code = parsed.error?.status
    message = parsed.error?.message
  } catch {
    // SSE success stream or non-JSON error body — leave code undefined
  }
  return { status: response.status, code, message }
}

let argonAccepted = 0
let controlPass = false
for (const model of CANDIDATES) {
  try {
    const { status, code, message } = await statusFor(model)
    const ok = status === 200
    if (model.startsWith('gemini-3-')) {
      controlPass = ok
    } else if (ok) {
      argonAccepted++
    }
    console.log(
      `${ok ? 'ACCEPT' : 'REJECT '} ${status}  ${model.padEnd(28)} ${code ?? ''}${message ? ' — ' + message.slice(0, 120) : ''}`,
    )
  } catch (error) {
    console.log(`ERROR    ${model}: ${(error as Error).message}`)
  }
}

if (!controlPass) {
  console.log('\nFAIL control model gemini-3-flash-agent did not pass — probe itself is suspect')
} else if (argonAccepted === 0) {
  console.log('\nNo argon id accepted (404 NOT_FOUND everywhere). Argon is advertised in discovery but NOT generatable on this account.')
} else {
  console.log(`\n${argonAccepted} argon id(s) accepted by streamGenerateContent. Update catalog.ts to the accepted id(s).`)
}
process.exit(!controlPass ? 1 : 0)