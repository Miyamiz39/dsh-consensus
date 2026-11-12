import { CREDENTIAL_KEY, ConsensusError, ConsensusOAuth, ENDPOINT, waitWithSignal } from './oauth.js'

const REQUEST_TIMEOUT_MS = 60_000
const NETWORK_TIMEOUT_MS = 30_000
const OPERATION_TIMEOUT_MS = 180_000
const MAX_INSTRUCTION_BYTES = 32_768

// No SDK import, token access, socket, child process, or network before request().
export function createRuntime(credentials, options = {}) {
  const endpoint = options.endpoint ?? ENDPOINT
  const lifetime = new AbortController()
  let session = new AbortController()
  let phase = 'idle'
  let loggingOut
  const provider = new ConsensusOAuth(credentials, {
    ...options, endpoint,
    notify(text) { phase = 'authorizing'; options.notify?.(text) },
  })
  let sdk
  let current
  let activeSignal
  let tail = Promise.resolve()
  let instructions = ''
  let stopping
  const loadSdk = options.loadSdk ?? (() => import('@modelcontextprotocol/client'))
  const rawFetch = options.fetch ?? ((...args) => globalThis.fetch(...args))

  const fetch = (url, init = {}) => {
    // Search is request/response-only. Decline the SDK's optional standalone SSE
    // notification channel locally, so it cannot refresh tokens/open a browser in the background.
    if ((init.method ?? 'GET') === 'GET' && new URL(url).href === endpoint && new Headers(init.headers).get('accept')?.includes('text/event-stream')) {
      return Promise.resolve(new Response(null, { status: 405 }))
    }
    const signals = [lifetime.signal, activeSignal, init.signal, AbortSignal.timeout(options.networkTimeoutMs ?? NETWORK_TIMEOUT_MS)].filter(Boolean)
    return rawFetch(url, { ...init, signal: AbortSignal.any(signals) })
  }

  async function close(connection) {
    if (!connection) return
    if (current === connection) current = undefined
    // close() only releases local transport state. No terminateSession / extra HTTP request.
    await connection.client.close().catch(() => {})
    await connection.transport.close().catch(() => {})
  }

  async function authorized(action, transport) {
    try {
      return await action()
    } catch (error) {
      if (!provider.hasPendingAuthorization()) throw error
      await provider.finishAuthorization(transport)
      // Only replays after a known authorization redirect, never arbitrary network failures.
      return await action()
    }
  }

  async function syncTools(connection, signal) {
    const listed = await authorized(() => connection.client.listTools(undefined, {
      signal,
      timeout: REQUEST_TIMEOUT_MS,
      cacheMode: 'refresh',
    }), connection.transport)
    const tools = new Map()
    for (const tool of listed.tools) {
      if (tools.has(tool.name)) throw new ConsensusError(`Consensus advertised duplicate tool: ${tool.name}`)
      tools.set(tool.name, tool)
    }
    options.onTools?.(listed.tools)
    connection.tools = tools
    connection.catalogDirty = false
  }

  async function connect(signal) {
    if (current) {
      if (current.catalogDirty) await syncTools(current, signal)
      return current
    }
    sdk ??= await loadSdk()
    signal.throwIfAborted()
    for (let attempt = 0; attempt < 2; attempt++) {
      const transport = new sdk.StreamableHTTPClientTransport(new URL(endpoint), {
        authProvider: provider,
        fetch,
        reconnectionOptions: { maxRetries: 0 },
      })
      const client = new sdk.Client({ name: 'dsh-consensus', version: '2.2.0' }, {
        capabilities: {},
        versionNegotiation: { mode: 'auto' },
        listChanged: { tools: {
          autoRefresh: false,
          debounceMs: 0,
          onChanged: () => { if (current?.client === client) current.catalogDirty = true },
        } },
      })
      const connection = { client, transport }
      client.onclose = () => { if (current === connection) current = undefined }
      // Do not print SDK errors: OAuth failures may contain server-controlled token responses.
      client.onerror = () => {}
      try {
        try {
          await client.connect(transport, { signal, timeout: REQUEST_TIMEOUT_MS })
        } catch (error) {
          if (attempt !== 0 || !provider.hasPendingAuthorization()) throw error
          await provider.finishAuthorization(transport)
          await close(connection)
          // A Client is bound to one transport; authorization reconnect uses fresh instances.
          continue
        }
        await syncTools(connection, signal)
        const text = client.getInstructions()?.trim() ?? ''
        if (Buffer.byteLength(text, 'utf8') > MAX_INSTRUCTION_BYTES) throw new ConsensusError('Consensus server instructions exceed the safety limit.')
        instructions = text
        signal.throwIfAborted()
        current = connection
        return connection
      } catch (error) {
        await close(connection)
        throw error
      }
    }
    throw new ConsensusError('Consensus sign-in did not establish a connection. Retry the search.')
  }

  async function perform(toolName, args, signal) {
    activeSignal = signal
    phase = 'connecting'
    try {
      await provider.prepare(signal)
      const connection = await connect(signal)
      signal.throwIfAborted()
      if (toolName === undefined) return { connected: true }
      const definition = connection.tools.get(toolName)
      if (!definition) throw new ConsensusError(`Consensus does not advertise tool: ${toolName}`)
      if (definition.execution?.taskSupport === 'required') throw new ConsensusError(`Consensus tool ${toolName} requires an unsupported task protocol.`)
      phase = 'calling'
      const result = await authorized(() => connection.client.callTool({ name: toolName, arguments: args }, {
        signal,
        timeout: REQUEST_TIMEOUT_MS,
        toolDefinition: definition,
      }), connection.transport)
      if (result.isError) throw new ConsensusError(`Consensus ${toolName} failed: ${textContent(result)}`)
      return {
        content: result.content,
        ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
      }
    } catch (error) {
      await close(current)
      if (signal.aborted) throw new ConsensusError(signal.reason?.name === 'TimeoutError'
        ? 'Consensus search timed out. Check the network/sign-in and retry.'
        : 'Consensus search was canceled.')
      if (error instanceof ConsensusError) throw error
      // Never include raw SDK errors, token responses, callback parameters or authorization URLs.
      throw new ConsensusError('Consensus connection/search failed. Check the network and browser sign-in, then retry.')
    } finally {
      await provider.end()
      activeSignal = undefined
      phase = 'idle'
    }
  }

  function enqueue(toolName, args, exec = {}) {
    if (lifetime.signal.aborted) return Promise.reject(new ConsensusError('Consensus plugin has been unloaded.'))
    if (loggingOut) return Promise.reject(new ConsensusError('Consensus is signing out. Please retry shortly.'))
    const signals = [lifetime.signal, session.signal, exec.signal, AbortSignal.timeout(options.operationTimeoutMs ?? OPERATION_TIMEOUT_MS)].filter(Boolean)
    const signal = AbortSignal.any(signals)
    // Search and manual login share the same queue and authorization lifecycle.
    const result = tail.then(() => { signal.throwIfAborted(); return perform(toolName, args, signal) })
    tail = result.catch(() => {})
    try { return waitWithSignal(result, signal) } catch (error) { return Promise.reject(error) }
  }

  return {
    get instructions() { return instructions },
    callTool(toolName, args = {}, exec) { return enqueue(toolName, args, exec) },
    search(args, exec) { return enqueue('search', args, exec) },
    login(exec) { return enqueue(undefined, undefined, exec) },
    async status() {
      const data = await provider.read()
      const tokens = data.tokens
      // Strict allowlist: never return tokens, client secrets, redirect URL or raw OAuth responses.
      return {
        authorized: Boolean(tokens?.access_token),
        connected: Boolean(current),
        phase: loggingOut ? 'signing-out' : phase,
        scopes: typeof tokens?.scope === 'string' ? tokens.scope.split(/\s+/).filter(Boolean) : [],
        refreshable: Boolean(tokens?.refresh_token),
        authorizedAt: Number.isFinite(data.authorizedAt) ? data.authorizedAt : null,
        updatedAt: Number.isFinite(data.updatedAt) ? data.updatedAt : null,
        expiresAt: Number.isFinite(data.expiresAt) ? data.expiresAt : null,
        expired: Number.isFinite(data.expiresAt) ? Date.now() >= data.expiresAt : null,
      }
    },
    logout() {
      if (loggingOut) return loggingOut
      session.abort(new DOMException('Signed out', 'AbortError'))
      const work = (async () => {
        await tail
        await close(current)
        await provider.end()
        await credentials.deleteRecord(CREDENTIAL_KEY)
        instructions = ''
      })()
      loggingOut = work.finally(() => {
        session = new AbortController()
        loggingOut = undefined
        phase = 'idle'
      })
      return loggingOut
    },
    dispose() {
      return stopping ??= (async () => {
        lifetime.abort(new DOMException('Plugin unloaded', 'AbortError'))
        await provider.end()
        await close(current)
        await tail
        await loggingOut
      })()
    },
  }
}

export function textContent(result) {
  const parts = []
  for (const block of result.content ?? []) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'resource_link') parts.push(`${block.name ?? 'Resource'}: ${block.uri}`)
    else parts.push(`[Unsupported Consensus content: ${block.type}]`)
  }
  if (!parts.length && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent))
  return parts.join('\n\n')
}
