import { copyFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { CONTINUE_EXTENSION, writeContinueConfig } from './lib/continue.mjs'
import { installedCommand, Installer } from './lib/install.mjs'
import { TEMPLATES } from './lib/templates.mjs'
import { findCommand, VSCodeServer } from './lib/vscode.mjs'
import { validateProjectId, Workspace, WorkspaceError } from './lib/workspace.mjs'

export const PLUGIN_ID = 'plugin-studio'
/** LLMHub serves plugin proxies here, behind the dashboard login (plugin API 1.6). */
export const PROXY_PATH = `/api/hub/plugins/${PLUGIN_ID}/proxy/vscode`
const MAX_BODY_BYTES = 64 * 1024

async function readJson(event) {
  const chunks = []
  let size = 0
  for await (const chunk of event.node.req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new WorkspaceError('Request body is too large')
    chunks.push(chunk)
  }
  let body
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }
  catch { throw new WorkspaceError('Request body is not JSON') }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new WorkspaceError('Expected a JSON object')
  return body
}

/** The address the browser used for the dashboard, which the proxied editor shares. */
export function dashboardOrigin(event) {
  const headers = event.node.req.headers
  const first = value => String(Array.isArray(value) ? value[0] : value || '').split(',')[0].trim()
  const protocol = first(headers['x-forwarded-proto']) || (event.node.req.socket?.encrypted ? 'https' : 'http')
  const host = first(headers['x-forwarded-host']) || first(headers.host)
  return /^https?$/.test(protocol) && /^[a-zA-Z0-9.:[\]-]+$/.test(host) ? `${protocol}://${host}` : ''
}

/** This gateway, reached from inside its own process. */
export function hubOrigin(env = process.env) {
  const host = env.HOST && !['0.0.0.0', '::'].includes(env.HOST) ? env.HOST : '127.0.0.1'
  return `http://${host.includes(':') ? `[${host}]` : host}:${env.PORT || env.NITRO_PORT || 3000}`
}

export function gatewayUrl(config, env = process.env) {
  return String(config.gatewayUrl || '').trim().replace(/\/+$/, '') || `${hubOrigin(env)}/api/openai`
}

export function sessionCookie(event) {
  return /(?:^|;\s*)llmhub_session=([^;]+)/.exec(event.node.req.headers.cookie || '')?.[1] || ''
}

/**
 * Creates an ordinary LLMHub API key as the administrator who asked, through the gateway's own
 * management API. The session is used for this one request and never stored.
 */
export async function createApiKey(origin, session, name) {
  if (!session) throw new WorkspaceError('Sign in to the dashboard to create a key')
  const response = await fetch(`${origin}/api/hub/keys`, {
    method: 'POST', signal: AbortSignal.timeout(4000),
    headers: { 'content-type': 'application/json', cookie: `llmhub_session=${session}` },
    body: JSON.stringify({ name })
  })
  if (!response.ok) throw new WorkspaceError(`Could not create an API key (${response.status})`)
  const { key } = await response.json()
  if (!key?.plain_key) throw new WorkspaceError('The gateway returned no key')
  return { id: String(key.id), name: String(key.name), key: String(key.plain_key), createdAt: String(key.created_at || new Date().toISOString()) }
}

/** The models this API key may use, with the configured one first. */
export async function listModels(url, apiKey, preferred = '') {
  const response = await fetch(`${url}/models`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10000) })
  if (!response.ok) throw new Error(`Could not list models with the configured API key (${response.status})`)
  const ids = ((await response.json()).data || []).map(model => String(model.id)).sort()
  if (preferred) ids.splice(0, ids.length, preferred, ...ids.filter(id => id !== preferred))
  return ids
}

/**
 * LLMHub shows panels only a generic message for a failed route, so expected failures are
 * answered as `{ error }` and the panel displays them.
 */
export const answered = handler => async event => {
  try { return await handler(event) }
  catch (error) {
    if (error instanceof WorkspaceError) return { error: error.message }
    throw error
  }
}

export default {
  async setup(api) {
    const root = () => resolve(String(api.config.workspace || '').trim() || join(process.cwd(), '.data/plugins'))
    const workspace = () => new Workspace(root(), PLUGIN_ID)
    // Outside the plugin folder, so the gateway never scans it as a plugin.
    const continueDirectory = () => resolve(root(), '..', 'plugin-studio', 'continue')
    const vscode = new VSCodeServer(api.logger)
    /** A key set in settings wins over one created from the Studio page. */
    const created = async () => (await api.storage.getItem('api-key')) || null
    const currentKey = async () => String(api.config.apiKey || '') || (await created())?.key || ''
    const describeKey = async () => api.config.apiKey ? { source: 'settings' } : (key => key && { source: 'created', name: key.name, createdAt: key.createdAt })(await created())
    const configureContinue = async apiKey => {
      const url = gatewayUrl(api.config)
      const models = await listModels(url, apiKey, String(api.config.model || '').trim())
      await writeContinueConfig(continueDirectory(), { models, apiBase: url, apiKey })
      if (!models.length) return 'The API key has no models available.'
    }
    const toolsDirectory = () => resolve(root(), '..', 'plugin-studio', 'openvscode-server')
    const installer = new Installer(toolsDirectory())
    const editorData = () => resolve(root(), '..', 'plugin-studio', 'vscode')
    const followTheme = () => api.config.followTheme !== false
    const theme = value => followTheme() && ['light', 'dark'].includes(value) ? value : undefined
    /** Settings first, then a server Plugin Studio downloaded, then one on PATH. */
    const command = async () => {
      const configured = String(api.config.vscodeCommand || '').trim()
      if (!configured && await installer.installed()) return installedCommand(installer.directory)
      return findCommand(configured)
    }
    api.registerProxy('vscode', () => vscode.upstream())
    const withUrl = (status, event) => {
      if (!status.running) return status
      const origin = dashboardOrigin(event)
      return { ...status, url: origin ? `${origin}${status.path}` : status.path }
    }

    api.registerRoute('GET', 'overview', async () => ({
      workspace: root(),
      projects: await workspace().projects(),
      templates: Object.entries(TEMPLATES).map(([id, template]) => ({ id, label: template.label, description: template.description })),
      apiKey: (await describeKey()) || null
    }))

    api.registerRoute('POST', 'projects', answered(async event => {
      const { id, name, template = 'hook' } = await readJson(event)
      validateProjectId(id)
      if (!Object.hasOwn(TEMPLATES, template)) throw new WorkspaceError('Unknown template')
      await workspace().create(id, TEMPLATES[template].files(id, String(name || '').trim().slice(0, 100) || id))
      // Editor completion for `@typedef {import('./llmhub-plugin')}`, when the source tree is present.
      await copyFile(join(process.cwd(), 'examples/plugins/llmhub-plugin.d.ts'), join(root(), id, 'llmhub-plugin.d.ts')).catch(() => {})
      return { project: await workspace().describe(id) }
    }))

    api.registerRoute('GET', 'vscode', async event => ({
      ...withUrl(vscode.status(), event),
      command: await command(),
      install: installer.status()
    }))
    api.registerRoute('POST', 'vscode/install', answered(async () => {
      try { return { install: installer.start() } }
      catch (error) { throw new WorkspaceError(error.message) }
    }))
    api.registerRoute('POST', 'vscode/start', answered(async event => {
      const { project, theme: dashboardTheme } = await readJson(event)
      const server = await command()
      if (!server) throw new WorkspaceError('No VS Code server yet. Download OpenVSCode Server below, or install one and set its path in Plugin Studio settings.')
      const folder = project ? workspace().directory(project) : root()
      const current = vscode.status()
      if (current.running && current.folder !== folder) vscode.stop()
      const apiKey = await currentKey()
      const assistant = api.config.assistant !== false
      return vscode.start({
        command: server, folder,
        host: String(api.config.vscodeHost || '127.0.0.1'),
        port: Math.floor(Number(api.config.vscodePort) || 3100),
        basePath: PROXY_PATH,
        dataDirectory: editorData(),
        theme: theme(dashboardTheme),
        hideBuiltinChat: api.config.hideBuiltinChat !== false,
        extension: assistant ? CONTINUE_EXTENSION : undefined,
        env: assistant ? { CONTINUE_GLOBAL_DIR: continueDirectory() } : {},
        prepare: assistant ? async () => {
          if (!apiKey) return 'Create an API key on the Studio page, or set one in Plugin Studio settings, so Continue can use this gateway\'s models.'
          return configureContinue(apiKey)
        } : undefined
      })
    }))
    api.registerRoute('POST', 'vscode/stop', () => vscode.stop())
    api.registerRoute('POST', 'vscode/theme', answered(async event => {
      const value = theme((await readJson(event)).theme)
      return { applied: value ? await vscode.setTheme(value) : false }
    }))

    api.registerRoute('POST', 'api-key', answered(async event => {
      if (api.config.apiKey) throw new WorkspaceError('An API key is already set in Plugin Studio settings')
      const key = await createApiKey(hubOrigin(), sessionCookie(event), 'Plugin Studio (Continue)')
      await api.storage.setItem('api-key', key)
      // Continue reloads its configuration file, so a running editor picks up the key right away.
      let warning
      if (vscode.status().running && api.config.assistant !== false) warning = await configureContinue(key.key).catch(error => error.message)
      return { apiKey: await describeKey(), warning }
    }))

    return () => { vscode.stop() }
  }
}
