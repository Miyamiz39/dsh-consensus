import test from 'node:test'
import assert from 'node:assert/strict'
import { createRuntime } from '../lib/runtime.js'
import { ACCOUNT_PATH, createAccountController, registerAccountApi } from '../lib/account.js'
import { memoryCredentials, mockConsensus } from './fixtures.js'

function setup(t, server, overrides = {}) {
  const credentials = memoryCredentials()
  const runtime = createRuntime(credentials, { endpoint: server.endpoint, openBrowser: server.openBrowser, operationTimeoutMs: 5000, ...overrides })
  const account = createAccountController(runtime)
  t.after(async () => { await runtime.dispose(); await account.dispose() })
  let route
  registerAccountApi({ fetch: { register(value) { route = value; return () => {} } } }, account)
  const api = async (action, extra = {}) => {
    const response = await route.fetch(new Request(`http://dsh.internal${ACCOUNT_PATH}`, {
      ...(action ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) } : {}),
      ...extra,
    }))
    return { response, body: await response.json() }
  }
  return { credentials, runtime, account, api, route }
}

// Waits on local async work with a bounded timer; never contacts real services.
async function finished(account) {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const status = await account.status()
    if (status.login.state !== 'running') return status
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Test login did not settle')
}

test('reading the account is local-only and exposes an allowlisted unauthenticated status', async t => {
  const server = await mockConsensus(t)
  const { api, route } = setup(t, server)
  const { response, body } = await api()
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(body.account.authorized, false)
  assert.equal(Object.hasOwn(body.account, 'profile'), false)
  assert.equal(Object.hasOwn(body.account, 'profileNote'), false)
  assert.equal(server.stats.requests, 0)
  assert.equal(route.path, '/api/consensus/account')
  assert.deepEqual(route.methods, ['GET', 'POST'])
  assert.equal(route.requestBody, 'buffered')
})

test('manual login authorizes and discovers tools without executing any search', async t => {
  const server = await mockConsensus(t)
  const { api, account, credentials } = setup(t, server)
  const start = await api('login')
  assert.equal(start.response.status, 202)
  const status = await finished(account)
  assert.equal(status.login.state, 'success')
  assert.equal(status.authorized, true)
  assert.equal(status.connected, true)
  assert.equal(status.refreshable, true)
  assert.deepEqual(status.scopes, ['search'])
  assert.equal(status.expired, false)
  assert.ok(status.authorizedAt > 0)
  assert.ok(status.updatedAt > 0)
  assert.equal(status.expiresAt, credentials.snapshot().payload.expiresAt)
  assert.equal(server.stats.searches.length, 0)
  const serialized = JSON.stringify((await api()).body)
  for (const secret of ['test-access-', 'test-refresh-', 'test-client', 'clientInformation', 'redirectUrl', 'discoveryState', 'codeVerifier']) assert.ok(!serialized.includes(secret), secret)
})

test('a second manual login checks the existing connection without duplicate browsers', async t => {
  const server = await mockConsensus(t)
  const { api, account } = setup(t, server)
  await api('login')
  await api('login')
  await finished(account)
  await api('login')
  await finished(account)
  assert.equal(server.stats.logins, 1)
  assert.equal(server.stats.initializes, 1)
  assert.equal(server.stats.searches.length, 0)
})

test('logout deletes only this plugin grant, closes connection and clears server context', async t => {
  const server = await mockConsensus(t)
  const { runtime, credentials, api } = setup(t, server)
  await runtime.login()
  assert.ok(runtime.instructions)
  const before = server.stats.requests
  const { body } = await api('logout')
  assert.equal(body.account.authorized, false)
  assert.equal(body.account.connected, false)
  assert.equal(body.account.login.state, 'idle')
  assert.deepEqual(body.account.scopes, [])
  assert.equal(credentials.snapshot(), undefined)
  assert.equal(runtime.instructions, '')
  assert.equal(server.stats.requests, before, 'local logout must not revoke remote sessions or make network requests')
  await api('logout')
  await runtime.login()
  assert.equal(server.stats.logins, 2)
  assert.equal(server.stats.registrations, 2)
  assert.equal(server.stats.searches.length, 0)
})

test('logout cancels a pending browser login, clears partial registration and prevents late token writes', async t => {
  const server = await mockConsensus(t)
  const opened = Promise.withResolvers()
  const { api, account, credentials } = setup(t, server, { openBrowser() { opened.resolve() } })
  await api('login')
  await opened.promise
  const callback = credentials.snapshot().payload.redirectUrl
  const status = await account.status()
  assert.equal(status.phase, 'authorizing')
  await api('logout')
  assert.equal(credentials.snapshot(), undefined)
  await assert.rejects(fetch(callback))
  assert.equal(server.stats.exchanges, 0)
  assert.equal((await account.status()).login.state, 'idle')
})

test('logout aborts active and queued searches; subsequent explicit login still works', async t => {
  const server = await mockConsensus(t)
  const { runtime, credentials, api } = setup(t, server)
  server.hangSearch()
  const first = runtime.search({ query: 'active' })
  const firstRejected = assert.rejects(first)
  await server.searchReceived
  const second = runtime.search({ query: 'queued' })
  const secondRejected = assert.rejects(second)
  await api('logout')
  await Promise.all([firstRejected, secondRejected])
  assert.equal(server.stats.searches.length, 1)
  assert.equal(credentials.snapshot(), undefined)
  await runtime.login()
  assert.equal((await runtime.status()).authorized, true)
})

test('invalid/malformed/cross-content actions do not start login or delete credentials', async t => {
  const server = await mockConsensus(t)
  const { api, credentials } = setup(t, server)
  for (const [body, expected] of [['{', 400], ['null', 400], ['[]', 400], ['{"action":"login","extra":true}', 400], ['{"action":"revoke"}', 400], [' '.repeat(1025), 413]]) {
    const result = await api('login', { body })
    assert.equal(result.response.status, expected)
  }
  assert.equal((await api('login', { headers: { 'Content-Type': 'text/plain' } })).response.status, 415)
  assert.equal((await api('login', { method: 'DELETE' })).response.status, 405)
  assert.equal(server.stats.requests, 0)
  assert.equal(credentials.stats.writes, 0)
})

test('failed manual login returns only a generic error rather than OAuth response text', async t => {
  const server = await mockConsensus(t)
  const { api, account } = setup(t, server, { openBrowser() { throw new Error('sensitive-oauth-content') } })
  await api('login')
  const status = await finished(account)
  assert.equal(status.login.state, 'error')
  assert.doesNotMatch(JSON.stringify(status), /sensitive-oauth-content/)
  assert.match(status.login.error, /登录未完成/)
})

test('old grants without timestamp metadata remain usable and do not invent identity or dates', async t => {
  const server = await mockConsensus(t)
  const { runtime, credentials } = setup(t, server)
  await runtime.login()
  await credentials.modifyRecord('consensus-mcp/oauth', record => {
    delete record.payload.expiresAt
    delete record.payload.authorizedAt
    delete record.payload.updatedAt
    return record
  })
  const status = await runtime.status()
  assert.equal(status.authorized, true)
  assert.equal(status.authorizedAt, null)
  assert.equal(status.expiresAt, null)
  assert.equal(status.expired, null)
  assert.equal(Object.hasOwn(status, 'profile'), false)
})

test('plugin disposal waits for a concurrent logout credential deletion to settle', async () => {
  const credentials = memoryCredentials()
  const deleting = Promise.withResolvers()
  const release = Promise.withResolvers()
  credentials.deleteRecord = async () => { deleting.resolve(); await release.promise }
  const runtime = createRuntime(credentials)
  const logout = runtime.logout()
  await deleting.promise
  let disposed = false
  const disposal = runtime.dispose().then(() => { disposed = true })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(disposed, false)
  release.resolve()
  await Promise.all([logout, disposal])
  assert.equal(disposed, true)
})

test('credential failures are sanitized at the settings API boundary', async () => {
  let route
  const runtime = { status() { throw new Error('SECRET') } }
  registerAccountApi({ fetch: { register(r) { route = r } } }, createAccountController(runtime))
  const response = await route.fetch(new Request(`http://dsh.internal${ACCOUNT_PATH}`))
  assert.equal(response.status, 503)
  assert.doesNotMatch(await response.text(), /SECRET/)
})
