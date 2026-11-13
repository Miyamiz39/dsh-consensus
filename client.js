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

    // A Consensus search returns many papers, so the reply is followed by one card per
    // search. The papers come from the Host's Session log, because a position below the
    // reply has no access to the Tool call's own block.
    const SEARCH_TOOL = 'mcp__consensus__search'
    const TURN_PATH = '/api/consensus/turn'
    const PREVIEW = 3
    const tailCache = new Map()

    function textOf(block) {
      const parts = []
      for (const item of Array.isArray(block?.content) ? block.content : []) {
        if (item && item.type === 'text' && typeof item.text === 'string') parts.push(item.text)
      }
      return parts.join('\n\n')
    }

    function argsOf(block) {
      const raw = typeof block?.argsRaw === 'string' ? block.argsRaw : typeof block?.call?.argsRaw === 'string' ? block.call.argsRaw : null
      if (raw === null) return null
      try {
        const value = JSON.parse(raw)
        return value && typeof value === 'object' && !Array.isArray(value) ? value : null
      } catch { return null }
    }

    function oneLine(text) {
      return String(text ?? '').replace(/\s+/g, ' ').trim()
    }

    function announcedCount(text) {
      const found = /^Found (\d+) papers?/m.exec(String(text ?? ''))
      return found ? Number(found[1]) : null
    }

    async function loadTail(sessionId, seq) {
      const key = `${sessionId}:${seq}`
      if (tailCache.has(key)) return tailCache.get(key)
      let searches = []
      try {
        const response = await fetch(`${TURN_PATH}?session=${encodeURIComponent(sessionId)}&seq=${seq}`, {
          credentials: 'same-origin',
          cache: 'no-store',
        })
        const body = await response.json()
        if (response.ok && body?.ok && Array.isArray(body.searches)) searches = body.searches
      } catch { searches = [] }
      tailCache.set(key, searches)
      return searches
    }

    const searchCss = `
      .consensus-icon{flex:none;width:14px;height:14px;margin-right:7px;color:var(--dsw-alias-label-tertiary)}
      .consensus-row{display:flex;align-items:center;min-width:0;padding:2px 0}
      .consensus-row[data-state=running] .consensus-icon{color:var(--dsw-alias-brand-primary);animation:consensus-pulse 1.2s ease-in-out infinite}
      .consensus-row[data-state=error] .consensus-icon,.consensus-row[data-state=error] .consensus-summary{color:var(--dsw-alias-state-error-primary)}
      @keyframes consensus-pulse{0%,100%{opacity:.4}50%{opacity:1}}
      .consensus-title{flex:none;font-size:14px;line-height:24px;font-weight:500;font-family:system-ui,-apple-system,sans-serif}
      .consensus-sep{flex:none;width:2px;height:2px;margin:0 8px;border-radius:1px;background:var(--dsw-alias-label-tertiary)}
      .consensus-summary{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;line-height:24px;color:var(--dsw-alias-label-secondary);font-family:system-ui,-apple-system,sans-serif}
      .consensus-count{flex:none;margin-left:8px;font-size:13px;line-height:24px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
      .consensus-hint{flex:none;margin-left:8px;font-size:13px;line-height:24px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
      .consensus-tail{display:flex;flex-direction:column;gap:10px;margin:10px 0 2px}
      .consensus-card{display:flex;flex-direction:column;padding:8px 10px 4px;border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
      .consensus-card-head{display:flex;align-items:center;min-width:0;padding-bottom:4px}
      .consensus-card[data-state=error] .consensus-icon,.consensus-card[data-state=error] .consensus-summary{color:var(--dsw-alias-state-error-primary)}
      .consensus-paper{display:flex;flex-direction:column;gap:3px;padding:10px 8px;border-top:.5px solid var(--dsw-alias-border-l1);border-radius:8px}
      .consensus-paper:first-child{border-top:0}
      @media (hover:hover){.consensus-paper:hover{background:var(--dsw-alias-bg-layer-2)}}
      .consensus-paper-head{display:flex;gap:8px;align-items:center;min-width:0}
      .consensus-paper-index{flex:none;display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:20px;padding:0 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);font-family:system-ui,-apple-system,sans-serif;font-size:12px;font-weight:600;line-height:1;color:var(--dsw-alias-label-primary)}
      .consensus-paper-title{min-width:0;font-size:14.5px;line-height:1.5;color:var(--dsw-alias-label-primary);text-decoration:none;font-weight:500;font-family:system-ui,-apple-system,sans-serif}
      .consensus-paper-title:hover{text-decoration:underline;text-underline-offset:3px}
      .consensus-paper-meta{display:flex;flex-wrap:wrap;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary);font-family:system-ui,-apple-system,sans-serif}
      .consensus-paper-meta span+span::before{content:'·';margin:0 6px;color:var(--dsw-alias-label-tertiary)}
      .consensus-paper-abstract{margin:4px 0 0;font-size:13.5px;line-height:1.6;color:var(--dsw-alias-label-secondary);cursor:pointer;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;font-family:system-ui,-apple-system,sans-serif}
      .consensus-paper-abstract[data-open=true]{display:block;-webkit-line-clamp:unset}
      .consensus-card-raw{margin:0;padding:9px 8px 9px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary)}
      .consensus-card-more{align-self:flex-start;margin:4px 0 2px 8px;padding:2px 0;border:0;background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:13px;line-height:20px;cursor:pointer}
      .consensus-card-more:hover{text-decoration:underline}
      .consensus-card-more:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:4px}
    `

    const SearchIcon = () => h('svg', { className: 'consensus-icon', viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
      h('circle', { cx: 7, cy: 7, r: 4.4, stroke: 'currentColor', strokeWidth: 1.4 }),
      h('path', { d: 'M10.4 10.4 14 14', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
      h('circle', { cx: 7, cy: 7, r: 1.2, fill: 'currentColor' }))

    function PaperRow({ paper }) {
      const [open, setOpen] = React.useState(false)
      const meta = [
        paper.authors,
        paper.year === null || paper.year === undefined ? '' : String(paper.year),
        paper.venue,
        paper.citations === null || paper.citations === undefined ? '' : `${paper.citations} Citations`,
      ].filter(Boolean)
      return h('div', { className: 'consensus-paper' },
        h('div', { className: 'consensus-paper-head' },
          h('span', { className: 'consensus-paper-index' }, paper.number),
          h('a', { className: 'consensus-paper-title', href: paper.url, target: '_blank', rel: 'noreferrer noopener' }, paper.title)),
        Boolean(meta.length) && h('div', { className: 'consensus-paper-meta' }, meta.map((value, index) => h('span', { key: index }, value))),
        Boolean(paper.abstract) && h('p', {
          className: 'consensus-paper-abstract',
          'data-open': open,
          title: open ? '收起摘要' : '展开摘要',
          onClick: () => setOpen(value => !value),
        }, paper.abstract))
    }

    /** One search's papers, collapsed to a readable preview until the reader asks for more. */
    function SearchCard({ search }) {
      const [expanded, setExpanded] = React.useState(false)
      const papers = Array.isArray(search.papers) ? search.papers : []
      const count = search.total ?? papers.length
      const shown = expanded ? papers : papers.slice(0, PREVIEW)
      const summary = search.query === '' ? '检索结果' : `「${search.query}」`
      return h('div', { className: 'consensus-card', 'data-state': search.isError ? 'error' : 'done' },
        h('div', { className: 'consensus-card-head' },
          h(SearchIcon),
          h('span', { className: 'consensus-title' }, 'Consensus 检索'),
          h('span', { className: 'consensus-sep', 'aria-hidden': true }),
          h('span', { className: 'consensus-summary', title: summary }, summary),
          !search.isError && h('span', { className: 'consensus-count' }, `${count} papers`)),
        papers.length > 0
          ? shown.map(paper => h(PaperRow, { key: `${paper.number}-${paper.url}`, paper }))
          : h('pre', { className: 'consensus-card-raw' }, search.text || '通信或授权失败，请检查网络与 Consensus 登录状态后重试。'),
        papers.length > PREVIEW && h('button', {
          type: 'button',
          className: 'consensus-card-more',
          'aria-expanded': expanded,
          onClick: () => setExpanded(value => !value),
        }, expanded ? '收起' : `展开全部 ${papers.length} 篇`))
    }

    /** The compact row that stays at the Tool call, pointing at the card below the reply. */
    function InlineSearchRow({ phase, block }) {
      const running = phase !== 'result'
      const failed = !running && block?.isError === true
      const args = argsOf(block)
      const query = typeof args?.query === 'string' ? args.query.trim() : ''
      const total = running ? null : announcedCount(textOf(block))
      const summary = failed
        ? oneLine(textOf(block)) || '检索失败'
        : running
          ? (query === '' ? '正在检索论文' : `正在检索「${query}」`)
          : (query === '' ? '检索结果' : `「${query}」`)
      return h('div', { className: 'consensus-row', 'data-state': running ? 'running' : failed ? 'error' : 'done' },
        h(SearchIcon),
        h('span', { className: 'consensus-title' }, 'Consensus 检索'),
        h('span', { className: 'consensus-sep', 'aria-hidden': true }),
        h('span', { className: 'consensus-summary', title: summary }, summary),
        !running && !failed && total !== null && h('span', { className: 'consensus-count' }, `${total} papers`),
        !running && h('span', { className: 'consensus-hint' }, '↓ 结果见文末'))
    }

    /** Turns the reply's own papers into cards below the reply; renders nothing when there are none. */
    function TurnTail({ seq, sessionId }) {
      const key = `${sessionId}:${seq}`
      const [searches, setSearches] = React.useState(() => tailCache.get(key) ?? null)
      React.useEffect(() => {
        let alive = true
        const cached = tailCache.get(key)
        if (cached !== undefined) { setSearches(cached); return () => { alive = false } }
        loadTail(sessionId, seq).then(value => { if (alive) setSearches(value) })
        return () => { alive = false }
      }, [key, sessionId, seq])
      if (searches === null || searches.length === 0) return null
      return h('div', { className: 'consensus-tail' }, searches.map(search => h(SearchCard, { key: search.callId, search })))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        for (const [name, key] of [['plugins.bundle.config', PACKAGE], ['plugins.row.config', `${PACKAGE}#consensus-mcp`]]) {
          ctx.slots.inject(name, () => ctx.slots.register({ name, key, registrant: PACKAGE }, AccountPanel))
        }
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: SEARCH_TOOL }, InlineSearchRow))
        ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({ name: 'conversation.chat.turnTail', id: PACKAGE, order: 30 }, TurnTail))
        // One stylesheet for the whole page: the card renders once per search.
        ctx.effect(() => {
          const id = `${PACKAGE}/search-card.css`
          if (document.querySelector(`style[data-dsh-plugin-css="${id}"]`) !== null) return () => {}
          const tag = document.createElement('style')
          tag.dataset.dshPluginCss = id
          tag.textContent = searchCss
          document.head.appendChild(tag)
          return () => tag.remove()
        }, 'dsh-consensus: search card styles')
        // A reconnect can serve a different Host log, so the cached turn data is dropped.
        ctx.on('connection/reset', () => tailCache.clear())
      },
    }
  },
})
