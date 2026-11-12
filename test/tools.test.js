import test from 'node:test'
import assert from 'node:assert/strict'
import { createToolDefinition } from '../index.js'
import { createRuntime, textContent } from '../lib/runtime.js'
import { BUNDLED_TOOLS, publicToolName } from '../lib/tools.js'
import { memoryCredentials, mockConsensus } from './fixtures.js'

function setup(t, server, options = {}) {
  const runtime = createRuntime(memoryCredentials(), { endpoint: server.endpoint, openBrowser: server.openBrowser, operationTimeoutMs: 5000, ...options })
  t.after(() => runtime.dispose())
  return runtime
}

const brief = {
  input_message: 'Compare resistance and aerobic training, follow citations, and save selected papers to the existing Diabetes collection.',
  mode: 'deep',
  skill: 'literature-review',
  filters: { year_min: 2020, sjr_max: 2 },
  attachments: { paper_attachments: [{ paper_id: 'seed-paper' }], collection_ids: [123] },
}

test('tool wrappers preserve each research schema, arguments, cancellation and result', async () => {
  const examples = {
    search: { query: 'exercise', filters: { medical_mode: true, exclude_preprints: true, duration_min: 365 } },
    create_thread: brief,
    add_to_thread: { ...brief, thread_id: 'thread-1', title: 'Follow-up' },
    get_thread: { thread_id: 'thread-1', interaction_id: 'i-1', include_trace: true },
    find_threads: { query: 'exercise', limit: 30, offset: 10 },
  }
  const exec = { signal: new AbortController().signal }
  const value = { content: [{ type: 'text', text: 'Exact [1.1](https://example.org/paper)\n' }], structuredContent: { document: 'Exact document' } }
  for (const tool of BUNDLED_TOOLS) {
    let call
    const definition = createToolDefinition(tool, { callTool(name, args, execution) { call = { name, args, execution }; return value } })
    const args = structuredClone(examples[tool.name])
    const original = structuredClone(args)
    assert.equal(await definition.execute(args, exec), value)
    assert.equal(call.name, tool.name)
    assert.equal(call.execution, exec)
    if (tool.name === 'search') assert.deepEqual(call.args, { query: 'exercise', medical_mode: true, exclude_preprints: true, duration_min: 365 })
    else {
      assert.deepEqual(call.args, args)
      assert.deepEqual(definition.parameters, tool.inputSchema)
    }
    assert.deepEqual(args, original)
    assert.deepEqual(definition.output.render(args, value), [{ type: 'text', text: value.content[0].text }])
  }
})

test('research workflow creates, polls, delivers exact document, follows up and finds threads', async t => {
  const server = await mockConsensus(t)
  const runtime = setup(t, server)
  const create = await runtime.callTool('create_thread', brief)
  assert.deepEqual(server.stats.calls[0], { name: 'create_thread', args: brief })
  assert.equal(create.structuredContent.status, 'running')
  assert.equal(create.structuredContent.poll_after_seconds, 5)
  assert.equal(server.stats.calls.length, 1, 'dispatch returns control immediately and does not poll on its own')
  const { thread_id, interaction_id } = create.structuredContent
  const firstPoll = await runtime.callTool('get_thread', { thread_id, interaction_id })
  assert.equal(firstPoll.structuredContent.status, 'running')
  const final = await runtime.callTool('get_thread', { thread_id, interaction_id, include_trace: true })
  assert.equal(final.structuredContent.status, 'idle')
  assert.equal(final.structuredContent.document, '# Research report\n\nExact evidence [1.1](https://example.org/paper#quote).\n')
  assert.equal(JSON.parse(textContent(final)).document, final.structuredContent.document)
  const followup = { thread_id, input_message: 'Explain the clinical implications.', mode: 'pro', title: 'Implications', filters: { human: true } }
  assert.equal((await runtime.callTool('add_to_thread', followup)).structuredContent.status, 'running')
  assert.deepEqual(server.stats.calls.at(-1), { name: 'add_to_thread', args: followup })
  const found = await runtime.callTool('find_threads', { query: 'Compare', limit: 1, offset: 0 })
  assert.equal(found.structuredContent.threads[0].thread_id, thread_id)
  await runtime.search({ query: 'Single paper lookup', month_min: 3, year_min: 2020, medical_mode: true, exclude_preprints: true })
  assert.equal(server.stats.initializes, 1)
  assert.equal(server.stats.toolLists, 1)
  assert.equal(server.stats.logins, 1)
  assert.equal(server.stats.searches.length, 1)
})

test('find_threads supports an empty argument object and request-scoped SSE results', async t => {
  const server = await mockConsensus(t, { sse: true })
  const runtime = setup(t, server)
  const result = await runtime.callTool('find_threads')
  assert.deepEqual(server.stats.calls, [{ name: 'find_threads', args: {} }])
  assert.deepEqual(result.structuredContent, { threads: [] })
})

test('expired access refreshes during thread retrieval through the shared OAuth connection', async t => {
  const server = await mockConsensus(t)
  const runtime = setup(t, server)
  await runtime.callTool('find_threads', {})
  server.expire()
  await runtime.callTool('find_threads', { limit: 2 })
  assert.equal(server.stats.refreshes, 1)
  assert.equal(server.stats.logins, 1)
  assert.equal(server.stats.calls.length, 2)
})

test('a network failure on thread creation is not replayed', async t => {
  const server = await mockConsensus(t, { failTool: 'create_thread' })
  const runtime = setup(t, server)
  await assert.rejects(runtime.callTool('create_thread', brief), error => {
    assert.doesNotMatch(String(error), /DO-NOT-LEAK/)
    return true
  })
  assert.deepEqual(server.stats.calls.map(call => call.name), ['create_thread'])
})

test('server tools outside the bundled catalogue are discovered and callable', async t => {
  const extra = { name: 'paper_details', description: 'New server tool', inputSchema: { type: 'object', properties: { paper_id: { type: 'string' } }, required: ['paper_id'] } }
  const server = await mockConsensus(t, { tools: [...BUNDLED_TOOLS, extra] })
  let observed
  const runtime = setup(t, server, { onTools(tools) { observed = tools } })
  const result = await runtime.callTool('paper_details', { paper_id: 'p-1' })
  assert.deepEqual(observed.map(tool => tool.name), [...BUNDLED_TOOLS, extra].map(tool => tool.name))
  assert.deepEqual(result.structuredContent, { name: 'paper_details', args: { paper_id: 'p-1' } })
})

test('duplicate remote names are rejected as an invalid tool catalogue', async t => {
  const server = await mockConsensus(t, { tools: [BUNDLED_TOOLS[0], BUNDLED_TOOLS[0]] })
  const runtime = setup(t, server)
  await assert.rejects(runtime.search({ query: 'q' }), /duplicate tool: search/)
  assert.equal(server.stats.calls.length, 0)
})

test('all other tools remain callable when search is absent from the live catalogue', async t => {
  const server = await mockConsensus(t, { noSearch: true })
  const runtime = setup(t, server)
  const result = await runtime.callTool('find_threads', {})
  assert.deepEqual(result.structuredContent, { threads: [] })
})

test('public names remain stable and distinct for normalized or long server tool names', () => {
  assert.equal(publicToolName('create_thread'), 'mcp__consensus__create_thread')
  assert.notEqual(publicToolName('paper.details'), publicToolName('paper/details'))
  assert.match(publicToolName('x'.repeat(100)), /^[A-Za-z0-9_-]{64}$/)
})
