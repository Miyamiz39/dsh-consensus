import test from 'node:test'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { request as httpRequest } from 'node:http'
import { apply, normalizeArguments, TOOL_NAME } from '../index.js'
import { BUNDLED_TOOLS, publicToolName, toolParameters } from '../lib/tools.js'
import { createRuntime, textContent } from '../lib/runtime.js'
import { ConsensusOAuth, CREDENTIAL_KEY } from '../lib/oauth.js'
import { memoryCredentials, mockConsensus } from './fixtures.js'

function runtimeFor(t, server, credentials = memoryCredentials(), overrides = {}) {
  const runtime = createRuntime(credentials, { endpoint: server.endpoint, openBrowser: server.openBrowser, operationTimeoutMs: 5000, networkTimeoutMs: 2000, ...overrides })
  t.after(() => runtime.dispose())
  return runtime
}

test('DSH activation registers every published tool with no credential access, fetch, or async connection', async t => {
  const credentials = memoryCredentials()
  const registered = []
  const effects = []
  const sections = []
  const originalFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = () => { requests++; throw new Error('No network allowed at startup') }
  t.after(() => { globalThis.fetch = originalFetch })
  const ctx = {
    credentials,
    tools: { register(tool) { registered.push(tool) } },
    logger: { info() {} },
    inject(services, fn) {
      if (services.includes('connection')) fn({ connection: { fetch: { register(route) { assert.equal(route.path, '/api/consensus/account') } } } })
      else fn({ systemPrompt: { section(s) { sections.push(s) }, getSectionOrder() { return 0 } } })
    },
    effect(fn) { effects.push(fn()) },
  }
  const start = performance.now()
  await apply(ctx)
  const duration = performance.now() - start
  assert.equal(registered[0].name, TOOL_NAME)
  assert.deepEqual(registered.map(tool => tool.name), ['search', 'create_thread', 'add_to_thread', 'get_thread', 'find_threads'].map(publicToolName))
  for (const tool of BUNDLED_TOOLS) {
    const registeredTool = registered.find(item => item.name === publicToolName(tool.name))
    assert.deepEqual(registeredTool.parameters, toolParameters(tool))
    assert.equal(registeredTool.description, tool.description)
  }
  assert.deepEqual(credentials.stats, { reads: 0, writes: 0 })
  assert.equal(requests, 0)
  assert.equal(sections[0].interpolate, false)
  assert.match(sections[0].text(), /exact returned URLs/)
  for (const dispose of effects) await dispose()
  assert.equal(requests, 0)
  t.diagnostic(`activation: ${duration.toFixed(2)} ms, zero network/credential accesses (unit harness, not full DSH boot)`)
})

test('runtime creation and disposal do not even import the MCP SDK', async () => {
  let imports = 0
  const credentials = memoryCredentials()
  const runtime = createRuntime(credentials, { loadSdk() { imports++; throw new Error('unexpected SDK import') } })
  await runtime.dispose()
  assert.equal(imports, 0)
  assert.equal(credentials.stats.reads, 0)
})

test('argument adapter preserves defaults, explicit filters and legacy top-level calls', () => {
  assert.deepEqual(normalizeArguments({ query: 'question' }), { query: 'question' })
  assert.deepEqual(normalizeArguments({ query: 'question', page_size: 20, filters: { year_min: 2020, human: true } }), { query: 'question', page_size: 20, year_min: 2020, human: true })
  assert.deepEqual(normalizeArguments({ query: 'question', year_min: 2020 }), { query: 'question', year_min: 2020 })
  for (const args of [{ query: '' }, { query: 'q', page_size: 0 }, { query: 'q', filters: [] }, { query: 'q', filters: { query: 'override' } }]) {
    assert.throws(() => normalizeArguments(args))
  }
})

test('native HTTP OAuth PKCE login, discovery, tools/list and search; then reuses connection', async t => {
  const server = await mockConsensus(t)
  const credentials = memoryCredentials()
  const runtime = runtimeFor(t, server, credentials)
  const result = await runtime.search({ query: 'Does exercise help?', year_min: 2020 })
  assert.match(textContent(result), /preserve this EXACTLY\./)
  assert.deepEqual(server.stats.searches[0], { query: 'Does exercise help?', year_min: 2020 })
  assert.equal(server.stats.registrations, 1)
  assert.equal(server.stats.logins, 1)
  assert.equal(server.stats.exchanges, 1)
  assert.equal(server.stats.initializes, 1)
  assert.equal(server.stats.getMcp, 0, 'optional background SSE must not contact the server')
  assert.match(runtime.instructions, /mock Consensus/)
  const record = credentials.snapshot()
  assert.equal(record.kind, 'grant')
  assert.equal(record.payload.tokens.refresh_token, 'test-refresh-1')
  assert.equal(record.payload.tokens.issuer, new URL(server.endpoint).origin)
  assert.equal(record.payload.codeVerifier, undefined)
  const callback = record.payload.redirectUrl
  await assert.rejects(fetch(callback), 'callback listener must close after authentication')
  await runtime.search({ query: 'Second question' })
  assert.equal(server.stats.initializes, 1)
  assert.equal(server.stats.toolLists, 1)
  assert.equal(server.stats.logins, 1)
  assert.equal(server.stats.searches.length, 2)
})

test('stored grant survives a new runtime; expired access token refreshes without a browser', async t => {
  const server = await mockConsensus(t)
  const credentials = memoryCredentials()
  const first = runtimeFor(t, server, credentials)
  await first.search({ query: 'first' })
  await first.dispose()
  server.expire()
  const second = runtimeFor(t, server, credentials, { openBrowser() { throw new Error('refresh must not open the browser') } })
  await second.search({ query: 'after restart' })
  assert.equal(server.stats.refreshes, 1)
  assert.equal(server.stats.logins, 1)
  assert.equal(server.stats.registrations, 1)
  assert.equal(credentials.snapshot().payload.tokens.refresh_token, 'test-refresh-2')
})

test('expiry during a reused connection refreshes and completes the current search', async t => {
  const server = await mockConsensus(t)
  const credentials = memoryCredentials()
  const runtime = runtimeFor(t, server, credentials)
  await runtime.search({ query: 'first' })
  server.expire()
  await runtime.search({ query: 'second' })
  assert.equal(server.stats.refreshes, 1)
  assert.equal(server.stats.logins, 1)
  assert.equal(server.stats.searches.length, 2)
})

test('revoked refresh token reauthorizes interactively instead of getting stuck', async t => {
  const server = await mockConsensus(t, { revokedRefresh: true })
  const runtime = runtimeFor(t, server)
  await runtime.search({ query: 'first' })
  server.expire()
  await runtime.search({ query: 'second' })
  assert.equal(server.stats.refreshes, 1)
  assert.equal(server.stats.logins, 2)
  assert.equal(server.stats.exchanges, 2)
  assert.equal(server.stats.searches.length, 2)
})

test('JSON and request-scoped SSE search responses are both supported', async t => {
  const server = await mockConsensus(t, { sse: true })
  const runtime = runtimeFor(t, server)
  const result = await runtime.search({ query: 'streamed result' })
  assert.match(textContent(result), /Mock paper/)
  assert.equal(server.stats.getMcp, 0)
})

test('parallel first searches share one OAuth login and one connection', async t => {
  const server = await mockConsensus(t)
  const runtime = runtimeFor(t, server)
  await Promise.all([runtime.search({ query: 'A' }), runtime.search({ query: 'B' }), runtime.search({ query: 'C' })])
  assert.equal(server.stats.logins, 1)
  assert.equal(server.stats.initializes, 1)
  assert.deepEqual(server.stats.searches.map(x => x.query), ['A', 'B', 'C'])
})

test('network failures do not leak error bodies or silently replay a search', async t => {
  const server = await mockConsensus(t)
  const runtime = runtimeFor(t, server)
  await runtime.search({ query: 'first' })
  server.failNextSearch()
  await assert.rejects(runtime.search({ query: 'fail once' }), error => {
    assert.doesNotMatch(String(error), /DO-NOT-LEAK/)
    return true
  })
  assert.equal(server.stats.searches.length, 2)
  await runtime.search({ query: 'explicit retry' })
  assert.equal(server.stats.searches.length, 3)
  assert.equal(server.stats.initializes, 2)
})

test('server tool errors are failures, not fabricated successful results', async t => {
  const server = await mockConsensus(t, { toolError: true, text: 'Search quota exhausted.' })
  const runtime = runtimeFor(t, server)
  await assert.rejects(runtime.search({ query: 'q' }), /Search quota exhausted/)
})

test('missing remote search tool fails closed', async t => {
  const server = await mockConsensus(t, { noSearch: true })
  const runtime = runtimeFor(t, server)
  await assert.rejects(runtime.search({ query: 'q' }), /does not advertise tool: search/)
  assert.equal(server.stats.searches.length, 0)
})

test('wrong OAuth state times out and never exchanges a code', async t => {
  const server = await mockConsensus(t, { badState: true })
  const runtime = runtimeFor(t, server, memoryCredentials(), { authTimeoutMs: 80 })
  await assert.rejects(runtime.search({ query: 'q' }), /timed out/)
  assert.equal(server.stats.exchanges, 0)
  assert.equal(server.stats.searches.length, 0)
})

for (const scenario of ['badIssuer', 'missingIssuer']) {
  test(`OAuth ${scenario} is rejected before token exchange`, async t => {
    const server = await mockConsensus(t, { [scenario]: true })
    const runtime = runtimeFor(t, server)
    await assert.rejects(runtime.search({ query: 'q' }))
    assert.equal(server.stats.exchanges, 0)
    assert.equal(server.stats.searches.length, 0)
  })
}

test('loopback callback rejects wrong state, Host, Origin, method and duplicates; accepts one valid response', async t => {
  const credentials = memoryCredentials()
  const provider = new ConsensusOAuth(credentials, { endpoint: 'https://example.invalid/mcp' })
  t.after(() => provider.end())
  await provider.prepare(new AbortController().signal)
  const state = await provider.state()
  const url = new URL(provider.redirectUrl)
  url.searchParams.set('state', 'wrong')
  url.searchParams.set('code', 'test-code')
  assert.equal((await fetch(url)).status, 403)
  url.searchParams.set('state', state)
  // fetch intentionally normalizes Host; use HTTP directly to send the hostile header.
  const hostileHostStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(url, { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode) })
    req.on('error', reject)
    req.end()
  })
  assert.equal(hostileHostStatus, 403)
  assert.equal((await fetch(url, { headers: { Origin: 'https://evil.example' } })).status, 403)
  assert.equal((await fetch(url, { method: 'POST' })).status, 403)
  url.searchParams.append('state', state)
  assert.equal((await fetch(url)).status, 403)
  url.searchParams.delete('state')
  url.searchParams.set('state', state)
  const good = await fetch(url)
  assert.equal(good.status, 200)
  assert.equal(good.headers.get('cache-control'), 'no-store')
  assert.equal((await fetch(url)).status, 403, 'callback must be single-use')
  let finished = false
  await provider.finishAuthorization({ async finishAuth(params) { finished = true; assert.equal(params.get('code'), 'test-code') } })
  assert.equal(finished, true)
  await assert.rejects(fetch(provider.redirectUrl))
})

test('unloading during browser login aborts pending work and closes the loopback listener', async t => {
  const server = await mockConsensus(t)
  const browserOpened = Promise.withResolvers()
  const credentials = memoryCredentials()
  const runtime = runtimeFor(t, server, credentials, { openBrowser() { browserOpened.resolve() } })
  const search = runtime.search({ query: 'q' })
  const rejection = assert.rejects(search)
  await browserOpened.promise
  const callback = credentials.snapshot().payload.redirectUrl
  await runtime.dispose()
  await rejection
  await assert.rejects(fetch(callback))
  assert.equal(server.stats.searches.length, 0)
  await assert.rejects(runtime.search({ query: 'after unload' }), /unloaded/)
})

test('canceling a queued search is immediate and does not make a remote request', async t => {
  const server = await mockConsensus(t)
  const opened = Promise.withResolvers()
  const runtime = runtimeFor(t, server, memoryCredentials(), { openBrowser() { opened.resolve() } })
  const first = runtime.search({ query: 'first' })
  const firstRejected = assert.rejects(first)
  await opened.promise
  const controller = new AbortController()
  const second = runtime.search({ query: 'cancel me' }, { signal: controller.signal })
  controller.abort()
  await assert.rejects(second)
  await runtime.dispose()
  await firstRejected
  assert.equal(server.stats.searches.length, 0)
})

test('canceling an in-flight HTTP search tears down the connection', async t => {
  const server = await mockConsensus(t)
  const runtime = runtimeFor(t, server)
  server.hangSearch()
  const controller = new AbortController()
  const result = runtime.search({ query: 'wait forever' }, { signal: controller.signal })
  const rejected = assert.rejects(result)
  await server.searchReceived
  controller.abort()
  await rejected
  await runtime.dispose()
})

test('browser launch failure fails promptly rather than waiting for the OAuth timeout', async t => {
  const server = await mockConsensus(t)
  const runtime = runtimeFor(t, server, memoryCredentials(), { openBrowser() { throw new Error('default browser unavailable') } })
  await assert.rejects(runtime.search({ query: 'q' }), /Could not open/)
  assert.equal(server.stats.exchanges, 0)
})

test('network deadline aborts an unresponsive server without replaying the search', async t => {
  const server = await mockConsensus(t)
  const runtime = runtimeFor(t, server, memoryCredentials(), { networkTimeoutMs: 100 })
  server.hangSearch()
  await assert.rejects(runtime.search({ query: 'q' }))
  assert.equal(server.stats.searches.length, 1)
})

test('oversized server context is rejected before invoking search', async t => {
  const server = await mockConsensus(t, { instructions: 'x'.repeat(32_769) })
  const runtime = runtimeFor(t, server)
  await assert.rejects(runtime.search({ query: 'q' }), /safety limit/)
  assert.equal(server.stats.searches.length, 0)
})

test('incompatible credential records are not silently overwritten', async () => {
  const initial = { kind: 'grant', payload: { version: 99, endpoint: 'https://mcp.consensus.app/mcp' } }
  const credentials = memoryCredentials(initial)
  const provider = new ConsensusOAuth(credentials)
  await assert.rejects(provider.read(), /incompatible/)
  await assert.rejects(provider.patch({ tokens: { access_token: 'fake' } }), /overwrite/)
  assert.deepEqual(credentials.snapshot(), initial)
})

test('credential invalidation preserves unrelated fields and strips nested undefined', async () => {
  const credentials = memoryCredentials()
  const provider = new ConsensusOAuth(credentials)
  await provider.patch({ tokens: { access_token: 'fake', optional: undefined }, clientInformation: { client_id: 'fake' }, discoveryState: { authorizationServerUrl: 'https://example.invalid' } })
  await provider.invalidateCredentials('tokens')
  const record = await credentials.readRecord(CREDENTIAL_KEY)
  assert.equal(record.payload.tokens, undefined)
  assert.equal(record.payload.clientInformation.client_id, 'fake')
  assert.ok(record.payload.discoveryState)
  await provider.invalidateCredentials('all')
  assert.equal(credentials.snapshot().payload.clientInformation, undefined)
})
