import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { createRuntime } from '../lib/runtime.js'
import { createAccountController, registerAccountApi } from '../lib/account.js'
import { memoryCredentials, mockConsensus } from './fixtures.js'

const PACKAGE = 'dsh-consensus'

test('account page renders and manages login/logout without searches; mobile/dark layout and unmount cleanup', async t => {
  const edge = process.env.CONSENSUS_TEST_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  if (!existsSync(edge)) { t.skip('Set CONSENSUS_TEST_BROWSER to a Chromium executable to run this UI test'); return }
  const upstream = await mockConsensus(t)
  const credentials = memoryCredentials()
  const runtime = createRuntime(credentials, { endpoint: upstream.endpoint, openBrowser: upstream.openBrowser })
  const account = createAccountController(runtime)
  t.after(async () => { await runtime.dispose(); await account.dispose() })
  let route
  let reads = 0
  registerAccountApi({ fetch: { register(r) { route = r } } }, account)
  const client = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const bootstrap = await build({
    stdin: {
      contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
        const root=createRoot(document.getElementById('root'));
        window.unmount=()=>root.unmount();
        window.__ModuleLoader__={load({id,factory}){
          if(id!==${JSON.stringify(PACKAGE)})throw Error('Wrong module identity');
          let Panel; const slots=[];
          const plugin=factory(id=>{if(id==='react')return React;throw Error('Unexpected dependency '+id)});
          plugin.apply({slots:{inject(name,fn){return fn()},register(info,component){slots.push(info);if(info.name==='plugins.bundle.config')Panel=component}}});
          window.slotKeys=slots.map(x=>x.name+':'+x.key);
          root.render(React.createElement(Panel,{view:'page'}));
        }};`,
      resolveDir: fileURLToPath(new URL('..', import.meta.url)),
      sourcefile: 'account-ui-fixture.js',
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    define: { 'process.env.NODE_ENV': '"production"' },
  })
  const server = createServer(async (req, res) => {
    if (req.url === '/bootstrap.js' || req.url === '/client.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' })
      res.end(req.url === '/client.js' ? client : bootstrap.outputFiles[0].text)
    } else if (req.url === '/api/consensus/account') {
      if (req.method === 'GET') reads++
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const response = await route.fetch(new Request(`http://127.0.0.1${req.url}`, {
        method: req.method,
        headers: req.headers,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      }))
      res.writeHead(response.status, Object.fromEntries(response.headers))
      res.end(await response.text())
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><html lang="zh"><meta charset="utf-8"><style>:root{color-scheme:light dark}body{margin:0;background:light-dark(#fafafa,#161616);color:light-dark(#1d1d1f,#f5f5f7);font:14px system-ui}main{max-width:800px;padding:28px;margin:auto}</style><main><div id="root"></div></main><script src="/bootstrap.js"></script><script src="/client.js"></script></html>')
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const browser = await chromium.launch({ executablePath: edge, headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 900, height: 850 }, colorScheme: 'light' })
  const errors = []
  page.on('pageerror', err => errors.push(err.message))
  const base = `http://127.0.0.1:${server.address().port}`
  await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort())
  await page.goto(base)
  await page.getByRole('button', { name: '登录 Consensus', exact: true }).waitFor()
  await page.waitForFunction(() => !document.querySelector('button.primary')?.disabled)
  assert.equal(upstream.stats.requests, 0, 'opening settings must not contact Consensus')
  assert.deepEqual(await page.evaluate(() => window.slotKeys), [
    `plugins.bundle.config:${PACKAGE}`,
    `plugins.row.config:${PACKAGE}#consensus-mcp`,
  ])
  await page.getByRole('button', { name: '登录 Consensus', exact: true }).click()
  await page.locator('.consensus-badge').filter({ hasText: /^已登录$/ }).waitFor()
  assert.equal(upstream.stats.searches.length, 0)
  assert.equal(upstream.stats.logins, 1)
  const rendered = await page.locator('body').innerText()
  assert.doesNotMatch(rendered, /账号资料|姓名|邮箱|套餐|连接状态|授权权限|授权时间|最近更新|有效期|授权续期|检查连接/)
  assert.doesNotMatch(rendered, /test-access-|test-refresh-|test-client|clientInformation/)
  assert.equal(await page.locator('dl').count(), 0)
  const beforeRefresh = upstream.stats.requests
  await page.getByRole('button', { name: '刷新状态', exact: true }).click()
  await page.locator('.consensus-badge').filter({ hasText: /^已登录$/ }).waitFor()
  assert.equal(upstream.stats.requests, beforeRefresh)
  await mkdir(new URL('../test-artifacts/', import.meta.url), { recursive: true })
  await page.screenshot({ path: fileURLToPath(new URL('../test-artifacts/account-desktop.png', import.meta.url)), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ colorScheme: 'dark' })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile layout must not overflow')
  await page.screenshot({ path: fileURLToPath(new URL('../test-artifacts/account-mobile.png', import.meta.url)), fullPage: true })
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await page.getByRole('button', { name: '返回', exact: true }).click()
  assert.equal(credentials.snapshot().kind, 'grant', 'dismissing confirmation must preserve the grant')
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await page.getByRole('button', { name: '确认退出', exact: true }).click()
  await page.getByRole('button', { name: '登录 Consensus', exact: true }).waitFor()
  assert.equal(credentials.snapshot(), undefined)
  await page.getByRole('button', { name: '登录 Consensus', exact: true }).click()
  await page.locator('.consensus-badge').filter({ hasText: /^已登录$/ }).waitFor()
  assert.equal(upstream.stats.logins, 2)
  assert.equal(upstream.stats.searches.length, 0)
  await page.evaluate(() => window.unmount())
  const afterUnmount = reads
  await page.waitForTimeout(2200)
  assert.equal(reads, afterUnmount, 'polling must stop on unmount')
  assert.deepEqual(errors, [])
})
