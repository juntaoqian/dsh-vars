#!/usr/bin/env node
/**
 * Validate that a DSH profile composes the dsh-vars plugin without skipped
 * bundles. Must be executed with DSH's Electron runtime as Node:
 *
 *   $env:ELECTRON_RUN_AS_NODE = '1'
 *   & "…\DeepSeek Harness.exe" scripts/validate-profile.mjs --profile desktop
 *
 * Usage: node scripts/validate-profile.mjs [--profile desktop] [--dsh-home <dir>]
 *        [--app-asar <path-to-app.asar/dsh>]
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

const PACKAGE = 'dsh-vars'

const args = process.argv.slice(2)
function arg(name, fallback) {
  const index = args.indexOf(name)
  return index === -1 ? fallback : args[index + 1]
}

const profile = arg('--profile', 'desktop')
const dshHome = arg('--dsh-home', process.env.DSH_HOME || join(homedir(), '.dsh'))
const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
const defaultAsar = join(localAppData, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar', 'dsh')
const installRoot = arg('--app-asar', process.env.DSH_APP_ASAR || defaultAsar).replace(/\\/g, '/').replace(/\/+$/, '')
const anchor = `${installRoot}/node_modules/@deepseek-ai/dsh/package.json`

const boot = await import(`file:///${installRoot}/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`)
const resolved = boot.loadProfileDirectory('dsh', `${dshHome.replace(/\\/g, '/')}/profiles/${profile}`, anchor)

console.log('app.asar:', installRoot)
console.log('layers:', resolved.layers.map((layer) => layer.packageName).join(', '))
console.log('skippedBundles:', JSON.stringify(resolved.skippedBundles))
const target = resolved.layers.find((layer) => layer.packageName === PACKAGE)
if (!target) {
  console.error(`${PACKAGE} is NOT part of the composed profile`)
  process.exitCode = 1
} else {
  console.log(`${PACKAGE} packageDir:`, target.packageDir)
  console.log('patchPaths:', JSON.stringify(target.patchPaths))
}
