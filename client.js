window.__ModuleLoader__.load({
  id: 'dsh-consensus',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const PATH = '/api/consensus/account'
    const PACKAGE = 'dsh-consensus'

    async function request(action, signal) {
      const response = await fetch(PATH, {
        method: action ? 'POST' : 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: action ? { 'Content-Type': 'application/json' } : {},
        ...(action ? { body: JSON.stringify({ action }) } : {}),
        signal,
      })
      let result
      try { result = await response.json() } catch { throw new Error('账号管理暂不可用，请重载插件后刷新页面。') }
      if (!response.ok || !result.ok) throw new Error(result.error || '账号操作失败，请稍后重试。')
      return result.account
    }

    const css = `
      .consensus-account{font:inherit;color:inherit;max-width:720px;width:100%;box-sizing:border-box}
      .consensus-account *{box-sizing:border-box}
      .consensus-account header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:20px}
      .consensus-account h3{font-size:17px;font-weight:600;margin:0 0 5px;letter-spacing:-.02em}
      .consensus-account p{line-height:1.6;margin:0}
      .consensus-badge{border-radius:999px;padding:5px 11px;background:color-mix(in srgb,currentColor 7%,transparent);font-size:12px;white-space:nowrap}
      .consensus-badge[data-active=true]{color:#15803d;background:color-mix(in srgb,#22c55e 12%,transparent)}
      .consensus-actions{display:flex;flex-wrap:wrap;gap:9px;margin:20px 0 14px}
      .consensus-account button{font:inherit;font-size:13px;cursor:pointer;border:1px solid color-mix(in srgb,currentColor 16%,transparent);border-radius:9px;padding:9px 15px;background:transparent;color:inherit}
      .consensus-account button.primary{background:#2563eb;border-color:#2563eb;color:white}
      .consensus-account button.danger{color:#dc2626}
      .consensus-account button:disabled{opacity:.45;cursor:default}
      .consensus-account button:focus-visible{outline:2px solid #2563eb;outline-offset:3px}
      .consensus-message{border-radius:10px;background:color-mix(in srgb,#2563eb 8%,transparent);padding:11px 14px;margin:0 0 14px;font-size:13px;line-height:1.6}
      .consensus-message.error{background:color-mix(in srgb,#dc2626 8%,transparent);color:#dc2626}
      @media(max-width:440px){.consensus-account header{align-items:flex-start}}
    `

    function AccountPanel({ view } = {}) {
      const [account, setAccount] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [confirmLogout, setConfirmLogout] = React.useState(false)
      const [refresh, setRefresh] = React.useState(0)
      const version = React.useRef(0)
      const mounted = React.useRef(false)
      const requests = React.useRef(new Set())
      const actionBusy = React.useRef(false)

      React.useEffect(() => {
        mounted.current = true
        return () => {
          mounted.current = false
          version.current++
          for (const controller of requests.current) controller.abort()
          requests.current.clear()
        }
      }, [])

      React.useEffect(() => {
        if (view === 'summary') return
        let stopped = false
        let timer
        let controller
        const poll = async () => {
          if (document.visibilityState === 'hidden' || actionBusy.current) { timer = setTimeout(poll, 2000); return }
          const id = version.current
          controller = new AbortController()
          requests.current.add(controller)
          try {
            const next = await request(undefined, controller.signal)
            if (!stopped && id === version.current) { setAccount(next); setError('') }
          } catch (err) {
            if (!stopped && id === version.current && !controller.signal.aborted) setError(err.message)
          } finally {
            requests.current.delete(controller)
            if (!stopped) timer = setTimeout(poll, 2000)
          }
        }
        poll()
        return () => { stopped = true; clearTimeout(timer); controller?.abort() }
      }, [view, refresh])

      async function action(kind) {
        if (actionBusy.current) return
        actionBusy.current = true
        const id = ++version.current
        setBusy(true)
        setError('')
        setConfirmLogout(false)
        const controller = new AbortController()
        requests.current.add(controller)
        try {
          const next = await request(kind, controller.signal)
          if (mounted.current && id === version.current) setAccount(next)
        } catch (err) {
          if (mounted.current && !controller.signal.aborted) setError(err.message)
        } finally {
          requests.current.delete(controller)
          actionBusy.current = false
          if (mounted.current) { setBusy(false); setRefresh(n => n + 1) }
        }
      }

      if (view === 'summary') return h('span', null, '管理 Consensus 登录。')
      const running = account?.login.state === 'running' || ['connecting', 'authorizing'].includes(account?.phase)
      const authorized = Boolean(account?.authorized)
      const badge = authorized ? '已登录' : '未登录'
      const loginError = account?.login.state === 'error' ? account.login.error : ''
      return h('section', { className: 'consensus-account', 'aria-label': 'Consensus 账号管理' },
        h('style', null, css),
        h('header', null,
          h('h3', null, 'Consensus 账号'),
          h('span', { className: 'consensus-badge', 'data-active': authorized }, account ? badge : '读取中')),
        (error || loginError) && h('div', { className: 'consensus-message error', role: 'alert' }, error || loginError),
        running && h('div', { className: 'consensus-message', role: 'status' }, account?.phase === 'authorizing' ? '请在已打开的浏览器中完成 Consensus 授权。完成后这里会自动更新。' : '正在建立连接，请稍候。'),
        h('div', { className: 'consensus-actions' },
          !authorized && h('button', { type: 'button', className: 'primary', disabled: busy || running || !account, onClick: () => action('login') }, '登录 Consensus'),
          h('button', { type: 'button', disabled: busy, onClick: () => setRefresh(n => n + 1) }, '刷新状态'),
          (authorized || running) && h('button', { type: 'button', className: 'danger', disabled: busy, onClick: () => setConfirmLogout(true) }, running ? '取消登录' : '退出登录')),
        confirmLogout && h('div', { className: 'consensus-message', role: 'group', 'aria-label': '确认退出登录' },
          h('p', null, '退出会清除本插件保存的授权并中断当前搜索或登录。'),
          h('div', { className: 'consensus-actions' },
            h('button', { type: 'button', className: 'danger', disabled: busy, onClick: () => action('logout') }, '确认退出'),
            h('button', { type: 'button', disabled: busy, onClick: () => setConfirmLogout(false) }, '返回'))))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        for (const [name, key] of [['plugins.bundle.config', PACKAGE], ['plugins.row.config', `${PACKAGE}#consensus-mcp`]]) {
          ctx.slots.inject(name, () => ctx.slots.register({ name, key, registrant: PACKAGE }, AccountPanel))
        }
      },
    }
  },
})
