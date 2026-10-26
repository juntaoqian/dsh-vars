/**
 * dsh-vars — HTTP API mounted on the DSH web server.
 *
 * The API is intentionally small and loopback-only:
 *
 *   GET    /dsh-vars/api/health
 *   GET    /dsh-vars/api/variables
 *   POST   /dsh-vars/api/variables                 { name, type, initialValue? }
 *   GET    /dsh-vars/api/variables/<name>
 *   POST   /dsh-vars/api/variables/<name>          { value }
 *   PUT    /dsh-vars/api/variables/<name>          { value }
 *   DELETE /dsh-vars/api/variables/<name>
 *   GET    /dsh-vars/api/set?name=<name>&value=<value>
 *   POST   /dsh-vars/api/set                       { name, value }
 *
 * Every response uses the same envelope: `{ ok: true, value }` or
 * `{ ok: false, error: { code, message } }`.
 *
 * @module lib/api
 */

import { createHash, timingSafeEqual } from 'node:crypto'

import { VariableError, isVariableName, VARIABLE_TYPES } from './store.js'

/** Prefix registered on the DSH web server. */
export const API_PREFIX = '/dsh-vars/api'

/** Maximum accepted JSON request body. */
const MAX_BODY_BYTES = 64 * 1024

/** @param {string|undefined} address socket remote address. */
function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Constant-time comparison for the optional Bearer token. */
function tokenMatches(expected, supplied) {
  if (typeof expected !== 'string' || expected === '') return false
  if (typeof supplied !== 'string' || supplied === '') return false
  const digest = (value) => createHash('sha256').update(value, 'utf8').digest()
  return timingSafeEqual(digest(expected), digest(supplied))
}

/**
 * Read the caller's token from `Authorization: Bearer` or the `token` query
 * parameter (EventSource/WebSocket in a browser cannot set headers).
 * @param {import('node:http').IncomingMessage} request incoming request.
 * @param {URL} url parsed URL.
 * @returns {string|undefined} supplied token.
 */
export function suppliedToken(request, url) {
  const header = request.headers?.authorization
  if (typeof header === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (match) return match[1].trim()
  }
  return url.searchParams.get('token') ?? undefined
}

/** Send one JSON response and end it. */
function sendJson(response, status, body) {
  if (response.writableEnded) return
  let text
  try {
    text = JSON.stringify(body)
  } catch {
    text = JSON.stringify({ ok: false, error: { code: 'internal-error', message: '响应无法序列化' } })
    status = 500
  }
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(text)
}

/** @returns {{ok: false, error: {code: string, message: string}}} */
function failure(code, message) {
  return { ok: false, error: { code, message } }
}

/**
 * Read a bounded JSON body.
 * @param {import('node:http').IncomingMessage} request incoming request.
 * @returns {Promise<unknown>} parsed JSON.
 */
function readJsonBody(request) {
  return new Promise((resolvePromise, reject) => {
    const chunks = []
    let size = 0
    let done = false
    request.on('data', (chunk) => {
      if (done) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        done = true
        reject(new VariableError('body-too-large', `请求体不能超过 ${MAX_BODY_BYTES} 字节`))
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (done) return
      done = true
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') {
        resolvePromise(undefined)
        return
      }
      try {
        resolvePromise(JSON.parse(text))
      } catch {
        reject(new VariableError('invalid-json', '请求体必须是合法 JSON'))
      }
    })
    request.on('error', (error) => {
      if (done) return
      done = true
      reject(error)
    })
  })
}

/** @param {unknown} value unknown body. @returns {Record<string, unknown>|undefined} object body. */
function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : undefined
}

/** Map a store/transport error onto HTTP status + envelope. */
function errorResponse(error) {
  if (error instanceof VariableError) {
    const status = error.code === 'not-found' ? 404 : error.code === 'conflict' || error.code === 'too-many-variables' ? 409 : error.code === 'body-too-large' ? 413 : 400
    return { status, body: failure(error.code, error.message) }
  }
  return { status: 500, body: failure('internal-error', '变量服务内部错误') }
}

/**
 * Build the request handler.
 *
 * @param {object} options options.
 * @param {ReturnType<import('./store.js').createVariableStore>} options.store variable store.
 * @param {string} [options.token] optional Bearer token required for data endpoints.
 * @param {() => Promise<object>|object} [options.getInfo] local address provider.
 * @param {{warn?: Function, info?: Function}} [options.logger] optional logger.
 * @returns {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => Promise<void>} handler.
 */
export function createVariablesApi(options) {
  const { store, logger, getInfo } = options
  const token = typeof options.token === 'string' ? options.token.trim() : ''
  if (!store || typeof store.list !== 'function') throw new Error('createVariablesApi: store is required')

  async function route(request, response) {
    if (!isLoopbackAddress(request.socket?.remoteAddress)) {
      sendJson(response, 403, failure('loopback-only', '变量接口只允许本机访问'))
      return
    }

    const url = new URL(request.url ?? '/', 'http://dsh-vars.invalid')
    const pathname = url.pathname
    if (pathname !== API_PREFIX && !pathname.startsWith(`${API_PREFIX}/`)) {
      sendJson(response, 404, failure('not-found', '接口不存在'))
      return
    }
    const suffix = pathname.slice(API_PREFIX.length) || '/'
    const method = (request.method ?? 'GET').toUpperCase()

    // `/health` and `/info` stay public so scripts can discover the port and
    // whether a token is required; every data endpoint is guarded.
    const isPublic = suffix === '/health' || suffix === '/info'
    if (!isPublic && token !== '' && !tokenMatches(token, suppliedToken(request, url))) {
      response.setHeader('www-authenticate', 'Bearer')
      sendJson(response, 401, failure('unauthorized', '需要 Bearer token'))
      return
    }

    if (suffix === '/health') {
      if (method !== 'GET') {
        response.setHeader('allow', 'GET')
        sendJson(response, 405, failure('method-not-allowed', '只支持 GET'))
        return
      }
      const variables = await store.list()
      sendJson(response, 200, { ok: true, value: { status: 'ok', count: variables.length, types: VARIABLE_TYPES, tokenRequired: token !== '' } })
      return
    }

    if (suffix === '/info') {
      if (method !== 'GET') {
        response.setHeader('allow', 'GET')
        sendJson(response, 405, failure('method-not-allowed', '只支持 GET'))
        return
      }
      const info = typeof getInfo === 'function' ? await getInfo() : {}
      sendJson(response, 200, {
        ok: true,
        value: {
          basePath: API_PREFIX,
          tokenRequired: token !== '',
          ...info,
        },
      })
      return
    }

    if (suffix === '/all') {
      if (method !== 'GET') {
        response.setHeader('allow', 'GET')
        sendJson(response, 405, failure('method-not-allowed', '只支持 GET'))
        return
      }
      const variables = await store.list()
      sendJson(response, 200, { ok: true, value: variables })
      return
    }

    if (suffix === '/events') {
      sendJson(response, 426, failure('upgrade-required', '变量变化订阅需要 WebSocket 连接到该地址'))
      return
    }

    if (suffix === '/variables') {
      if (method === 'GET') {
        const variables = await store.list()
        sendJson(response, 200, { ok: true, value: variables })
        return
      }
      if (method === 'POST') {
        const body = asRecord(await readJsonBody(request))
        if (body === undefined) {
          sendJson(response, 400, failure('invalid-body', '请求体必须是 JSON 对象'))
          return
        }
        const created = await store.create({
          name: body.name,
          type: body.type,
          initialValue: body.initialValue,
          value: body.value,
        })
        sendJson(response, 201, { ok: true, value: created })
        return
      }
      response.setHeader('allow', 'GET, POST')
      sendJson(response, 405, failure('method-not-allowed', '只支持 GET / POST'))
      return
    }

    if (suffix === '/set') {
      if (method === 'GET') {
        const name = url.searchParams.get('name') ?? ''
        const rawValue = url.searchParams.get('value')
        if (rawValue === null) {
          sendJson(response, 400, failure('invalid-value', '缺少 value 查询参数'))
          return
        }
        const updated = await store.set(name, rawValue)
        sendJson(response, 200, { ok: true, value: updated })
        return
      }
      if (method === 'POST') {
        const body = asRecord(await readJsonBody(request))
        if (body === undefined || typeof body.name !== 'string') {
          sendJson(response, 400, failure('invalid-body', '请求体需要 name 和 value'))
          return
        }
        const updated = await store.set(body.name, body.value)
        sendJson(response, 200, { ok: true, value: updated })
        return
      }
      response.setHeader('allow', 'GET, POST')
      sendJson(response, 405, failure('method-not-allowed', '只支持 GET / POST'))
      return
    }

    if (suffix.startsWith('/variables/')) {
      const rawName = suffix.slice('/variables/'.length)
      let name
      try {
        name = decodeURIComponent(rawName)
      } catch {
        sendJson(response, 400, failure('invalid-name', '变量名编码无效'))
        return
      }
      if (!isVariableName(name)) {
        sendJson(response, 400, failure('invalid-name', '变量名格式无效'))
        return
      }
      if (method === 'GET') {
        const variable = await store.get(name)
        if (variable === undefined) {
          sendJson(response, 404, failure('not-found', `变量 ${name} 不存在`))
          return
        }
        sendJson(response, 200, { ok: true, value: variable })
        return
      }
      if (method === 'POST' || method === 'PUT') {
        const body = asRecord(await readJsonBody(request))
        if (body === undefined || !Object.hasOwn(body, 'value')) {
          sendJson(response, 400, failure('invalid-body', '请求体需要 value 字段'))
          return
        }
        const updated = await store.set(name, body.value)
        sendJson(response, 200, { ok: true, value: updated })
        return
      }
      if (method === 'DELETE') {
        const removed = await store.remove(name)
        if (!removed) {
          sendJson(response, 404, failure('not-found', `变量 ${name} 不存在`))
          return
        }
        sendJson(response, 200, { ok: true, value: { name, deleted: true } })
        return
      }
      response.setHeader('allow', 'GET, POST, PUT, DELETE')
      sendJson(response, 405, failure('method-not-allowed', '只支持 GET / POST / PUT / DELETE'))
      return
    }

    sendJson(response, 404, failure('not-found', '接口不存在'))
  }

  return async function handler(request, response) {
    try {
      await route(request, response)
    } catch (error) {
      const { status, body } = errorResponse(error)
      if (status >= 500) logger?.warn?.(`dsh-vars: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
      sendJson(response, status, body)
    }
  }
}
