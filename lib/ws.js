/**
 * dsh-vars — WebSocket change feed.
 *
 * DSH's web server exposes `registerUpgrade({ path, handler })`; this module
 * implements the server half of RFC 6455 with the small subset needed for a
 * push-only feed (no external dependencies):
 *
 *   - handshake: SHA-1 Sec-WebSocket-Accept
 *   - server → client text frames
 *   - ping heartbeat, close/error cleanup
 *
 * The client already knows how to read server text frames (browser WebSocket),
 * so no incoming frame parsing is needed beyond letting the socket close.
 *
 * @module lib/ws
 */

import { createHash } from 'node:crypto'

import { API_PREFIX, suppliedToken } from './api.js'

/** RFC 6455 handshake GUID. */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** Heartbeat interval for idle sockets. */
const PING_INTERVAL_MS = 25_000

/** Exact upgrade path. */
export const EVENTS_PATH = `${API_PREFIX}/events`

/** @param {import('node:net').Socket} socket socket. */
function isOpen(socket) {
  return socket !== null && socket !== undefined && socket.destroyed !== true && socket.writable !== false
}

/**
 * Encode one unmasked server → client text frame.
 * @param {string} text frame payload.
 * @returns {Buffer} frame bytes.
 */
export function encodeTextFrame(text) {
  const payload = Buffer.from(text, 'utf8')
  let header
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length])
  } else if (payload.length < 65_536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(payload.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  return Buffer.concat([header, payload])
}

/**
 * Encode one empty ping frame.
 * @returns {Buffer} frame bytes.
 */
function pingFrame() {
  return Buffer.from([0x89, 0x00])
}

/**
 * Build the upgrade handler.
 *
 * @param {object} options options.
 * @param {ReturnType<import('./store.js').createVariableStore>} options.store variable store.
 * @param {string} [options.token] optional Bearer token.
 * @param {{warn?: Function, info?: Function}} [options.logger] logger.
 * @returns {{ handler: (request: import('node:http').IncomingMessage, socket: import('node:net').Socket, head: Buffer) => void, closeAll: () => void }} upgrade handler + disposer.
 */
export function createEventsUpgrade(options) {
  const { store, logger } = options
  const token = typeof options.token === 'string' ? options.token.trim() : ''
  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set()
  /** @type {Set<() => void>} */
  const cleanups = new Set()

  function reject(socket, status, message) {
    try {
      if (isOpen(socket)) {
        socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
      }
    } finally {
      socket.destroy()
    }
  }

  function closeAll() {
    for (const cleanup of [...cleanups]) cleanup()
    for (const socket of [...sockets]) socket.destroy()
    sockets.clear()
  }

  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:net').Socket} socket
   * @param {Buffer} head
   */
  function handler(request, socket, head) {
    const remote = request.socket?.remoteAddress
    if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
      reject(socket, 403, 'Forbidden')
      return
    }
    const url = new URL(request.url ?? '/', 'http://dsh-vars.invalid')
    if (url.pathname !== EVENTS_PATH) {
      reject(socket, 404, 'Not Found')
      return
    }
    if (token !== '') {
      const supplied = suppliedToken(request, url)
      if (supplied === undefined || !timingSafeToken(token, supplied)) {
        reject(socket, 401, 'Unauthorized')
        return
      }
    }
    const key = request.headers['sec-websocket-key']
    if (typeof key !== 'string' || key === '') {
      reject(socket, 400, 'Bad Request')
      return
    }
    if (String(request.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
      reject(socket, 400, 'Bad Request')
      return
    }

    const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64')
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        '',
      ].join('\r\n'),
    )
    sockets.add(socket)

    let closed = false
    const cleanup = () => {
      if (closed) return
      closed = true
      cleanups.delete(cleanup)
      sockets.delete(socket)
      socket.destroy()
    }
    cleanups.add(cleanup)
    socket.on('close', cleanup)
    socket.on('error', cleanup)

    const send = (payload) => {
      if (!isOpen(socket) || closed) return
      try {
        socket.write(encodeTextFrame(JSON.stringify(payload)))
      } catch {
        cleanup()
      }
    }

    void store
      .list()
      .then((variables) => {
        send({ type: 'ready', count: variables.length, tokenRequired: token !== '' })
      })
      .catch((error) => {
        logger?.warn?.(`dsh-vars: events ready 失败：${error instanceof Error ? error.message : String(error)}`)
      })

    const unsubscribe = store.subscribe((event) => {
      send({ type: 'change', event, at: new Date().toISOString() })
    })
    cleanups.add(unsubscribe)

    const ping = setInterval(() => {
      if (!isOpen(socket) || closed) return
      try {
        socket.write(pingFrame())
      } catch {
        cleanup()
      }
    }, PING_INTERVAL_MS)
    ping.unref?.()
    cleanups.add(() => clearInterval(ping))

    if (head !== undefined && head !== null && head.length > 0) {
      // The handshake consumed everything we need; incoming frames are not
      // parsed (this feed is push-only), so just ignore the head.
    }
  }

  return { handler, closeAll }
}

/** Constant-time token comparison for the upgrade path. */
function timingSafeToken(expected, supplied) {
  const digest = (value) => createHash('sha256').update(value, 'utf8').digest()
  try {
    return digest(expected).equals(digest(supplied))
  } catch {
    return false
  }
}
