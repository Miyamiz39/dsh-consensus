import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// The Web Client artifact is a plain script handed to the page's module loader, so the
// test loads it the same way the page does and inspects the plugin object it exports.
async function loadClientModule() {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  let definition
  const window = { __ModuleLoader__: { load(value) { definition = value } } }
  new Function('window', source)(window)
  const react = { createElement() {}, useState() {}, useEffect() {}, useMemo() {}, useRef() {} }
  return { definition, module: definition.factory(name => {
    if (name !== 'react') throw new Error(`unexpected Client module: ${name}`)
    return react
  }) }
}

test('the client artifact loads as the package module', async () => {
  const { definition, module } = await loadClientModule()
  assert.equal(definition.id, 'dsh-consensus')
  assert.equal(typeof module.apply, 'function')
  assert.deepEqual(module.inject, ['slots'])
})

test('the slot registrations name the real wire tool and both seats', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  for (const needle of [
    "key: SEARCH_TOOL",
    "const SEARCH_TOOL = 'mcp__consensus__search'",
    "name: 'conversation.chat.turnTail'",
    "id: PACKAGE",
    "plugins.bundle.config",
    'plugins.row.config',
  ]) {
    assert.ok(source.includes(needle), `client.js must contain ${needle}`)
  }
})
