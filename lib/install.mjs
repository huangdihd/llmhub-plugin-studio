import { execFile } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { access, mkdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** The OpenVSCode Server release Plugin Studio downloads; tested with this plugin's proxy setup. */
export const OPENVSCODE_VERSION = '1.105.1'
const ARCHITECTURES = { x64: 'x64', arm64: 'arm64', arm: 'armhf' }

/** OpenVSCode Server publishes Linux builds only. */
export function openvscodeDownload(platform = process.platform, arch = process.arch) {
  if (platform !== 'linux' || !Object.hasOwn(ARCHITECTURES, arch)) return null
  const name = `openvscode-server-v${OPENVSCODE_VERSION}-linux-${ARCHITECTURES[arch]}`
  return `https://github.com/gitpod-io/openvscode-server/releases/download/openvscode-server-v${OPENVSCODE_VERSION}/${name}.tar.gz`
}

export function installedCommand(directory) {
  return join(directory, 'bin', 'openvscode-server')
}

const run = (command, args) => new Promise((resolve, reject) => {
  execFile(command, args, { timeout: 5 * 60 * 1000, maxBuffer: 1024 * 1024 }, (error, _stdout, stderr) =>
    error ? reject(new Error(String(stderr || error.message).trim().slice(-300))) : resolve())
})

/** Downloads and unpacks OpenVSCode Server into `directory` in the background; poll status(). */
export class Installer {
  constructor(directory, url = openvscodeDownload()) {
    this.directory = directory
    this.url = url
    this.phase = ''
    this.error = ''
    this.received = 0
    this.total = 0
  }

  async installed() {
    try { await access(installedCommand(this.directory), 1); return true } catch { return false }
  }

  status() {
    return { available: Boolean(this.url), version: OPENVSCODE_VERSION, phase: this.phase, error: this.error, received: this.received, total: this.total }
  }

  start() {
    if (!this.url) throw new Error('OpenVSCode Server has no download for this system. Install a VS Code server yourself and set its path in Plugin Studio settings.')
    if (!this.phase) {
      // Set before any await, so a second click sees the download already running.
      this.phase = 'downloading'
      this.error = ''
      this.install().catch(error => { this.error = `Could not install OpenVSCode Server: ${error.message}` }).finally(() => { this.phase = '' })
    }
    return this.status()
  }

  async install() {
    // Unpack beside the destination and swap it in, so a failed attempt never leaves half a server.
    const staging = `${this.directory}.download`
    const archive = `${staging}.tar.gz`
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true })
    try {
      this.phase = 'downloading'
      this.received = 0
      this.total = 0
      const response = await fetch(this.url, { signal: AbortSignal.timeout(30 * 60 * 1000) })
      if (!response.ok || !response.body) throw new Error(`download failed (${response.status})`)
      this.total = Number(response.headers.get('content-length')) || 0
      const counted = Readable.fromWeb(response.body)
      counted.on('data', chunk => { this.received += chunk.length })
      await pipeline(counted, createWriteStream(archive))
      this.phase = 'extracting'
      await run('tar', ['-xzf', archive, '-C', staging, '--strip-components=1'])
      await access(installedCommand(staging), 1)
      await rm(this.directory, { recursive: true, force: true })
      await mkdir(dirname(this.directory), { recursive: true })
      await rename(staging, this.directory)
    } finally {
      await rm(archive, { force: true })
      await rm(staging, { recursive: true, force: true })
    }
  }
}
