import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createVariableStore } from '../lib/store.js'
import { EVENTS_PATH, createEventsUpgrade } from '../lib/ws.js'

/** Parse complete unmasked server → client frames from one buffer. */
function parseFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset]
    const second = buffer[offset + 1]
    const opcode = first & 0x0f
    let length = second & 0x7f
    let headerSize = 2
    if (length === 126) {
      if (offset + 4 > buffer.length) break
      length = buffer.readUInt16BE(offset + 2)
      headerSize = 4
    } else if (length === 127) {
      if (offset + 10 > buffer.length) break
      length = Number(buffer.readBigUInt64BE(offset + 2))
      headerSize = 10
    }
    if (offset + headerSize + length > buffer.length) break
    const payload = buffer.subarray(offset + headerSize, offset + headerSize + length)
    frames.push({ opcode, text: opcode === 0x1 ? payload.toString('utf8') : '' })
    offset += headerSize + length
  }
  return frames
}

async function startServer(store, token) {
  const events = createEventsUpgrade({ store, token })
  const server = http.createServer((request, response) => {
    response.writeHead(404)
    response.end()
  })
  server.on('upgrade', (request, socket, head) => events.handler(request, socket, head))
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  return { server, events, port: server.address().port }
}

function handshake(port, path = EVENTS_PATH) {
  return new Promise((resolvePromise, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          'Host: 127.0.0.1',
          'Upgrade: websocket',
          'Connection: Upgrade',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version: 13',
          '',
          '',
        ].join('\r\n'),
      )
    })
    let buffer = Buffer.alloc(0)
    let upgraded = false
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (!upgraded) {
        const headerEnd = buffer.indexOf('\r\n\r\n')
        if (headerEnd === -1) return
        const head = buffer.subarray(0, headerEnd).toString('latin1')
        buffer = buffer.subarray(headerEnd + 4)
        upgraded = true
        resolvePromise({ socket, statusLine: head.split('\r\n')[0], head, frames: () => parseFrames(buffer) })
        return
      }
      socket.emit('frames', buffer)
    })
    socket.on('error', reject)
    setTimeout(() => reject(new Error('handshake timeout')), 4_000).unref()
  })
}

function waitForFrame(client, predicate) {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('frame timeout')), 4_000)
    timer.unref?.()
    const check = () => {
      for (const frame of client.frames()) {
        if (frame.opcode === 0x1) {
          let payload
          try {
            payload = JSON.parse(frame.text)
          } catch {
            continue
          }
          if (predicate(payload)) {
            clearTimeout(timer)
            resolvePromise(payload)
            return
          }
        }
      }
    }
    client.socket.on('frames', check)
    check()
  })
}

test('upgrade handshake succeeds and the feed pushes changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-vars-ws-'))
  const store = createVariableStore({ file: join(dir, 'variables.json') })
  const { server, events, port } = await startServer(store)
  try {
    const client = await handshake(port)
    assert.match(client.statusLine, /101/)
    await waitForFrame(client, (payload) => payload.type === 'ready')
    await store.create({ name: 'live', type: 'number', initialValue: 1 })
    const change = await waitForFrame(client, (payload) => payload.type === 'change')
    assert.equal(change.event.type, 'created')
    assert.equal(change.event.name, 'live')
    client.socket.destroy()
    events.closeAll()
  } finally {
    await new Promise((resolvePromise) => server.close(() => resolvePromise()))
    await rm(dir, { recursive: true, force: true })
  }
})

test('upgrade requires the Bearer token when configured', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-vars-ws-'))
  const store = createVariableStore({ file: join(dir, 'variables.json') })
  const { server, events, port } = await startServer(store, 's3cret')
  try {
    const denied = await handshake(port)
    assert.match(denied.statusLine, /401/)
    denied.socket.destroy()
    const authorized = await handshake(port, `${EVENTS_PATH}?token=s3cret`)
    assert.match(authorized.statusLine, /101/)
    authorized.socket.destroy()
    events.closeAll()
  } finally {
    await new Promise((resolvePromise) => server.close(() => resolvePromise()))
    await rm(dir, { recursive: true, force: true })
  }
})
