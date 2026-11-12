import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'

export const CREDENTIAL_KEY = 'consensus-mcp/oauth'
export const ENDPOINT = 'https://mcp.consensus.app/mcp'

export class ConsensusError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConsensusError'
  }
}

export function waitWithSignal(promise, signal) {
  signal?.throwIfAborted()
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    const aborted = () => { cleanup(); reject(signal.reason) }
    const cleanup = () => signal.removeEventListener('abort', aborted)
    signal.addEventListener('abort', aborted, { once: true })
    promise.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
  })
}

function equalState(a, b) {
  if (!a || !b) return false
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

// Uses DSH's credential provider; never reads or imports mcp-remote's token cache.
export class ConsensusOAuth {
  constructor(credentials, { endpoint = ENDPOINT, openBrowser, notify = () => {}, authTimeoutMs = 120_000 } = {}) {
    this.credentials = credentials
    this.endpoint = endpoint
    this.openBrowser = openBrowser ?? (async url => {
      const { default: open } = await import('open')
      await open(url)
    })
    this.notify = notify
    this.authTimeoutMs = authTimeoutMs
  }

  async read() {
    const record = await this.credentials.readRecord(CREDENTIAL_KEY)
    if (!record) return {}
    const data = record.payload
    if (record.kind !== 'grant' || data?.version !== 1 || data.endpoint !== this.endpoint) {
      throw new ConsensusError('Consensus OAuth record is incompatible. Remove the consensus-mcp/oauth grant in DSH and authorize again.')
    }
    return data
  }

  async patch(changes) {
    await this.credentials.modifyRecord(CREDENTIAL_KEY, record => {
      if (record && (record.kind !== 'grant' || record.payload?.version !== 1 || record.payload.endpoint !== this.endpoint)) {
        throw new ConsensusError('Refusing to overwrite an incompatible Consensus OAuth record.')
      }
      const payload = { ...record?.payload, version: 1, endpoint: this.endpoint, ...changes }
      for (const key of Object.keys(payload)) if (payload[key] === undefined) delete payload[key]
      return { kind: 'grant', payload: JSON.parse(JSON.stringify(payload)) }
    })
  }

  async prepare(signal) {
    this.signal = signal
    signal.throwIfAborted()
    const data = await this.read()
    if (data.redirectUrl) {
      const url = new URL(data.redirectUrl)
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/oauth/callback' || url.username || url.password || url.search || url.hash) {
        throw new ConsensusError('Invalid Consensus OAuth loopback redirect URL.')
      }
      this.redirect = url.href
    } else {
      // Reserve an ephemeral port once; keep the same redirect URI with the client registration.
      await this.listen(0)
      signal.throwIfAborted()
      this.redirect = `http://127.0.0.1:${this.server.address().port}/oauth/callback`
      await this.patch({ redirectUrl: this.redirect })
    }
  }

  get redirectUrl() { return this.redirect }

  get clientMetadata() {
    return {
      client_name: 'DSH Consensus',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'search',
    }
  }

  async clientInformation() { return (await this.read()).clientInformation }
  async saveClientInformation(value) { await this.patch({ clientInformation: value }) }
  async tokens() { return (await this.read()).tokens }
  async saveTokens(value) {
    const now = Date.now()
    const existing = await this.read()
    await this.patch({
      tokens: value,
      authorizedAt: existing.authorizedAt ?? now,
      updatedAt: now,
      expiresAt: Number.isFinite(value.expires_in) ? now + value.expires_in * 1000 : undefined,
    })
  }
  async discoveryState() { return (await this.read()).discoveryState }
  async saveDiscoveryState(value) { await this.patch({ discoveryState: value }) }
  saveCodeVerifier(value) { this.verifier = value }
  codeVerifier() {
    if (!this.verifier) throw new ConsensusError('Consensus authorization expired; run the search again.')
    return this.verifier
  }

  async invalidateCredentials(scope) {
    if (scope === 'all' || scope === 'verifier') this.verifier = undefined
    if (scope === 'all') await this.patch({ clientInformation: undefined, tokens: undefined, discoveryState: undefined })
    else if (scope === 'client') await this.patch({ clientInformation: undefined })
    else if (scope === 'tokens') await this.patch({ tokens: undefined })
    else if (scope === 'discovery') await this.patch({ discoveryState: undefined })
  }

  async state() {
    this.signal.throwIfAborted()
    if (!this.server) await this.listen(Number(new URL(this.redirectUrl).port))
    this.expectedState = randomBytes(32).toString('base64url')
    // Register rejection handling before any browser navigation or cancellation.
    this.pending = Promise.withResolvers()
    this.pending.promise.catch(() => {})
    return this.expectedState
  }

  async redirectToAuthorization(url) {
    this.signal.throwIfAborted()
    if (!this.pending) throw new ConsensusError('Consensus authorization was not initialized.')
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1')) {
      throw new ConsensusError('Refusing to open an insecure Consensus authorization URL.')
    }
    this.authTimer = setTimeout(() => {
      this.pending?.reject(new ConsensusError('Consensus browser sign-in timed out. Run the search again to retry.'))
    }, this.authTimeoutMs)
    this.notify('Consensus: complete sign-in in the browser; this search will continue automatically.')
    try {
      await waitWithSignal(Promise.resolve().then(() => this.openBrowser(url.href)), this.signal)
    } catch {
      const error = new ConsensusError('Could not open the Consensus sign-in browser. Check the default browser and retry.')
      this.pending?.reject(error)
      throw error
    }
  }

  hasPendingAuthorization() { return this.pending !== undefined }

  async finishAuthorization(transport) {
    if (!this.pending) throw new ConsensusError('Consensus needs authorization. Run the search again.')
    try {
      const params = await waitWithSignal(this.pending.promise, this.signal)
      this.signal.throwIfAborted()
      // SDK validates issuer binding and PKCE. The loopback handler already checked state.
      await transport.finishAuth(params)
    } finally {
      await this.end()
    }
  }

  async listen(port) {
    this.signal?.throwIfAborted()
    const server = createServer((req, res) => this.callback(req, res))
    this.server = server
    server.requestTimeout = 10_000
    server.headersTimeout = 10_000
    server.maxHeadersCount = 32
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
      })
    } catch {
      this.server = undefined
      throw new ConsensusError('Cannot listen on the Consensus OAuth callback port. Close another sign-in/DSH instance and retry.')
    }
    if (this.signal?.aborted) {
      await this.end()
      this.signal.throwIfAborted()
    }
  }

  callback(req, res) {
    const respond = (status, text) => {
      res.writeHead(status, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
        'X-Content-Type-Options': 'nosniff',
        Connection: 'close',
      })
      res.end(text)
    }
    if (req.method !== 'GET' || !this.redirect || req.headers.host !== new URL(this.redirect).host || req.headers.origin) {
      respond(403, 'Forbidden')
      return
    }
    let url
    try { url = new URL(req.url, this.redirect) } catch { respond(400, 'Invalid callback'); return }
    if (url.origin !== new URL(this.redirect).origin || url.pathname !== '/oauth/callback') { respond(404, 'Not found'); return }
    const params = url.searchParams
    if (!this.pending || params.getAll('state').length !== 1 || !equalState(params.get('state'), this.expectedState)) {
      respond(403, 'Invalid OAuth state')
      return
    }
    if (['code', 'iss', 'error'].some(key => params.getAll(key).length > 1) || (!params.has('code') && !params.has('error'))) {
      respond(400, 'Invalid callback')
      return
    }
    if (params.has('error')) {
      this.expectedState = undefined
      this.pending.reject(new ConsensusError('Consensus sign-in was denied or failed. Run the search again to retry.'))
      respond(403, 'Sign-in was not completed. Return to DSH and retry.')
      return
    }
    this.expectedState = undefined // One-shot callback; never accept a replay.
    this.pending.resolve(new URLSearchParams(params))
    respond(200, 'Authorization response received. Return to DSH to finish the search. You can close this tab.')
  }

  async end() {
    clearTimeout(this.authTimer)
    this.authTimer = undefined
    this.pending?.reject(new ConsensusError('Consensus authorization was canceled.'))
    this.pending = undefined
    this.verifier = undefined
    this.expectedState = undefined
    const server = this.server
    this.server = undefined
    if (server?.listening) {
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
    }
  }
}
