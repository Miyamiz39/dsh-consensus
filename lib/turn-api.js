import { turnSearches } from './turns.js'

export const TURN_PATH = '/api/consensus/turn'

function json(value, status = 200) {
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  })
}

/**
 * Serve the papers one turn produced, so the conversation can render them below
 * the reply instead of at the Tool call.
 * Connection owns peer admission and origin checks; the route stays read-only and
 * answers only for a live Session it holds.
 * @param {object} connection - the Host Connection service.
 * @param {{sessions?: object}} services - the Session store to read from.
 * @returns {() => void} the route's disposer.
 */
export function registerTurnApi(connection, services) {
  return connection.fetch.register({
    path: TURN_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        const url = new URL(request.url)
        const sessionId = url.searchParams.get('session') ?? ''
        const seq = Number(url.searchParams.get('seq'))
        if (sessionId === '' || !Number.isInteger(seq) || seq < 0) {
          return json({ ok: false, error: 'Expected a session and seq' }, 400)
        }
        const session = services.sessions?.get(sessionId)
        if (session === undefined || session === null) return json({ ok: true, searches: [] })
        return json({ ok: true, searches: turnSearches(session, seq) })
      } catch {
        return json({ ok: false, error: '检索结果暂不可用，请刷新页面后重试。' }, 503)
      }
    },
  })
}
