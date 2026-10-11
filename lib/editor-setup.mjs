import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** VS Code's own themes, matching the dashboard's light and dark modes. */
export const THEMES = { light: 'Default Light Modern', dark: 'Default Dark Modern' }

const HELPER = 'llmhub.plugin-studio-helper-1.0.0'
const HELPER_MANIFEST = {
  name: 'plugin-studio-helper',
  publisher: 'llmhub',
  version: '1.0.0',
  displayName: 'LLMHub Plugin Studio',
  description: 'Closes VS Code\'s built-in Copilot chat, which has no provider here; Continue is the assistant.',
  engines: { vscode: '^1.80.0' },
  main: './extension.js',
  activationEvents: ['onStartupFinished'],
  capabilities: { untrustedWorkspaces: { supported: true }, virtualWorkspaces: true }
}
// OpenVSCode Server shows the built-in chat in the secondary side bar whatever its settings say,
// because it only hides it once a Copilot provider is configured.
const HELPER_SOURCE = `const vscode = require('vscode')
exports.activate = () => vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar')
`

/** Installs or removes the helper extension, unpacked, in the server's extensions folder. */
export async function setupHelper(extensionsDirectory, enabled) {
  const directory = join(extensionsDirectory, HELPER)
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
