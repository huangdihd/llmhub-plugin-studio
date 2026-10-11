import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** VS Code's own themes, matching the dashboard's light and dark modes. */
export const THEMES = { light: 'Default Light Modern', dark: 'Default Dark Modern' }

const HELPER = 'llmhub.plugin-studio-helper-1.1.0'
const OLD_HELPERS = ['llmhub.plugin-studio-helper-1.0.0']
const HELPER_MANIFEST = {
  name: 'plugin-studio-helper',
  publisher: 'llmhub',
  version: '1.1.0',
  displayName: 'LLMHub Plugin Studio',
  description: 'Puts Continue where VS Code\'s built-in Copilot chat, which has no provider here, would be.',
  engines: { vscode: '^1.80.0' },
  main: './extension.js',
  activationEvents: ['onStartupFinished'],
  capabilities: { untrustedWorkspaces: { supported: true }, virtualWorkspaces: true }
}
// OpenVSCode Server shows the built-in chat in the secondary side bar whatever its settings say,
// because it only hides it once a Copilot provider is configured. The helper moves that view to
// the bottom panel, out of sight, and Continue into the side bar in its place. Moves are kept per
// browser; repeating them on every start is harmless. Without Continue it just closes the bar.
export const HELPER_SOURCE = `const vscode = require('vscode')
const CHAT_CONTAINER = 'workbench.panel.chat'
const CHAT_VIEW = 'workbench.panel.chat.view.copilot'
const CONTINUE_VIEW = 'continue.continueGUIView'
const run = (command, argument) => Promise.resolve(vscode.commands.executeCommand(command, argument)).catch(() => {})
exports.activate = async () => {
  if (!vscode.extensions.getExtension('Continue.continue')) return run('workbench.action.closeAuxiliaryBar')
  await run('vscode.moveViews', { viewIds: [CHAT_VIEW], destinationId: 'workbench.panel.output' })
  await run('workbench.action.closePanel')
  await run('vscode.moveViews', { viewIds: [CONTINUE_VIEW], destinationId: CHAT_CONTAINER })
  await run(CONTINUE_VIEW + '.focus')
}
`

/** Installs or removes the helper extension, unpacked, in the server's extensions folder. */
export async function setupHelper(extensionsDirectory, enabled) {
  const directory = join(extensionsDirectory, HELPER)
  for (const old of OLD_HELPERS) await rm(join(extensionsDirectory, old), { recursive: true, force: true })
  if (!enabled) return rm(directory, { recursive: true, force: true })
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'package.json'), JSON.stringify(HELPER_MANIFEST, null, 2))
  await writeFile(join(directory, 'extension.js'), HELPER_SOURCE)
}

/**
 * Sets the color theme in the server-side settings file. VS Code watches that file, so a running
 * editor switches immediately. Other settings in it are kept; a file that is not plain JSON
 * (for example one with comments) is left alone.
 */
export async function writeTheme(settingsFile, theme) {
  if (!Object.hasOwn(THEMES, theme)) return false
  let settings = {}
  try { settings = JSON.parse(await readFile(settingsFile, 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') return false }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return false
  if (settings['workbench.colorTheme'] === THEMES[theme]) return true
  await mkdir(dirname(settingsFile), { recursive: true })
  await writeFile(settingsFile, JSON.stringify({ ...settings, 'workbench.colorTheme': THEMES[theme] }, null, 2))
  return true
}
