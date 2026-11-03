import { describe, it, expect, vi, afterEach } from 'vitest'
import { EnvHttpProxyAgent, ProxyAgent, request } from 'undici'
import { createServer, type AddressInfo, type Socket } from 'node:net'
import { proxiedFetch, proxyAgent, proxyStreamingAgent, dispatcherForAsync, dispatcherOptsFor, normalizeProxyUrl, proxyUrlForLogs, _clearDispatcherCacheForTest, DISPATCHER_CACHE_CAP } from '../src/proxy.ts'

describe('proxy env support', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('builds an EnvHttpProxyAgent that reads HTTP_PROXY/HTTPS_PROXY/NO_PROXY', () => {
    expect(proxyAgent).toBeInstanceOf(EnvHttpProxyAgent)
  })

  it('forwards the proxy dispatcher to the underlying fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)

    await proxiedFetch('https://example.com', { method: 'POST' })

    expect(fetchMock).toHaveBeenCalledWith('https://example.com', {
      method: 'POST',
      dispatcher: proxyAgent,
    })
  })

  it('keeps the caller signal and other init options intact', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()

    await proxiedFetch('https://example.com', { signal: controller.signal })

    expect(fetchMock).toHaveBeenCalledWith('https://example.com', {
      signal: controller.signal,
      dispatcher: proxyAgent,
    })
  })
})

describe('streaming dispatcher (issue #29 5)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    _clearDispatcherCacheForTest()
  })

  // A generation stream can legitimately stay silent for minutes mid-turn
  // (reasoning). undici's bodyTimeout is a per-gap inactivity timer, not a total
  // transfer budget — measured against a real tunnel: a 150ms drip for 1.5s
  // survives bodyTimeout:400, while one 1.5s stall trips it, and bodyTimeout:0
  // survives a 35s stall. So the control-plane 30s value would kill a slow turn
  // the moment proxy routing works, which is why streaming disables it.
  it('disables the per-gap body inactivity timer for streams only', () => {
    expect(dispatcherOptsFor(true).bodyTimeout).toBe(0)
    expect(dispatcherOptsFor(false).bodyTimeout).toBe(30_000)
    // Every other bound is unchanged: streaming relaxes silence tolerance only.
    expect(dispatcherOptsFor(true).headersTimeout).toBe(dispatcherOptsFor(false).headersTimeout)
    expect(dispatcherOptsFor(true).connectTimeout).toBe(dispatcherOptsFor(false).connectTimeout)
  })

  it('resolves distinct dispatchers per call class and caches each', async () => {
    const proxyUrl = 'http://user:sup3rs3cret@127.0.0.1:9'
    const streaming = await dispatcherForAsync(proxyUrl, { streaming: true })
    const control = await dispatcherForAsync(proxyUrl, { streaming: false })

    expect(streaming).not.toBe(control)
    // Cached per class: a stream must not reuse the control dispatcher.
    expect(await dispatcherForAsync(proxyUrl, { streaming: true })).toBe(streaming)
    expect(await dispatcherForAsync(proxyUrl, { streaming: false })).toBe(control)
  })

  it('routes a proxyless stream through the streaming env agent', async () => {
    expect(await dispatcherForAsync(undefined, { streaming: true })).toBe(proxyStreamingAgent)
    expect(proxyStreamingAgent).not.toBe(proxyAgent)
    expect(proxyStreamingAgent).toBeInstanceOf(EnvHttpProxyAgent)
  })

  it('evicts oldest entries when cache cap is exceeded and calls destroy()', async () => {
    const dispatchers: any[] = []
    for (let i = 0; i < DISPATCHER_CACHE_CAP; i++) {
      const d = await dispatcherForAsync(`http://127.0.0.1:${1000 + i}`)
      vi.spyOn(d, 'destroy')
      dispatchers.push(d)
    }

    // Cache is now full at DISPATCHER_CACHE_CAP (16)
    // Accessing index 0 refreshes its LRU order
    await dispatcherForAsync(`http://127.0.0.1:1000`)

    // Adding 17th entry should evict index 1 (the oldest un-refreshed entry)
    const newDispatcher = await dispatcherForAsync(`http://127.0.0.1:9999`)
    expect(newDispatcher).toBeDefined()

    // index 0 was refreshed, so its destroy was NOT called
    expect(dispatchers[0].destroy).not.toHaveBeenCalled()
    // index 1 was the oldest, so its destroy WAS called
    expect(dispatchers[1].destroy).toHaveBeenCalled()

    // _clearDispatcherCacheForTest destroys all remaining cached entries
    _clearDispatcherCacheForTest()
    expect(dispatchers[0].destroy).toHaveBeenCalled()
  })
})
describe('proxy credential encoding (special characters)', () => {
  it('encodes a password containing @ so the proxy receives it intact', () => {
    // Spec #8 user story 22. `URL.password` returns the encoded substring, so
    // re-encoding it produced `p%2540ss`, which the proxy decodes to the literal
    // `p%40ss` and rejects (authentication failure).
    expect(normalizeProxyUrl('http://user:p@ss@127.0.0.1:9')).toBe('http://user:p%40ss@127.0.0.1:9')
    expect(normalizeProxyUrl('http://user:pa:ss@127.0.0.1:9')).toBe('http://user:pa%3Ass@127.0.0.1:9')
    expect(normalizeProxyUrl('socks5://u:p@ss@127.0.0.1:1080')).toBe('socks5://u:p%40ss@127.0.0.1:1080')
  })

  it('is idempotent, because a stored proxy URL is normalized again per request', () => {
    for (const raw of [
      'http://user:p@ss@127.0.0.1:9',
      'http://user:p%40ss@127.0.0.1:9',
      'http://user:pa:ss@h:9',
      'http://user:plain@h:9',
      'socks5://u:p@ss@h:1080',
      'http://h:8080',
    ]) {
      const once = normalizeProxyUrl(raw)
      expect(normalizeProxyUrl(once), `not idempotent for ${raw}`).toBe(once)
    }
  })

  it('leaves an already-correctly-encoded password untouched', () => {
    expect(normalizeProxyUrl('http://u:p%2Fw@h:1')).toBe('http://u:p%2Fw@h:1')
    expect(normalizeProxyUrl('http://user:plain@127.0.0.1:9')).toBe('http://user:plain@127.0.0.1:9')
  })
})

describe('proxy URL in log messages', () => {
  it('never echoes credentials for a URL that does not parse', () => {
    // `normalizeProxyUrl` embeds this string in its error message, which reaches
    // the GUI and stderr. The fallback used to return the raw input, so the one
    // shape that is guaranteed to still hold a password was the one shape that
    // printed it.
    for (const raw of ['not a url user:pass@host', 'http://user:pass@', 'user:pa@ss@127.0.0.1:9']) {
      const logged = proxyUrlForLogs(raw)
      expect(logged, `leaked for ${raw}`).not.toContain('pass')
      expect(logged).not.toContain('user:')
    }
  })

  it('reports host and port without the userinfo for a valid URL', () => {
    expect(proxyUrlForLogs('http://user:pass@127.0.0.1:9')).toBe('http://127.0.0.1:9')
    expect(proxyUrlForLogs('socks5://u:p@h')).toBe('socks5://h:1080')
    expect(proxyUrlForLogs('http://h:8080')).toBe('http://h:8080')
  })
})

// ── In-process SOCKS5 server (localhost only, no network, no global fetch) ──
// Speaks greeting + optional user/pass auth + CONNECT, then answers the tunneled
// request with a fixed HTTP response. Byte-accumulating state machine, so it is
// robust to TCP segment splits.
interface FakeSocks {
  port: number
  /** Credentials received at the RFC 1929 auth subnegotiation, `user:pass`. */
  receivedAuth: string[]
  close: () => Promise<void>
}

async function startFakeSocks(opts: { requireAuth?: boolean } = {}): Promise<FakeSocks> {
  const receivedAuth: string[] = []
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    let stage: 'greet' | 'auth' | 'connect' | 'relay' = 'greet'
    let relayed = false
    let buf = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        if (stage === 'greet') {
          if (buf.length < 2) return
          const nmethods = buf[1]!
          if (buf.length < 2 + nmethods) return
          buf = buf.subarray(2 + nmethods)
          socket.write(Buffer.from([0x05, opts.requireAuth ? 0x02 : 0x00]))
          stage = opts.requireAuth ? 'auth' : 'connect'
        } else if (stage === 'auth') {
          // VER ULEN UNAME PLEN PASSWD (RFC 1929)
          if (buf.length < 2) return
          const ulen = buf[1]!
          if (buf.length < 2 + ulen + 1) return
          const plen = buf[2 + ulen]!
          if (buf.length < 3 + ulen + plen) return
          receivedAuth.push(
            `${buf.subarray(2, 2 + ulen).toString()}:${buf.subarray(3 + ulen, 3 + ulen + plen).toString()}`,
          )
          buf = buf.subarray(3 + ulen + plen)
          socket.write(Buffer.from([0x01, 0x00]))
          stage = 'connect'
        } else if (stage === 'connect') {
          // VER CMD RSV ATYP DST.ADDR DST.PORT
          if (buf.length < 5) return
          const atyp = buf[3]!
          const addrLen = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : 1 + buf[4]!
          if (buf.length < 4 + addrLen + 2) return
          buf = buf.subarray(4 + addrLen + 2)
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
          stage = 'relay'
        } else {
          if (!relayed && buf.length > 0) {
            relayed = true
            socket.write('HTTP/1.1 200 OK\r\ncontent-length: 2\r\ncontent-type: text/plain\r\n\r\nok')
          }
          return
        }
      }
    })
    socket.on('error', () => {})
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as AddressInfo).port,
    receivedAuth,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy()
        server.close(() => resolve())
      }),
  }
}

describe('socks5 rides undici native ProxyAgent (issue #79)', () => {
  afterEach(() => {
    _clearDispatcherCacheForTest()
  })

  it('builds a real undici ProxyAgent and caches it per call class', async () => {
    const control = await dispatcherForAsync('socks5://127.0.0.1:1080')
    const streaming = await dispatcherForAsync('socks5://127.0.0.1:1080', { streaming: true })
    // The previous socks path handed fetch a Node `http.Agent` (socks-proxy-agent),
    // which has no undici `dispatch` — every request died with
    // `TypeError: agent.dispatch is not a function` before any connection.
    expect(control).toBeInstanceOf(ProxyAgent)
    expect(streaming).toBeInstanceOf(ProxyAgent)
    expect(control).not.toBe(streaming)
    expect(await dispatcherForAsync('socks5://127.0.0.1:1080')).toBe(control)
  })

  it('round-trips a request through a local SOCKS5 server', async () => {
    const socks = await startFakeSocks()
    try {
      const dispatcher = await dispatcherForAsync(`socks5://127.0.0.1:${socks.port}`)
      const res = await request('http://example.invalid/ping', { dispatcher })
      const body = await res.body.text()
      expect(res.statusCode).toBe(200)
      expect(body).toBe('ok')
    } finally {
      await socks.close()
    }
  })

  it('hands the SOCKS5 auth subnegotiation DECODED credentials', async () => {
    // A stored URL keeps the encoded form (normalizeProxyUrl pins `p%40ss`), and
    // undici forwards the username/password OPTIONS verbatim — only decoding
    // them here stops the proxy from receiving the literal `p%40ss` and
    // rejecting the auth.
    const socks = await startFakeSocks({ requireAuth: true })
    try {
      const dispatcher = await dispatcherForAsync(`socks5://u:p%40ss@127.0.0.1:${socks.port}`)
      const res = await request('http://example.invalid/ping', { dispatcher })
      await res.body.text()
      expect(res.statusCode).toBe(200)
      expect(socks.receivedAuth).toEqual(['u:p@ss'])
    } finally {
      await socks.close()
    }
  })
})
