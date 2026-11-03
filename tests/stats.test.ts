import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DAY_WINDOW,
  RECENT_MAX,
  UsageStats,
  applyRecord,
  foldWindow,
  noopStatsLock,
  parseStatsDocument,
  properStatsLock,
  type StatsDocument,
} from '../src/stats.ts'
import { ModelVisibility, parseModelVisibility, sanitizeDisabledModels } from '../src/model-visibility.ts'

function scratch(): { dir: string, file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'agy-stats-test-'))
  return { dir, file: join(dir, 'agy-stats.json') }
}

/** A store with deterministic time and no throttling, for exact assertions. */
function storeAt(file: string, clock: () => number): UsageStats {
  return new UsageStats({ file, lock: noopStatsLock, now: clock, flushEvery: 0, flushIntervalMs: 0 })
}

describe('recent activity ring', () => {
  it('keeps the newest records, newest first, and never touches disk', () => {
    const { file } = scratch()
    let tick = 0
    const store = storeAt(file, () => 1_700_000_000_000 + tick++ * 1_000)
    store.record({ account: 'a@x', model: 'm1', source: 'chat', ok: true, usage: { input: 1, output: 5, cacheRead: 0, cacheWrite: 0 }, latencyMs: 900, ttftMs: 300 })
    store.record({ account: 'b@y', model: 'm2', source: 'test', ok: false, rateLimited: true, reason: 'rate-limit' })
    store.record({ account: 'b@y', source: 'chat', ok: false, poolEvent: true, rotated: true, reason: 'network-error' })
    const recent = store.recentRequests()
    // Newest first, and a pool event shows as its own kind rather than a request.
    expect(recent.map((entry) => entry.kind)).toEqual(['rotation', 'test', 'chat'])
    // The rotation row carries the cause; a success row carries none.
    expect(recent[0]).toMatchObject({ kind: 'rotation', account: 'b@y', ok: false, reason: 'network-error' } as never)
    expect(recent[1]).toMatchObject({ kind: 'test', ok: false, rateLimited: true, reason: 'rate-limit', output: null, latencyMs: null } as never)
    expect(recent[2]).toMatchObject({ kind: 'chat', ok: true, reason: null, latencyMs: 900, ttftMs: 300, output: 5 } as never)
    // The ring is in-memory only: recording must not create the file.
    expect(existsSync(file)).toBe(false)
  })

  it('caps the ring at RECENT_MAX, keeping the newest', () => {
    const { file } = scratch()
    let tick = 0
    const store = storeAt(file, () => 1_700_000_000_000 + tick++ * 1_000)
    for (let i = 0; i < RECENT_MAX + 5; i++) {
      store.record({ account: `a${i}@x`, source: 'chat', ok: true })
    }
    const recent = store.recentRequests()
    expect(recent).toHaveLength(RECENT_MAX)
    // Newest first: the five oldest entries were evicted.
    expect(recent[0]?.account).toBe(`a${RECENT_MAX + 4}@x`)
    expect(recent[recent.length - 1]?.account).toBe('a5@x')
  })

  it('returns a copy, so the caller cannot mutate the ring', () => {
    const { file } = scratch()
    const store = storeAt(file, () => 1_700_000_000_000)
    store.record({ account: 'a@x', source: 'chat', ok: true })
    store.recentRequests().pop()
    expect(store.recentRequests()).toHaveLength(1)
  })
})

describe('usage ledger', () => {
  it('records on the hot path without touching disk, then flushes', () => {
    const { file } = scratch()
    const store = storeAt(file, () => Date.UTC(2026, 8, 23, 12))
    store.record({ account: 'a@x', model: 'm1', source: 'chat', ok: true, usage: { input: 10, output: 2, cacheRead: 5, cacheWrite: 0 } })
    // Nothing is written until a flush: the generation path stays I/O-free.
    expect(existsSync(file)).toBe(false)
    expect(store.pendingCount).toBe(1)
    store.flushSync()
    expect(existsSync(file)).toBe(true)
    expect(store.pendingCount).toBe(0)
    expect(JSON.parse(readFileSync(file, 'utf8')).totals.requests).toBe(1)
  })

  it('reads the ledger from disk so another process writer is visible', () => {
    // The web plugin and the CLI are separate processes; an in-memory cache
    // would show a stale (or empty) ledger to whichever did not generate.
    const { file } = scratch()
    const clock = (): number => Date.UTC(2026, 8, 23, 12)
    const writer = storeAt(file, clock)
    writer.record({ account: 'a@x', source: 'chat', ok: true })
    writer.flushSync()

    const reader = storeAt(file, clock)
    expect(reader.snapshot().totals.requests).toBe(1)
  })

  it('merges concurrent writers instead of overwriting them', () => {
    const { file } = scratch()
    const clock = (): number => Date.UTC(2026, 8, 23, 12)
    const first = storeAt(file, clock)
    const second = storeAt(file, clock)

    first.record({ account: 'a@x', source: 'chat', ok: true })
    first.flushSync()
    second.record({ account: 'b@y', source: 'cli', ok: true })
    second.flushSync()
    // A last-write-wins flush would have dropped `a@x` here.
    first.record({ account: 'a@x', source: 'chat', ok: true })
    first.flushSync()

    const doc = JSON.parse(readFileSync(file, 'utf8'))
    expect(doc.totals.requests).toBe(3)
    expect(Object.keys(doc.accounts).sort()).toEqual(['a@x', 'b@y'])
  })

  it('separates the four token buckets and counts failures by kind', () => {
    const { file } = scratch()
    const store = storeAt(file, () => Date.UTC(2026, 8, 23, 12))
    store.record({
      account: 'a@x', model: 'm1', source: 'chat', ok: true,
      usage: { input: 100, output: 40, cacheRead: 900, cacheWrite: 7 },
      latencyMs: 1500, ttftMs: 600,
    })
    store.record({ account: 'a@x', model: 'm1', source: 'chat', ok: false, rateLimited: true })
    store.flushSync()

    const doc = JSON.parse(readFileSync(file, 'utf8'))
    const totals = doc.accounts['a@x'].totals
    expect(totals).toMatchObject({
      input: 100, output: 40, cacheRead: 900, cacheWrite: 7,
      requests: 2, succeeded: 1, failed: 1, rateLimited: 1,
      latencyMs: 1500, latencyN: 1, ttftMs: 600, ttftN: 1,
    })
    expect(doc.accounts['a@x'].models.m1.requests).toBe(2)
  })

  it('attributes usage to the model actually used, so a mid-session switch splits', () => {
    const { file } = scratch()
    const store = storeAt(file, () => Date.UTC(2026, 8, 23, 12))
    store.record({ account: 'a@x', model: 'model-a', source: 'chat', ok: true })
    store.record({ account: 'a@x', model: 'model-b', source: 'chat', ok: true })
    store.flushSync()
    const models = JSON.parse(readFileSync(file, 'utf8')).accounts['a@x'].models
    expect(Object.keys(models).sort()).toEqual(['model-a', 'model-b'])
  })

  it('counts a pool event as a rotation without inflating the request count', () => {
    // The adapter already recorded the request that failed; counting the pool
    // event as a request too would double it.
    const { file } = scratch()
    const store = storeAt(file, () => Date.UTC(2026, 8, 23, 12))
    store.record({ account: 'a@x', source: 'chat', ok: false, rotated: true, poolEvent: true })
    store.flushSync()
    const totals = JSON.parse(readFileSync(file, 'utf8')).totals
    expect(totals.requests).toBe(0)
    expect(totals.rotations).toBe(1)
  })

  it('rolls day buckets out of the window while keeping all-time totals', () => {
    const { file } = scratch()
    let clock = Date.UTC(2026, 8, 23, 12)
    const store = storeAt(file, () => clock)
    store.record({ account: 'a@x', source: 'chat', ok: true })
    store.flushSync()

    clock += (DAY_WINDOW + 5) * 86_400_000
    store.record({ account: 'a@x', source: 'chat', ok: true })
    store.flushSync()

    const doc = JSON.parse(readFileSync(file, 'utf8'))
    // Only the recent day survives, but the total still counts both.
    expect(Object.keys(doc.days)).toHaveLength(1)
    expect(doc.totals.requests).toBe(2)
  })

  it('folds day windows independently of the all-time total', () => {
    const doc: StatsDocument = parseStatsDocument('{}', Date.UTC(2026, 8, 23, 12))
    const now = Date.UTC(2026, 8, 23, 12)
    applyRecord(doc, { source: 'chat', ok: true }, now)
    applyRecord(doc, { source: 'chat', ok: true }, now - 10 * 86_400_000)
    expect(doc.totals.requests).toBe(2)
    expect(foldWindow(doc, 1, now).requests).toBe(1)
    expect(foldWindow(doc, 7, now).requests).toBe(1)
    expect(foldWindow(doc, 30, now).requests).toBe(2)
  })

  it('survives a corrupt ledger file rather than failing the caller', () => {
    const { file } = scratch()
    writeFileSync(file, '{ this is not json')
    const store = storeAt(file, () => Date.UTC(2026, 8, 23, 12))
    expect(store.snapshot().totals.requests).toBe(0)
    store.record({ source: 'chat', ok: true })
    store.flushSync()
    expect(JSON.parse(readFileSync(file, 'utf8')).totals.requests).toBe(1)
  })

  it('rejects a malformed document field-by-field', () => {
    const doc = parseStatsDocument(JSON.stringify({
      totals: { input: -5, output: 'nope', requests: 3 },
      days: { 'not-a-date': { requests: 9 }, '2026-09-23': { requests: 1 } },
      accounts: { 'a@x': null },
    }), Date.UTC(2026, 8, 23, 12))
    // Negative and non-numeric counters are dropped, valid ones survive.
    expect(doc.totals.input).toBe(0)
    expect(doc.totals.output).toBe(0)
    expect(doc.totals.requests).toBe(3)
    // A non-date key is discarded so it cannot grow the file indefinitely.
    expect(Object.keys(doc.days)).toEqual(['2026-09-23'])
    expect(doc.accounts['a@x']?.totals.requests).toBe(0)
  })

  it('flushes through the REAL cross-process lock', () => {
    // Regression: every other test injects `noopStatsLock`, so the production
    // lock path was untested. `proper-lockfile`'s sync API rejects a `retries`
    // option outright ("Cannot use retries with the sync api"), which made every
    // flush throw and silently dropped every count.
    const { file } = scratch()
    const store = new UsageStats({
      file,
      lock: properStatsLock,
      now: () => Date.UTC(2026, 8, 23, 12),
      flushEvery: 0,
      flushIntervalMs: 0,
    })
    store.record({
      account: 'a@x', model: 'm1', source: 'chat', ok: true,
      usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0 },
    })
    store.flushSync()

    expect(store.flushError).toBeUndefined()
    expect(store.pendingCount).toBe(0)
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    expect(doc.totals.requests).toBe(1)
    // Owner-only is POSIX-only: Windows skips these checks by design (keyring.ts),
    // and its mode bits are not a permission model. Matches tests/store.test.ts.
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600)
    }
  })

  it('merges two concurrent writers through the real lock', () => {
    const { file } = scratch()
    const clock = (): number => Date.UTC(2026, 8, 23, 12)
    const options = { file, lock: properStatsLock, now: clock, flushEvery: 0, flushIntervalMs: 0 }
    const first = new UsageStats(options)
    const second = new UsageStats(options)

    first.record({ account: 'a@x', source: 'chat', ok: true })
    first.flushSync()
    second.record({ account: 'b@y', source: 'cli', ok: true })
    second.flushSync()
    first.record({ account: 'a@x', source: 'chat', ok: true })
    first.flushSync()

    // A last-write-wins flush would have dropped a count here.
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    expect(doc.totals.requests).toBe(3)
    expect(Object.keys(doc.accounts).sort()).toEqual(['a@x', 'b@y'])
  })

  it('does not create the ledger file just by constructing the store', () => {
    // A read-only command (`status`) builds a ledger and must leave no state.
    const { file } = scratch()
    storeAt(file, () => Date.now())
    expect(existsSync(file)).toBe(false)
  })

  it('caps the pending backlog instead of growing without bound', () => {
    // A persistently unwritable ledger (read-only $DSH_HOME, ENOSPC) fails every
    // flush, so the backlog would otherwise grow forever in a long-lived process.
    const { file } = scratch()
    const store = new UsageStats({
      file,
      lock: noopStatsLock,
      now: () => Date.UTC(2026, 8, 23, 12),
      flushEvery: 0,
      flushIntervalMs: 0,
      maxPending: 10,
    })
    for (let i = 0; i < 50; i++) store.record({ source: 'chat', ok: true })
    expect(store.pendingCount).toBe(10)
  })

  it('suspends count-based flushing once writes fail, so record() stays I/O-free', () => {
    // The failure this pins: with count-based flushing still armed, a failing
    // ledger made EVERY record() attempt a full synchronous flush (stat + lock +
    // read + write), turning the generation hot path into disk I/O.
    const { dir } = scratch()
    const file = join(dir, 'agy-stats.json')
    // A directory where the file should be: every existsSync/write attempt fails.
    mkdirSync(file, { recursive: true })
    let attempts = 0
    const store = new UsageStats({
      file,
      lock: { withLock: (_file, fn) => { attempts += 1; return fn() } },
      now: () => Date.UTC(2026, 8, 23, 12),
      flushEvery: 1,
      flushIntervalMs: 0,
      maxPending: 100,
    })
    store.record({ source: 'chat', ok: true })
    expect(attempts).toBe(1)
    expect(store.flushFailing).toBe(true)
    // Count-based flushing is now off: further records accumulate in memory.
    for (let i = 0; i < 5; i++) store.record({ source: 'chat', ok: true })
    expect(attempts, 'record() must not keep attempting synchronous flushes').toBe(1)
    expect(store.pendingCount).toBe(6)
  })

  it('reports the first flush failure of a run exactly once', () => {
    // A silent ledger is the failure mode this exists to prevent: counts simply
    // stop appearing with nothing anywhere to correlate. Once per run, not per
    // retry, because the timer retries every flushIntervalMs.
    const { dir } = scratch()
    const file = join(dir, 'agy-stats.json')
    mkdirSync(file, { recursive: true })
    const reported: unknown[] = []
    const store = new UsageStats({
      file,
      lock: noopStatsLock,
      now: () => Date.UTC(2026, 8, 23, 12),
      flushEvery: 0,
      flushIntervalMs: 0,
      onFlushError: (error) => { reported.push(error) },
    })
    store.record({ source: 'chat', ok: true })
    store.flushSync()
    store.record({ source: 'chat', ok: true })
    store.flushSync()
    expect(reported).toHaveLength(1)
    expect(store.flushError).toBeDefined()
  })

  it('recovers: a successful flush clears the failure state and re-arms flushing', () => {
    const { dir } = scratch()
    const file = join(dir, 'agy-stats.json')
    mkdirSync(file, { recursive: true })
    const store = new UsageStats({
      file,
      lock: noopStatsLock,
      now: () => Date.UTC(2026, 8, 23, 12),
      flushEvery: 1,
      flushIntervalMs: 0,
      maxPending: 100,
    })
    store.record({ source: 'chat', ok: true })
    expect(store.flushFailing).toBe(true)

    // Clear the obstruction: the next flush succeeds and everything pending
    // (including the batch that failed) lands.
    rmdirSync(file)
    store.flushSync()
    expect(store.flushFailing).toBe(false)
    expect(store.pendingCount).toBe(0)
    expect(JSON.parse(readFileSync(file, 'utf8')).totals.requests).toBe(1)
  })

  it('tracks lastModelUsedAt and falls back to account snapshot on cold restart', () => {
    const { dir } = scratch()
    const file = join(dir, 'agy-stats.json')
    const t0 = 1700000000000
    const store = new UsageStats({
      file,
      lock: noopStatsLock,
      now: () => t0,
      flushEvery: 1,
      flushIntervalMs: 0,
    })
    expect(store.getLastModelUsedAt()).toBeNull()

    store.record({ source: 'chat', ok: true, account: 'acc1', model: 'gemini-2.5-flash' })
    expect(store.getLastModelUsedAt()).toBe(t0)
    store.flushSync()

    // Cold restart of a new UsageStats instance without records in memory
    const restarted = new UsageStats({
      file,
      lock: noopStatsLock,
      now: () => t0 + 10_000,
    })
    // Falls back to the persisted account snapshot
    expect(restarted.getLastModelUsedAt()).toBe(t0)
  })
})

describe('model visibility', () => {
  it('hides only explicitly disabled models (blacklist semantics)', () => {
    const { dir } = scratch()
    const visibility = new ModelVisibility({ file: join(dir, 'agy-models.json') })
    visibility.setDisabled('agy', 'model-a', true)
    const disabled = visibility.disabledFor('agy')
    expect(disabled.has('model-a')).toBe(true)
    // A model the server adds later is visible without any action.
    expect(disabled.has('model-new')).toBe(false)
  })

  it('deletes the key on re-enable so the file holds only hidden ids', () => {
    const { dir } = scratch()
    const file = join(dir, 'agy-models.json')
    const visibility = new ModelVisibility({ file })
    visibility.setDisabled('agy', 'model-a', true)
    visibility.setDisabled('agy', 'model-a', false)
    expect(JSON.parse(readFileSync(file, 'utf8')).disabled).toEqual({})
    expect([...visibility.disabledFor('agy')]).toEqual([])
  })

  it('reflects a toggle immediately without rebuilding the reader', () => {
    // The adapter reads `disabledFor` on every listModels(); a stale memo would
    // keep a disabled model in the picker until restart.
    const { dir } = scratch()
    const visibility = new ModelVisibility({ file: join(dir, 'agy-models.json') })
    expect([...visibility.disabledFor('agy')]).toEqual([])
    visibility.setDisabled('agy', 'model-a', true)
    expect([...visibility.disabledFor('agy')]).toEqual(['model-a'])
    visibility.setDisabled('agy', 'model-a', false)
    expect([...visibility.disabledFor('agy')]).toEqual([])
  })

  it('persists across instances and reloads another writer\'s change', () => {
    const { dir } = scratch()
    const file = join(dir, 'agy-models.json')
    const first = new ModelVisibility({ file })
    first.setDisabled('agy', 'model-a', true)

    const second = new ModelVisibility({ file })
    expect(second.isDisabled('agy', 'model-a')).toBe(true)
    second.setDisabled('agy', 'model-b', true)
    first.reload()
    expect(first.isDisabled('agy', 'model-b')).toBe(true)
  })

  it('converges two live instances without an explicit reload', () => {
    // The bug this pins: the main plugin entry and the web entry each build
    // their own runtime, so a toggle written by the web instance was invisible
    // to the adapter instance the model selector reads. The picker refreshed on
    // `llm/adapters-updated` and the model was still listed — the switch looked
    // broken until the host restarted.
    const { dir } = scratch()
    const file = join(dir, 'agy-models.json')
    const writer = new ModelVisibility({ file })
    const reader = new ModelVisibility({ file })
    expect(reader.isDisabled('agy', 'model-a')).toBe(false)

    writer.setDisabled('agy', 'model-a', true)
    expect(reader.isDisabled('agy', 'model-a')).toBe(true)
    expect(reader.disabledFor('agy').has('model-a')).toBe(true)

    writer.setDisabled('agy', 'model-a', false)
    expect(reader.isDisabled('agy', 'model-a')).toBe(false)
    expect(reader.disabledFor('agy').size).toBe(0)
  })

  it('sees a change written by another process', () => {
    // A CLI toggle must reach a running server, not just another object.
    const { dir } = scratch()
    const file = join(dir, 'agy-models.json')
    const reader = new ModelVisibility({ file })
    reader.setDisabled('agy', 'model-a', true)
    expect(reader.isDisabled('agy', 'model-a')).toBe(true)

    writeFileSync(file, JSON.stringify({ version: 1, disabled: { agy: { 'model-z': true } } }))
    expect(reader.isDisabled('agy', 'model-z')).toBe(true)
    expect(reader.isDisabled('agy', 'model-a')).toBe(false)
  })

  it('sees a change written within the same filesystem timestamp tick', () => {
    // Regression, caught by CI on Windows: detection was mtime-based, and two
    // writes landing in one timestamp tick reported an IDENTICAL mtime, so the
    // second change was invisible and a disabled model stayed selectable.
    // Windows resolves that tick far more coarsely than macOS. Detection is now
    // a content comparison, which cannot miss a change at any clock resolution.
    const { dir } = scratch()
    const file = join(dir, 'agy-models.json')
    const reader = new ModelVisibility({ file })
    reader.setDisabled('agy', 'model-a', true)

    // Two writes back to back, deliberately without awaiting the clock.
    writeFileSync(file, JSON.stringify({ version: 1, disabled: { agy: { 'model-b': true } } }))
    writeFileSync(file, JSON.stringify({ version: 1, disabled: { agy: { 'model-c': true } } }))

    expect(reader.isDisabled('agy', 'model-c')).toBe(true)
    expect(reader.isDisabled('agy', 'model-a')).toBe(false)
  })

  it('rewrites identical content without a needless reload', () => {
    // Content comparison must not reparse on every read when nothing changed:
    // the returned set stays the same memoized reference.
    const { dir } = scratch()
    const file = join(dir, 'agy-models.json')
    const reader = new ModelVisibility({ file })
    reader.setDisabled('agy', 'model-a', true)

    const first = reader.disabledFor('agy')
    const second = reader.disabledFor('agy')
    expect(second).toBe(first)
  })

  it('treats a deleted file as a change rather than serving a stale set', () => {
    const { dir } = scratch()
    const file = join(dir, 'agy-models.json')
    const visibility = new ModelVisibility({ file })
    visibility.setDisabled('agy', 'model-a', true)
    expect(visibility.isDisabled('agy', 'model-a')).toBe(true)

    rmSync(file)
    expect(visibility.isDisabled('agy', 'model-a')).toBe(false)
  })

  it('does not drop another writer\'s toggle when it writes its own', () => {
    // A read-modify-write against this instance's stale copy would erase
    // `model-b` here: the two instances share one file, and the second toggle
    // is made against a file state the first one has already changed.
    const { dir } = scratch()
    const file = join(dir, 'agy-models.json')
    const first = new ModelVisibility({ file })
    const second = new ModelVisibility({ file })
    first.setDisabled('agy', 'model-a', true)
    second.setDisabled('agy', 'model-b', true)

    const persisted = JSON.parse(readFileSync(file, 'utf8')).disabled.agy
    expect(Object.keys(persisted).sort()).toEqual(['model-a', 'model-b'])
  })

  it('ignores malformed input and never treats a false flag as disabled', () => {
    expect(sanitizeDisabledModels(null)).toEqual({})
    expect(sanitizeDisabledModels([])).toEqual({})
    expect(sanitizeDisabledModels({ agy: { a: false, b: true } })).toEqual({ agy: { b: true } })
    expect(sanitizeDisabledModels({ agy: 'nope' })).toEqual({})
    expect(parseModelVisibility('garbage').disabled).toEqual({})
  })

  it('refuses an empty model id', () => {
    const { dir } = scratch()
    const visibility = new ModelVisibility({ file: join(dir, 'agy-models.json') })
    expect(() => { visibility.setDisabled('agy', '', true) }).toThrow()
  })
})
