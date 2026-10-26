/**
 * dsh-vars — DSH host half.
 *
 * Mounts the loopback-only variable API plus the WebSocket change feed on the
 * DSH web server, and owns the on-disk store:
 *
 *   ~/.dsh/plugins/dsh-vars/variables.json   (mode 0600, atomic writes)
 *
 * Optional Bearer token (protects every data endpoint):
 *   - DSH_VARS_TOKEN environment variable (wins), or
 *   - {"token": "..."} in ~/.dsh/plugins/dsh-vars/config.json, or
 *   - `token` in the plugin config row.
 *
 * @module lib/index
 */

import { readFileSync } from 'node:fs'
import { hostname, networkInterfaces } from 'node:os'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { API_PREFIX, createVariablesApi } from './api.js'
import { createVariableStore } from './store.js'
import { EVENTS_PATH, createEventsUpgrade } from './ws.js'

/** Stable cordis plugin name. */
export const name = 'dsh-vars'

/** Host services required before this plugin mounts. */
export const inject = ['webServer']

/**
 * Resolve the default state directory (`$DSH_HOME/plugins/dsh-vars`).
 * @returns {string} absolute directory.
 */
function defaultStateDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'plugins', name)
}

/**
 * Resolve the optional Bearer token.
 * @param {any} config plugin config row.
 * @param {string} stateDir state directory.
 * @returns {string} token, or '' when auth is disabled.
 */
function resolveToken(config, stateDir) {
  const fromConfig = config && typeof config.token === 'string' ? config.token.trim() : ''
  if (fromConfig !== '') return fromConfig
  const fromEnv = typeof process.env.DSH_VARS_TOKEN === 'string' ? process.env.DSH_VARS_TOKEN.trim() : ''
  if (fromEnv !== '') return fromEnv
  try {
    const parsed = JSON.parse(readFileSync(join(stateDir, 'config.json'), 'utf8'))
    return parsed && typeof parsed.token === 'string' ? parsed.token.trim() : ''
  } catch {
    return ''
  }
}

/**
 * Describe the local addresses the DSH web server is reachable on.
 * @param {any} ctx host context.
 * @returns {{port?: number, hostname: string, loopback: string|undefined, addresses: Array<{nic: string, address: string}>}} info.
 */
function localInfo(ctx) {
  /** @type {Array<{nic: string, address: string}>} */
  const addresses = []
  try {
    for (const [nic, list] of Object.entries(networkInterfaces())) {
      for (const entry of list ?? []) {
        if (entry.family === 'IPv4' && entry.internal !== true) addresses.push({ nic, address: entry.address })
      }
    }
  } catch {
    // interface enumeration is best-effort
  }
  const port = typeof ctx?.webServer?.port === 'number' ? ctx.webServer.port : undefined
  return {
    port,
    hostname: hostname(),
    loopback: port === undefined ? undefined : `http://127.0.0.1:${port}`,
    addresses,
  }
}

/**
 * Mount the plugin.
 *
 * @param {any} ctx cordis host context.
 * @param {{stateDir?: string, file?: string, token?: string}} [config] optional plugin config.
 * @returns {void}
 */
export function apply(ctx, config) {
  const stateDir = config && typeof config.stateDir === 'string' && config.stateDir !== '' ? config.stateDir : defaultStateDir()
  const file = config && typeof config.file === 'string' && config.file !== '' ? config.file : join(stateDir, 'variables.json')
  const token = resolveToken(config, stateDir)

  const logger = {
    info(message) {
      try {
        ctx?.logger?.info?.(message)
      } catch {
        // ignore logging failures
      }
    },
    warn(message) {
      try {
        ctx?.logger?.warn?.(message)
      } catch {
        // ignore logging failures
      }
    },
  }

  const store = createVariableStore({ file, logger })
  const handler = createVariablesApi({
    store,
    token,
    logger,
    getInfo: () => localInfo(ctx),
  })

  // Warm the store in the background so the first API/UI call is immediate.
  void store.init().catch((error) => logger.warn(`dsh-vars: 变量文件加载失败：${error instanceof Error ? error.message : String(error)}`))

  function mountHttp() {
    const webServer = ctx?.webServer
    if (webServer === undefined || typeof webServer.register !== 'function') {
      logger.warn('dsh-vars: ctx.webServer.register 不可用，变量接口未挂载（请升级 DSH）')
      return () => {}
    }
    let remove
    try {
      remove = webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: (request, response) => {
          void handler(request, response)
        },
      })
    } catch (error) {
      logger.warn(`dsh-vars: 变量接口挂载失败：${error instanceof Error ? error.message : String(error)}`)
      return () => {}
    }
    logger.info(`dsh-vars: 变量接口已挂载 ${API_PREFIX}（仅本机可用，token=${token === '' ? 'off' : 'on'}），数据文件 ${file}`)
    return () => {
      if (typeof remove === 'function') {
        remove()
      } else if (remove && typeof remove.dispose === 'function') {
        remove.dispose()
      }
    }
  }

  function mountUpgrade() {
    const webServer = ctx?.webServer
    if (webServer === undefined || typeof webServer.registerUpgrade !== 'function') {
      logger.warn('dsh-vars: ctx.webServer.registerUpgrade 不可用，变量变化订阅未挂载（请升级 DSH）')
      return () => {}
    }
    const events = createEventsUpgrade({ store, token, logger })
    let remove
    try {
      remove = webServer.registerUpgrade({ path: EVENTS_PATH, handler: events.handler })
    } catch (error) {
      logger.warn(`dsh-vars: 变量变化订阅挂载失败：${error instanceof Error ? error.message : String(error)}`)
      return () => {}
    }
    logger.info(`dsh-vars: 变量变化订阅已挂载 ${EVENTS_PATH}`)
    return () => {
      try {
        if (typeof remove === 'function') remove()
        else if (remove && typeof remove.dispose === 'function') remove.dispose()
      } finally {
        events.closeAll()
      }
    }
  }

  const mounts = [mountHttp, mountUpgrade]
  for (const mount of mounts) {
    if (typeof ctx?.effect === 'function') {
      ctx.effect(mount, `dsh-vars: ${mount.name}`)
    } else {
      mount()
    }
  }
}
