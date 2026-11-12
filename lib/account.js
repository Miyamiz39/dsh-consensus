export const ACCOUNT_PATH = '/api/consensus/account'

// One Host-owned login task. HTTP responses stay short; opening/closing the settings
// page neither starts nor cancels a login. Only explicit actions mutate the account.
export function createAccountController(runtime) {
  let job = { state: 'idle', error: null }
  let pending
  let abort
  let generation = 0
  let disposed = false
  let signingOut = false

  const status = async () => ({ ...await runtime.status(), login: { ...job } })
  return {
    status,
    startLogin() {
      if (disposed) throw new Error('Account controller disposed')
      if (signingOut) return
      if (pending) return
      const id = ++generation
      abort = new AbortController()
      job = { state: 'running', error: null }
      const task = runtime.login({ signal: abort.signal })
      pending = task.then(() => {
        if (generation === id) job = { state: 'success', error: null }
      }, () => {
        // No raw server, OAuth, or credential errors cross the settings API.
        if (generation === id) job = { state: 'error', error: '登录未完成，请检查浏览器授权及网络后重试。' }
      }).finally(() => {
        if (generation === id) { pending = undefined; abort = undefined }
      })
    },
    async logout() {
      if (disposed) throw new Error('Account controller disposed')
      signingOut = true
      ++generation
      abort?.abort()
      try {
        await runtime.logout()
        await pending
        pending = undefined
        abort = undefined
        job = { state: 'idle', error: null }
      } finally { signingOut = false }
    },
    async dispose() {
      disposed = true
      ++generation
      abort?.abort()
      await pending
    },
  }
}

function json(value, status = 200) {
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  })
}

export function registerAccountApi(connection, controller) {
  // Connection owns Host/Origin checks, authenticated Peer admission, owner-only
  // access and Desktop IPC routing; never register an unprotected webServer route.
  return connection.fetch.register({
    path: ACCOUNT_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        if (request.method === 'GET') return json({ ok: true, account: await controller.status() })
        if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405)
        if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
          return json({ ok: false, error: 'Expected application/json' }, 415)
        }
        const text = await request.text()
        if (Buffer.byteLength(text) > 1024) return json({ ok: false, error: 'Request too large' }, 413)
        let body
        try { body = JSON.parse(text) } catch { return json({ ok: false, error: 'Invalid JSON' }, 400) }
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !['login', 'logout'].includes(body.action)) {
          return json({ ok: false, error: 'Expected a login or logout action' }, 400)
        }
        if (body.action === 'login') {
          controller.startLogin()
          return json({ ok: true, account: await controller.status() }, 202)
        }
        await controller.logout()
        return json({ ok: true, account: await controller.status() })
      } catch {
        return json({ ok: false, error: '账号操作失败，请检查插件状态与凭据存储后重试。' }, 503)
      }
    },
  })
}
