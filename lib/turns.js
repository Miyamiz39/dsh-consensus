import { parseSearch } from './papers.js'
import { publicToolName } from './tools.js'

export const SEARCH_TOOL = publicToolName('search')
// A failed search keeps its short failure text for the card's fallback body; a
// successful one would only duplicate what the parsed records already carry.
const MAX_FALLBACK_CHARS = 4000

/**
 * Collect the text content of one tool result message.
 * @param {object} message - the Session's ToolResultMessage.
 * @returns {string} the joined text blocks.
 */
export function resultText(message) {
  const parts = []
  for (const block of Array.isArray(message?.content) ? message.content : []) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n\n')
}

/**
 * Read the papers one completed turn produced, from the same Session log the
 * conversation renders. Call names come from the turn's own `tool/call` events,
 * because a `tool/result` records only the call id.
 * @param {object} session - the live Session whose log holds the turn.
 * @param {number} seq - the turn's closing event sequence.
 * @returns {Array<object>} one entry per Consensus search in that turn, in call order.
 */
export function turnSearches(session, seq) {
  if (!session || !Number.isInteger(seq) || seq < 0) return []
  const end = Math.min(seq, Number(session.seq))
  const events = session.snapshotEvents(0, end + 1)
  const calls = new Map()
  let turn
  for (const event of events) {
    if (event.type === 'tool/call') calls.set(event.data.callId, { name: event.data.name, args: event.data.arguments })
    else if (event.type === 'turn/start') turn = event.data.turn
  }
  if (turn === undefined) return []
  const searches = []
  for (const event of events) {
    if (event.type !== 'tool/result' || event.data.turn !== turn) continue
    const callId = event.data.message?.source?.callId
    if (calls.get(callId)?.name !== SEARCH_TOOL) continue
    const text = resultText(event.data.message)
    const parsed = parseSearch(text)
    const args = parseQuery(calls.get(callId)?.args)
    searches.push({
      callId: String(callId),
      query: args.query,
      isError: event.data.message?.isError === true,
      total: parsed.total,
      papers: parsed.papers,
      // Only a result the card cannot render from records keeps its raw text.
      text: parsed.papers.length > 0 ? '' : text.slice(0, MAX_FALLBACK_CHARS),
    })
  }
  return searches
}

/**
 * Read the plain-language query out of a recorded call's arguments.
 * @param {string | undefined} raw - the recorded JSON argument string.
 * @returns {{query: string}} the query, empty when unavailable.
 */
export function parseQuery(raw) {
  try {
    const value = JSON.parse(String(raw ?? ''))
    return { query: typeof value?.query === 'string' ? value.query.trim() : '' }
  } catch { return { query: '' } }
}
