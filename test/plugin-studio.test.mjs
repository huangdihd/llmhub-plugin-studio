import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { parse } from 'yaml'
import plugin, { answered, createApiKey, dashboardOrigin, gatewayUrl, hubOrigin, listModels, PROXY_PATH } from '../index.mjs'
import { continueConfig, GUIDE } from '../lib/continue.mjs'
import { TEMPLATES } from '../lib/templates.mjs'
import { findCommand, flavorOf, VSCodeServer } from '../lib/vscode.mjs'
import { Workspace, WorkspaceError } from '../lib/workspace.mjs'
import { Installer, installedCommand, openvscodeDownload } from '../lib/install.mjs'

const temporary = async t => {
  const directory = await mkdtemp(join(tmpdir(), 'plugin-studio-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}
const event = (body, headers = { host: 'hub.example:3000', cookie: 'llmhub_session=admin' }) => {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.headers = headers
  return { node: { req } }
}
const wait = async (condition, message) => {
  for (let i = 0; i < 200 && !(await condition()); i++) await new Promise(resolve => setTimeout(resolve, 25))
  assert.ok(await condition(), message)
}

async function fakeGateway(t) {
  const requests = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    requests.push({ url: request.url, authorization: request.headers.authorization, cookie: request.headers.cookie, body: Buffer.concat(chunks).toString() })
    response.setHeader('content-type', 'application/json')
    if (request.url === '/api/hub/keys') {
      if (request.headers.cookie !== 'llmhub_session=admin') { response.statusCode = 401; return response.end('{}') }
      const { name } = JSON.parse(Buffer.concat(chunks).toString())
      return response.end(JSON.stringify({ key: { id: 'k1', name, created_at: '2026-10-11T00:00:00.000Z', plain_key: 'sk-created' } }))
    }
    response.end(JSON.stringify({ data: [{ id: 'b/model' }, { id: 'a/model' }] }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const origin = `http://127.0.0.1:${server.address().port}`
  return { origin, port: String(server.address().port), url: `${origin}/api/openai`, requests }
}

/** Behaves like the real launchers: handles extension commands, else starts the actual server as a child. */
async function fakeLauncher(directory, name = 'openvscode-server') {
  const file = join(directory, name)
  await writeFile(file, `#!${process.execPath}
const { appendFileSync, writeFileSync, existsSync } = require('fs')
const at = name => ${JSON.stringify(directory)} + '/' + name
const args = process.argv.slice(2)
appendFileSync(at('calls.log'), JSON.stringify(args) + '\\n')
if (args.includes('--list-extensions')) { console.log(existsSync(at('installed')) ? 'continue.continue' : 'other.extension'); process.exit(0) }
if (args.includes('--install-extension')) { writeFileSync(at('installed'), ''); process.exit(0) }
writeFileSync(at('env.json'), JSON.stringify({ CONTINUE_GLOBAL_DIR: process.env.CONTINUE_GLOBAL_DIR }))
const server = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
writeFileSync(at('server.pid'), String(server.pid))
setInterval(() => {}, 1000)
`)
  await chmod(file, 0o755)
  return file
}
// An orphan stays a zombie where PID 1 does not reap (some containers); that is stopped too.
const alive = pid => {
  try { if (readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.startsWith('Z')) return false } catch {}
  try { process.kill(pid, 0); return true } catch { return false }
}

test('plugins are created from templates that pass a syntax check', async t => {
  const root = await temporary(t)
  const workspace = new Workspace(root, 'plugin-studio')
  for (const [id, template] of Object.entries(TEMPLATES)) {
    await workspace.create(`t-${id}`, template.files(`t-${id}`, id))
    const manifest = JSON.parse(await readFile(join(root, `t-${id}/package.json`), 'utf8'))
    assert.equal(manifest.llmhub.id, `t-${id}`, 'the ID matches the folder, as the plugin manager requires')
    execFileSync(process.execPath, ['--check', join(root, `t-${id}/index.mjs`)])
  }
  await mkdir(join(root, 'node_modules'))
  await mkdir(join(root, 'plugin-studio'))
  await writeFile(join(root, 'plugin-studio/package.json'), JSON.stringify({ llmhub: {} }))
  assert.deepEqual((await workspace.projects()).map(project => project.id), ['t-empty', 't-hook', 't-panel'], 'never the studio itself')
  await assert.rejects(workspace.create('t-hook', {}), /already exists/)
  await assert.rejects(workspace.create('../x', {}), /plugin ID/)
  assert.throws(() => workspace.directory('plugin-studio'), /cannot edit itself/)
})

test('Continue is configured with every model of the API key and the authoring guide', async t => {
  const config = parse(continueConfig({ models: ['a/model', 'b "odd"\nmodel'], apiBase: 'http://127.0.0.1:3000/api/openai', apiKey: 'sk-1' }))
  assert.equal(config.schema, 'v1')
  assert.deepEqual(config.models.map(model => model.model), ['a/model', 'b "odd"\nmodel'])
  assert.deepEqual(config.models[0], { name: 'a/model', provider: 'openai', model: 'a/model', apiBase: 'http://127.0.0.1:3000/api/openai', apiKey: 'sk-1', roles: ['chat', 'edit', 'apply'], capabilities: ['tool_use'] })
  assert.deepEqual(config.rules, [GUIDE])
  assert.deepEqual(parse(continueConfig({ models: [], apiBase: 'x', apiKey: 'y' })).models, [])

  const gateway = await fakeGateway(t)
  assert.deepEqual(await listModels(gateway.url, 'sk-1', 'b/model'), ['b/model', 'a/model'])
  // Every model the key can use reaches Continue; nothing is cut off.
  const many = Array.from({ length: 120 }, (_, index) => ({ id: `p/model-${String(index).padStart(3, '0')}` }))
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ data: many })))
  assert.equal((await listModels('http://gateway/api/openai', 'sk-1')).length, 120)
  t.mock.restoreAll()
  assert.equal(gateway.requests[0].authorization, 'Bearer sk-1')
  assert.equal(gatewayUrl({}, { PORT: '8080' }), 'http://127.0.0.1:8080/api/openai')
  assert.equal(gatewayUrl({ gatewayUrl: 'http://gw/api/openai/' }), 'http://gw/api/openai')
  assert.equal(hubOrigin({ HOST: '0.0.0.0', PORT: '3000' }), 'http://127.0.0.1:3000')
  assert.equal(hubOrigin({ HOST: '10.0.0.2', PORT: '3000' }), 'http://10.0.0.2:3000', 'a gateway bound to one address is reached there')
})

test('an API key is created as the signed-in administrator, without keeping the session', async t => {
  const gateway = await fakeGateway(t)
  assert.deepEqual(await createApiKey(gateway.origin, 'admin', 'Plugin Studio (Continue)'), { id: 'k1', name: 'Plugin Studio (Continue)', key: 'sk-created', createdAt: '2026-10-11T00:00:00.000Z' })
  await assert.rejects(createApiKey(gateway.origin, 'expired', 'x'), /\(401\)/)
  await assert.rejects(createApiKey(gateway.origin, '', 'x'), /Sign in/)
})

test('a VS Code server is found, gets Continue, starts on the plugin folder and stops completely', async t => {
  const bin = await temporary(t)
  const folder = await temporary(t)
  const launcher = await fakeLauncher(bin)
  assert.equal(flavorOf('/opt/openvscode-server-v1.90/bin/openvscode-server'), 'openvscode-server')
  assert.equal(flavorOf('code-server'), 'code-server')
  assert.equal(flavorOf('code'), 'code')
  assert.equal(await findCommand('', { PATH: bin }), launcher)
  assert.equal(await findCommand('', { PATH: folder }), null)
  assert.equal(await findCommand('relative/path', { PATH: bin }), null)

  const server = new VSCodeServer({ warn() {} })
  t.after(() => server.stop())
  let prepared = 0
  const options = { command: launcher, host: '127.0.0.1', port: 3999, folder, basePath: '/base', extension: 'Continue.continue', env: { CONTINUE_GLOBAL_DIR: '/tmp/continue' }, prepare: async () => { prepared++; return 'note' } }
  assert.equal(server.start(options).running, false)
  await wait(() => server.status().running, 'the server starts in the background')
  const status = server.status()
  assert.equal(status.warning, 'note')
  assert.equal(prepared, 1)

  const calls = (await readFile(join(bin, 'calls.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(calls.slice(0, 2), [['--list-extensions'], ['--install-extension', 'Continue.continue']])
  const args = calls[2]
  const token = args[args.indexOf('--connection-token') + 1]
  assert.match(token, /^[0-9a-f]{48}$/)
  assert.deepEqual(args.slice(0, 4), ['--host', '127.0.0.1', '--port', '3999'])
  assert.equal(args[args.indexOf('--default-folder') + 1], folder)
  assert.equal(args[args.indexOf('--server-base-path') + 1], '/base')
  assert.equal(status.path, `/base/?tkn=${token}&folder=${encodeURIComponent(folder)}`)
  assert.equal(server.upstream(), 'http://127.0.0.1:3999/base', 'OpenVSCode Server expects the prefix')
  assert.deepEqual(JSON.parse(await readFile(join(bin, 'env.json'), 'utf8')), { CONTINUE_GLOBAL_DIR: '/tmp/continue' })

  const serverPid = Number(await readFile(join(bin, 'server.pid'), 'utf8'))
  assert.equal(server.stop().running, false)
  assert.equal(server.upstream(), null)
  await wait(() => !alive(serverPid), 'the server the launcher started is stopped too')

  // Installed already: no second installation.
  server.start(options)
  await wait(() => server.status().running, 'restarts')
  server.stop()
  const again = (await readFile(join(bin, 'calls.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)[0])
  assert.equal(again.filter(arg => arg === '--install-extension').length, 1)

  const crashing = join(bin, 'code-server')
  await writeFile(crashing, `#!${process.execPath}\nif (process.argv[2] === '--list-extensions') process.exit(0)\nconsole.error('port in use'); process.exit(3)\n`)
  await chmod(crashing, 0o755)
  const failing = new VSCodeServer({ warn() {} })
  failing.start({ command: crashing, host: '127.0.0.1', port: 1, folder })
  await wait(() => failing.status().error, 'reports a server that exits')
  assert.match(failing.status().error, /exited with code 3[\s\S]*port in use/)
})

test('routes list and create plugins and start VS Code with Continue pointed at the gateway', async t => {
  const root = await temporary(t)
  const bin = await temporary(t)
  const gateway = await fakeGateway(t)
  const launcher = await fakeLauncher(bin)
  const routes = new Map()
  const proxies = new Map()
  const stored = new Map()
  const api = {
    storage: { getItem: async key => stored.get(key) ?? null, setItem: async (key, value) => { stored.set(key, value) }, removeItem: async key => { stored.delete(key) } },
    registerProxy: (id, target) => proxies.set(id, target),
    config: { workspace: join(root, 'plugins'), apiKey: 'sk-1', model: 'b/model', gatewayUrl: gateway.url, vscodeCommand: launcher, vscodePort: 3998 },
    registerRoute: (method, path, handler) => routes.set(`${method} ${path}`, handler),
    logger: { info() {}, warn() {}, error() {} }
  }
  const call = (route, body) => routes.get(route)(event(body))
  const cleanup = await plugin.setup(api)

  await call('POST projects', { id: 'demo', name: 'Demo', template: 'panel' })
  assert.match((await call('POST projects', { id: 'other', template: 'nope' })).error, /Unknown template/)
  const overview = await call('GET overview')
  assert.deepEqual(overview.projects.map(project => project.name), ['Demo'])
  assert.deepEqual(overview.apiKey, { source: 'settings' })
  assert.match((await call('POST api-key', {})).error, /already set in Plugin Studio settings/)

  await call('POST vscode/start', { project: 'demo', theme: 'dark' })
  await wait(async () => (await call('GET vscode')).running, 'VS Code starts')
  const running = await call('GET vscode')
  // Its own data folder, the dashboard's theme, and the helper that closes the built-in chat.
  const editorData = join(root, 'plugin-studio/vscode')
  const launched = (await readFile(join(bin, 'calls.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.ok(launched.every(args => args[args.indexOf('--server-data-dir') + 1] === editorData), 'extension commands and the server share one data folder')
  const machineSettings = join(editorData, 'data/Machine/settings.json')
  assert.equal(JSON.parse(await readFile(machineSettings, 'utf8'))['workbench.colorTheme'], 'Default Dark Modern')
  assert.match(await readFile(join(editorData, 'extensions/llmhub.plugin-studio-helper-1.1.0/extension.js'), 'utf8'), /continue\.continueGUIView/)
  assert.deepEqual(await call('POST vscode/theme', { theme: 'light' }), { applied: true })
  assert.equal(JSON.parse(await readFile(machineSettings, 'utf8'))['workbench.colorTheme'], 'Default Light Modern', 'a running editor follows the toggle')
  assert.deepEqual(await call('POST vscode/theme', { theme: 'purple' }), { applied: false })
  assert.equal(running.folder, join(root, 'plugins/demo'))
  assert.match(running.url, new RegExp(`^http://hub\\.example:3000${PROXY_PATH}/\\?tkn=`), 'served by LLMHub at the dashboard address')
  assert.equal(proxies.get('vscode')(), `http://127.0.0.1:3998${PROXY_PATH}`)
  const directory = JSON.parse(await readFile(join(bin, 'env.json'), 'utf8')).CONTINUE_GLOBAL_DIR
  assert.equal(directory, join(root, 'plugin-studio/continue'), 'outside the scanned plugin folder')
  const config = parse(await readFile(join(directory, 'config.yaml'), 'utf8'))
  assert.deepEqual(config.models.map(model => model.model), ['b/model', 'a/model'])
  assert.equal(config.models[0].apiBase, gateway.url)
  assert.match((await call('POST vscode/start', { project: '../x' })).error, /plugin ID/)
  await cleanup()
  assert.equal((await call('GET vscode')).running, false)
  assert.equal(proxies.get('vscode')(), null)
})

test('a key created from the Studio page is used when settings have none', async t => {
  const root = await temporary(t)
  const bin = await temporary(t)
  const gateway = await fakeGateway(t)
  const launcher = await fakeLauncher(bin)
  const routes = new Map()
  const stored = new Map()
  const previousPort = process.env.PORT
  process.env.PORT = gateway.port
  t.after(() => { if (previousPort === undefined) delete process.env.PORT; else process.env.PORT = previousPort })
  const api = {
    config: { workspace: join(root, 'plugins'), vscodeCommand: launcher, vscodePort: 3997 },
    registerRoute: (method, path, handler) => routes.set(`${method} ${path}`, handler),
    registerProxy() {},
    storage: { getItem: async key => stored.get(key) ?? null, setItem: async (key, value) => { stored.set(key, value) }, removeItem: async key => { stored.delete(key) } },
    logger: { info() {}, warn() {}, error() {} }
  }
  const call = (route, body, headers) => routes.get(route)(event(body, headers))
  const cleanup = await plugin.setup(api)
  t.after(cleanup)

  assert.equal((await call('GET overview')).apiKey, null)
  assert.match((await call('POST api-key', {}, { host: 'hub' })).error, /Sign in/)
  const { apiKey } = await call('POST api-key', {})
  assert.deepEqual(apiKey, { source: 'created', name: 'Plugin Studio (Continue)', createdAt: '2026-10-11T00:00:00.000Z' })
  assert.equal(stored.get('api-key').key, 'sk-created')
  assert.equal(gateway.requests.find(request => request.url === '/api/hub/keys').cookie, 'llmhub_session=admin')

  await call('POST projects', { id: 'demo', template: 'empty' })
  await call('POST vscode/start', { project: 'demo' })
  await wait(async () => (await call('GET vscode')).running, 'VS Code starts')
  const config = parse(await readFile(join(root, 'plugin-studio/continue/config.yaml'), 'utf8'))
  assert.equal(config.models[0].apiKey, 'sk-created')
  assert.equal(gateway.requests.at(-1).authorization, 'Bearer sk-created')
})

test('the editor link uses the address the browser used for the dashboard', () => {
  const at = (headers, encrypted = false) => ({ node: { req: { headers, socket: { encrypted } } } })
  assert.equal(dashboardOrigin(at({ host: 'hub:3000' })), 'http://hub:3000')
  assert.equal(dashboardOrigin(at({ host: 'hub' }, true)), 'https://hub')
  assert.equal(dashboardOrigin(at({ host: 'internal', 'x-forwarded-host': 'hub.example.com', 'x-forwarded-proto': 'https' })), 'https://hub.example.com')
  assert.equal(dashboardOrigin(at({ host: 'evil.example/"><script>' })), '')
})

test('OpenVSCode Server is downloaded and unpacked in the background, with progress', async t => {
  assert.match(openvscodeDownload('linux', 'x64'), /openvscode-server-v[\d.]+-linux-x64\.tar\.gz$/)
  assert.match(openvscodeDownload('linux', 'arm64'), /linux-arm64/)
  assert.equal(openvscodeDownload('darwin', 'arm64'), null, 'upstream publishes Linux builds only')

  // A release-shaped archive: one top folder holding bin/openvscode-server.
  const source = await temporary(t)
  await mkdir(join(source, 'openvscode-server-v0-linux-x64/bin'), { recursive: true })
  await writeFile(join(source, 'openvscode-server-v0-linux-x64/bin/openvscode-server'), '#!/bin/sh\n')
  await chmod(join(source, 'openvscode-server-v0-linux-x64/bin/openvscode-server'), 0o755)
  execFileSync('tar', ['-czf', join(source, 'release.tar.gz'), '-C', source, 'openvscode-server-v0-linux-x64'])
  const archive = await readFile(join(source, 'release.tar.gz'))
  const server = createServer((request, response) => {
    if (request.url !== '/release.tar.gz') { response.statusCode = 404; return response.end() }
    response.setHeader('content-length', archive.length)
    response.end(archive)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`

  const target = join(await temporary(t), 'tools', 'openvscode-server')
  const installer = new Installer(target, `${base}/release.tar.gz`)
  assert.equal(await installer.installed(), false)
  installer.start()
  await wait(() => !installer.status().phase, 'finishes')
  assert.equal(installer.status().error, '')
  assert.equal(installer.status().received, archive.length)
  assert.equal(await installer.installed(), true)
  assert.equal(installedCommand(target), join(target, 'bin/openvscode-server'))

  const failing = new Installer(join(await temporary(t), 'server'), `${base}/missing.tar.gz`)
  failing.start()
  await wait(() => !failing.status().phase, 'fails')
  assert.match(failing.status().error, /download failed \(404\)/)
  assert.equal(await failing.installed(), false, 'nothing half-installed is left behind')
  assert.throws(() => new Installer('/x', null).start(), /no download for this system/)
})

test('expected failures reach the panel as messages', async () => {
  assert.deepEqual(await answered(async () => { throw new WorkspaceError('No VS Code server yet') })({}), { error: 'No VS Code server yet' })
  await assert.rejects(answered(async () => { throw new TypeError('bug') })({}), /bug/, 'unexpected failures still fail')
  assert.deepEqual(await answered(async () => ({ ok: true }))({}), { ok: true })
})

test('the theme is written into existing settings without losing them, and never into commented files', async t => {
  const { writeTheme, setupHelper } = await import('../lib/editor-setup.mjs')
  const directory = await temporary(t)
  const file = join(directory, 'Machine/settings.json')
  assert.equal(await writeTheme(file, 'dark'), true)
  await writeFile(file, JSON.stringify({ 'editor.fontSize': 15, 'workbench.colorTheme': 'Default Dark Modern' }))
  assert.equal(await writeTheme(file, 'light'), true)
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { 'editor.fontSize': 15, 'workbench.colorTheme': 'Default Light Modern' })
  await writeFile(file, '// mine\n{}')
  assert.equal(await writeTheme(file, 'dark'), false)
  assert.equal(await readFile(file, 'utf8'), '// mine\n{}')
  assert.equal(await writeTheme(file, 'sepia'), false)

  await setupHelper(join(directory, 'extensions'), true)
  const manifest = JSON.parse(await readFile(join(directory, 'extensions/llmhub.plugin-studio-helper-1.1.0/package.json'), 'utf8'))
  assert.equal(manifest.capabilities.untrustedWorkspaces.supported, true, 'works before the folder is trusted')
  await setupHelper(join(directory, 'extensions'), false)
  await assert.rejects(readFile(join(directory, 'extensions/llmhub.plugin-studio-helper-1.1.0/package.json')))
})
