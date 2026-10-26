import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply, inject, name } from '../lib/index.js'

/** Minimal ServerResponse double that records the JSON body. */
function createResponse() {
  const chunks = []
  let resolveDone
  const done = new Promise((resolvePromise) => {
    resolveDone = resolvePromise
  })
  const response = {
    writableEnded: false,
    status: undefined,
    headers: undefined,
    text: '',
    done,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(chunk) {
      this.writableEnded = true
      if (chunk !== undefined) chunks.push(String(chunk))
      this.text = chunks.join('')
      resolveDone()
    },
  }
  return response
}

/** Minimal IncomingMessage double for the API handler. */
function createRequest(url, method = 'GET') {
  return {
    url,
    method,
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    on() {},
  }
}

test('host plugin mounts the prefix and answers /health', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-vars-index-'))
  try {
    assert.equal(name, 'dsh-vars')
    assert.deepEqual(inject, ['webServer'])

    let route
    let upgrade
    const logger = { info() {}, warn() {} }
    const ctx = {
      logger,
      effect(callback) {
        return callback()
      },
      webServer: {
        port: 45678,
        register(specification) {
          route = specification
          return () => {}
        },
        registerUpgrade(specification) {
          upgrade = specification
          return () => {}
        },
      },
    }

    apply(ctx, { stateDir: dir })
    assert.ok(route, 'webServer.register must be called')
    assert.equal(route.kind, 'prefix')
    assert.equal(route.path, '/dsh-vars/api')
    assert.equal(typeof route.handler, 'function')
    assert.ok(upgrade, 'webServer.registerUpgrade must be called')
    assert.equal(upgrade.path, '/dsh-vars/api/events')
    assert.equal(typeof upgrade.handler, 'function')

    const response = createResponse()
    route.handler(createRequest('/dsh-vars/api/info'), response)
    await response.done
    const info = JSON.parse(response.text)
    assert.equal(response.status, 200)
    assert.equal(info.value.port, 45678)
    assert.equal(info.value.loopback, 'http://127.0.0.1:45678')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
