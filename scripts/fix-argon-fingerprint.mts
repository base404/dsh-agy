// Root-cause fix for argon 404: the account's fingerprint UA is a stale SHORT
// shape (`antigravity/1.4.10 darwin/arm64`) that upstream gates new models
// (gemini-4-argon) behind. Regenerate the fingerprint via the current builder
// (hub shape), then verify argon generates at 200.
//
// The old fingerprint is pushed into `fingerprintHistory` (bounded, restorable),
// exactly as the UI "Reset fingerprint" action does.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { refreshAccessToken } from '../src/oauth/refresh.ts'
import { loadMasterKey, resolveDshHome, deriveKey, createAesGcmCodec } from '../src/store/keyring.ts'
import { decryptStorage, JsonAccountStore } from '../src/store/accounts.ts'
import { generateFingerprint, recordFingerprintVersion } from '../src/runtime/fingerprint.ts'
import { currentAgyVersion } from '../src/oauth/constants.ts'
import { toAgyRequestBody } from '../src/adapter/translate.ts'
import { AGY_ENDPOINT_DAILY } from '../src/oauth/constants.ts'

const dshHome = resolveDshHome()
const masterKey = loadMasterKey(dshHome)
if (!masterKey) { console.error('No AGY_MASTER_KEY'); process.exit(1) }
const codec = createAesGcmCodec(deriveKey(masterKey))
const file = join(dshHome, 'agy', 'agy-accounts.json')
const store = new JsonAccountStore({ file, codec })
const storage = decryptStorage(JSON.parse(readFileSync(file, 'utf8')), codec)
const account = storage.accounts[0]
if (!account) { console.error('No accounts'); process.exit(1) }

const oldUA = account.fingerprint?.userAgent
console.log(`account: ${account.email}`)
console.log(`OLD fingerprint UA: ${oldUA ?? '(none)'}`)

// Regenerate exactly as the UI action does (generateFingerprint + record).
const fresh = generateFingerprint(undefined, currentAgyVersion())
await store.mutate((s) => {
  const acc = s.accounts[0]
  if (!acc) return
  acc.fingerprint = fresh
  acc.fingerprintHistory = recordFingerprintVersion(acc.fingerprintHistory, fresh, 'regenerated')
})
console.log(`NEW fingerprint UA: ${fresh.userAgent}`)

// Verify argon now generates.
const r = await refreshAccessToken({ access: '', expires: 0, refresh: account.refresh })
if (r.type !== 'success') { console.error('refresh failed'); process.exit(1) }
const access = r.auth.access
const headers: Record<string, string> = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${access}`,
  Accept: 'text/event-stream',
  'User-Agent': fresh.userAgent,
}
if (fresh.apiClient) headers['X-Goog-Api-Client'] = fresh.apiClient
const body = toAgyRequestBody(
  { provider: 'agy', model: 'gemini-4-argon-medium', messages: [{ id: 't1', role: 'user', content: [{ type: 'text', text: 'Reply with exactly: OK' }] }] } as never,
  { projectId: account.projectId, sessionId: 'argon-fix' },
)
const response = await fetch(`${AGY_ENDPOINT_DAILY}/v1internal:streamGenerateContent?alt=sse`, {
  method: 'POST', headers, body: JSON.stringify(body),
})
await response.text()
console.log(`VERIFY gemini-4-argon-medium with new fingerprint -> HTTP ${response.status} ${response.ok ? '(OK)' : ''}`)
console.log(response.ok
  ? '\nFIXED: argon now generates with the regenerated (hub-shape) fingerprint.'
  : '\nNOT fixed — argon still rejected after regeneration.')
process.exit(response.ok ? 0 : 1)