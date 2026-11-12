import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { BUNDLED_TOOLS } from '../lib/tools.js'

export function memoryCredentials(initial) {
  const records = new Map(initial ? [['consensus-mcp/oauth', structuredClone(initial)]] : [])
  const stats = { reads: 0, writes: 0 }
  return {
    stats,
    async readRecord(key) { stats.reads++; return structuredClone(records.get(key)) },
    async modifyRecord(key, fn) {
      const next = await fn(structuredClone(records.get(key)))
      if (next !== undefined) {
        // Same JSON-only contract as a persistent DSH credential provider.
        const serialized = JSON.stringify(next)
        records.set(key, JSON.parse(serialized))
        stats.writes++
      }
    },
    async deleteRecord(key) { records.delete(key); stats.writes++ },
    snapshot() { return structuredClone(records.get('consensus-mcp/oauth')) },
  }
}

export async function mockConsensus(t, options = {}) {
  const stats = { requests: 0, discoveries: 0, registrations: 0, logins: 0, exchanges: 0, refreshes: 0, probes: 0, initializes: 0, toolLists: 0, searches: [], calls: [], getMcp: 0 }
  let tools = structuredClone(options.tools ?? BUNDLED_TOOLS).filter(tool => !options.noSearch || tool.name !== 'search')
  const threads = new Map()
  const codes = new Map()
  let access
  let tokenNumber = 0
  let expired = false
  let failNextSearch = false
  let hangingSearch = false
  const searchReceived = Promise.withResolvers()
  const server = createServer(async (req, res) => {
    try {
      stats.requests++
      const url = new URL(req.url, base)
      const json = (status, body, headers = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
        res.end(JSON.stringify(body))
      }
      const readBody = async () => {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        return Buffer.concat(chunks).toString('utf8')
      }
      if (url.pathname === '/.well-known/oauth-protected-resource') {
        stats.discoveries++
        json(200, { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ['search'] })
      } else if (url.pathname === '/.well-known/oauth-authorization-server') {
        stats.discoveries++
        json(200, {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_methods_supported: ['none'],
          code_challenge_methods_supported: ['S256'],
          scopes_supported: ['search', 'offline_access'],
          authorization_response_iss_parameter_supported: true,
        })
      } else if (url.pathname === '/register') {
        stats.registrations++
        const metadata = JSON.parse(await readBody())
        stats.clientMetadata = metadata
        json(201, { ...metadata, client_id: 'test-client' })
      } else if (url.pathname === '/authorize') {
        stats.logins++
        const params = url.searchParams
        const code = randomBytes(16).toString('hex')
        codes.set(code, { challenge: params.get('code_challenge'), redirect: params.get('redirect_uri') })
        const redirect = new URL(params.get('redirect_uri'))
        redirect.searchParams.set('code', code)
        redirect.searchParams.set('state', options.badState ? 'wrong-state' : params.get('state'))
        if (!options.missingIssuer) redirect.searchParams.set('iss', options.badIssuer ? `${base}/evil` : base)
        res.writeHead(302, { Location: redirect.href })
        res.end()
      } else if (url.pathname === '/token') {
        const params = new URLSearchParams(await readBody())
        if (params.get('grant_type') === 'authorization_code') {
          stats.exchanges++
          const code = codes.get(params.get('code'))
          const challenge = createHash('sha256').update(params.get('code_verifier') ?? '').digest('base64url')
          if (!code || code.redirect !== params.get('redirect_uri') || code.challenge !== challenge) {
            json(400, { error: 'invalid_grant' })
            return
          }
          codes.delete(params.get('code'))
        } else if (params.get('grant_type') === 'refresh_token') {
          stats.refreshes++
          if (options.revokedRefresh) { json(400, { error: 'invalid_grant', error_description: 'Test grant revoked' }); return }
          if (!params.get('refresh_token')) { json(400, { error: 'invalid_grant' }); return }
        } else { json(400, { error: 'unsupported_grant_type' }); return }
        expired = false
        access = `test-access-${++tokenNumber}`
        json(200, { access_token: access, refresh_token: `test-refresh-${tokenNumber}`, token_type: 'Bearer', expires_in: 3600, scope: 'search' })
      } else if (url.pathname === '/mcp') {
        if (req.method === 'GET') { stats.getMcp++; res.writeHead(405); res.end(); return }
        if (!access || expired || req.headers.authorization !== `Bearer ${access}`) {
          json(401, { error: 'unauthorized' }, { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource", scope="search"` })
          return
        }
        const request = JSON.parse(await readBody())
        const result = value => json(200, { jsonrpc: '2.0', id: request.id, result: value })
        if (request.method === 'server/discover') {
          stats.probes++
          json(200, { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } })
        } else if (request.method === 'initialize') {
          stats.initializes++
          result({ protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'consensus-test', version: '1.0' }, instructions: options.instructions ?? 'Server context from mock Consensus.' })
        } else if (request.method === 'tools/list') {
          stats.toolLists++
          result({ tools })
        } else if (request.method === 'tools/call') {
          const { name, arguments: args } = request.params
          stats.calls.push({ name, args })
          if (options.failTool === name) { res.writeHead(503); res.end('fake-token-response-DO-NOT-LEAK'); return }
          if (name !== 'search') {
            let data
            if (name === 'create_thread') {
              const thread_id = `thread-${threads.size + 1}`
              data = { thread_id, interaction_id: `${thread_id}-1`, status: 'running', poll_after_seconds: 5 }
              threads.set(thread_id, { ...data, polls: 0, title: args.input_message, interactions: 1 })
            } else if (name === 'get_thread') {
              const thread = threads.get(args.thread_id)
              if (!thread) { result({ isError: true, content: [{ type: 'text', text: 'Thread not found' }] }); return }
              thread.polls++
              thread.status = thread.polls >= 2 ? 'idle' : 'running'
              data = { thread_id: args.thread_id, interaction_id: thread.interaction_id, status: thread.status, poll_after_seconds: 5 }
              if (thread.status === 'idle') data.document = '# Research report\n\nExact evidence [1.1](https://example.org/paper#quote).\n'
            } else if (name === 'add_to_thread') {
              const thread = threads.get(args.thread_id)
              if (!thread || thread.status !== 'idle') { result({ isError: true, content: [{ type: 'text', text: 'Thread is not idle' }] }); return }
              thread.interactions++
              thread.interaction_id = `${args.thread_id}-${thread.interactions}`
              thread.status = 'running'
              thread.polls = 0
              data = { thread_id: args.thread_id, interaction_id: thread.interaction_id, status: 'running', poll_after_seconds: 5 }
            } else if (name === 'find_threads') {
              data = { threads: [...threads.values()].filter(thread => !args.query || thread.title.includes(args.query)).slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 20)).map(({ title, thread_id }) => ({ title, thread_id })) }
            } else data = { name, args }
            const value = { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data }
            if (options.sse) {
              res.writeHead(200, { 'Content-Type': 'text/event-stream' })
              res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: value })}\n\n`)
            } else result(value)
            return
          }
          stats.searches.push(args)
          searchReceived.resolve()
          if (hangingSearch) return
          if (failNextSearch) { failNextSearch = false; res.writeHead(503); res.end('fake-token-response-DO-NOT-LEAK'); return }
          const value = { content: [{ type: 'text', text: options.text ?? '[1] [Mock paper](https://example.org/paper)\n\nUsage message: preserve this EXACTLY.' }], ...(options.toolError ? { isError: true } : {}) }
          if (options.sse) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' })
            res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: value })}\n\n`)
          } else result(value)
        } else { res.writeHead(202); res.end() }
      } else { json(404, { error: 'not_found' }) }
    } catch (error) {
      if (!res.headersSent) res.writeHead(500)
      res.end('mock failure')
      options.onError?.(error)
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  return {
    endpoint: `${base}/mcp`, stats, searchReceived: searchReceived.promise,
    openBrowser: async url => { const response = await fetch(url); await response.text() },
    expire() { expired = true },
    failNextSearch() { failNextSearch = true },
    hangSearch() { hangingSearch = true },
    setTools(next) { tools = structuredClone(next) },
  }
}
