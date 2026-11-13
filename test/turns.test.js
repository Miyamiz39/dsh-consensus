import test from 'node:test'
import assert from 'node:assert/strict'
import { SEARCH_TOOL, parseQuery, resultText, turnSearches } from '../lib/turns.js'

const RESULT = `Found 2 papers, showing top 2.

[1] [First paper](https://consensus.app/papers/details/w:1/) (Author A et al., 2024, 5 citations, Journal One)
  id: w:1
  First abstract.

[2] [Second paper](https://consensus.app/papers/details/w:2/) (Author B et al., 2022, 9 citations, Journal Two)
  id: w:2
  Second abstract.

IMPORTANT INSTRUCTIONS: cite the papers.
Upgrade to Consensus Pro to include more data.`

let seq = 0
function event(type, data) {
  return { type, seq: seq++, time: 0, data }
}
function reset() { seq = 0 }
function call(name, callId, args) {
  return event('tool/call', { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) })
}
function result(callId, text, options = {}) {
  return event('tool/result', {
    turn: options.turn ?? 1,
    step: 1,
    message: {
      id: `m-${callId}`,
      role: 'tool',
      toolCallId: callId,
      source: { kind: 'tool', callId },
      content: [{ type: 'text', text }],
      ...options.isError ? { isError: true } : {},
    },
  })
}
// The fold only needs the Session surface it reads: its log length and a slice read.
function sessionOf(events) {
  return { seq: events.length - 1, snapshotEvents: (from, to) => events.slice(from, to) }
}

test('a turn reports its own Consensus search, parsed and linked to its query', () => {
  reset()
  const events = [
    event('turn/start', { turn: 1 }),
    call(SEARCH_TOOL, 'c1', { query: 'resistance training', page_size: 2 }),
    result('c1', RESULT),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]
  const searches = turnSearches(sessionOf(events), events.length - 1)
  assert.equal(searches.length, 1)
  assert.equal(searches[0].callId, 'c1')
  assert.equal(searches[0].query, 'resistance training')
  assert.equal(searches[0].isError, false)
  assert.equal(searches[0].total, 2)
  assert.equal(searches[0].papers.length, 2)
  assert.equal(searches[0].papers[0].title, 'First paper')
  assert.equal(searches[0].papers[0].url, 'https://consensus.app/papers/details/w:1/')
  // A parsed result keeps no raw text; the records already carry it.
  assert.equal(searches[0].text, '')
})

test('other tools and other turns stay out of the reply', () => {
  reset()
  const events = [
    event('turn/start', { turn: 1 }),
    call(SEARCH_TOOL, 'c1', { query: 'first' }),
    result('c1', RESULT),
    call('web_search', 'c2', { query: 'unrelated' }),
    result('c2', 'Found 15 results.'),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    event('turn/start', { turn: 2 }),
    event('turn/end', { turn: 2, reason: { kind: 'completed' } }),
  ]
  assert.equal(turnSearches(sessionOf(events), 5).length, 1)
  // The later turn ran no search, so its reply contributes no card.
  assert.deepEqual(turnSearches(sessionOf(events), 7), [])
})

test('two searches in one turn both become cards, in call order', () => {
  reset()
  const events = [
    event('turn/start', { turn: 1 }),
    call(SEARCH_TOOL, 'c1', { query: 'first' }),
    result('c1', RESULT),
    call(SEARCH_TOOL, 'c2', { query: 'second' }),
    result('c2', RESULT),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]
  const searches = turnSearches(sessionOf(events), events.length - 1)
  assert.deepEqual(searches.map(search => search.query), ['first', 'second'])
})

test('a failed search keeps its text for the card fallback', () => {
  reset()
  const events = [
    event('turn/start', { turn: 1 }),
    call(SEARCH_TOOL, 'c1', { query: 'broken' }),
    result('c1', 'Consensus connection/search failed. Check the network and browser sign-in, then retry.', { isError: true }),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]
  const [search] = turnSearches(sessionOf(events), events.length - 1)
  assert.equal(search.isError, true)
  assert.deepEqual(search.papers, [])
  assert.match(search.text, /^Consensus connection\/search failed/)
})

test('a missing session, an invalid seq, or an empty log yields nothing', () => {
  reset()
  const events = [event('turn/start', { turn: 1 }), event('turn/end', { turn: 1, reason: { kind: 'completed' } })]
  assert.deepEqual(turnSearches(undefined, 1), [])
  assert.deepEqual(turnSearches(null, 1), [])
  assert.deepEqual(turnSearches(sessionOf(events), -1), [])
  assert.deepEqual(turnSearches(sessionOf(events), 1.5), [])
  assert.deepEqual(turnSearches(sessionOf([]), 0), [])
})

test('query extraction survives missing or malformed arguments', () => {
  assert.deepEqual(parseQuery('{"query":"  spaced  "}'), { query: 'spaced' })
  assert.deepEqual(parseQuery('not json'), { query: '' })
  assert.deepEqual(parseQuery(undefined), { query: '' })
  assert.deepEqual(parseQuery('["array"]'), { query: '' })
})

test('result text joins only the text blocks', () => {
  assert.equal(resultText({ content: [{ type: 'text', text: 'a' }, { type: 'image', data: 'x' }, { type: 'text', text: 'b' }] }), 'a\n\nb')
  assert.equal(resultText({ content: [] }), '')
  assert.equal(resultText(undefined), '')
})
