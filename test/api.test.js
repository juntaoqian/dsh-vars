import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createVariablesApi } from '../lib/api.js'
import { createVariableStore } from '../lib/store.js'

async function createServer(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-vars-api-'))
  const store = createVariableStore({ file: join(dir, 'variables.json') })
  const handler = createVariablesApi({
    store,
    token: options.token,
    getInfo: options.getInfo,
  })
  const server = http.createServer((request, response) => {
    void handler(request, response)
  })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  const { port } = server.address()
  return {
    store,
    base: `http://127.0.0.1:${port}/dsh-vars/api`,
    async dispose() {
      await new Promise((resolvePromise) => server.close(() => resolvePromise()))
      await rm(dir, { recursive: true, force: true })
    },
  }
}

async function call(base, method, path, body, headers = {}) {
  const init = { method, headers: { accept: 'application/json', ...headers } }
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const response = await fetch(`${base}${path}`, init)
  const text = await response.text()
  return { status: response.status, body: text === '' ? undefined : JSON.parse(text) }
}

test('health reports the store state', async () => {
  const harness = await createServer()
  try {
    const response = await call(harness.base, 'GET', '/health')
    assert.equal(response.status, 200)
    assert.equal(response.body.ok, true)
    assert.equal(response.body.value.status, 'ok')
    assert.deepEqual(response.body.value.types, ['string', 'number', 'boolean', 'json'])
    assert.equal(response.body.value.tokenRequired, false)
  } finally {
    await harness.dispose()
  }
})

test('GET /all returns every variable (alias of the list endpoint)', async () => {
  const harness = await createServer()
  try {
    await call(harness.base, 'POST', '/variables', { name: 'a', type: 'string', initialValue: 'x' })
    await call(harness.base, 'POST', '/variables', { name: 'b', type: 'number', initialValue: 2 })
    const response = await call(harness.base, 'GET', '/all')
    assert.equal(response.status, 200)
    assert.deepEqual(response.body.value.map((item) => item.name), ['a', 'b'])
  } finally {
    await harness.dispose()
  }
})

test('/info reports the local port and addresses', async () => {
  const harness = await createServer({
    getInfo: () => ({
      port: 40123,
      hostname: 'test-pc',
      loopback: 'http://127.0.0.1:40123',
      addresses: [{ nic: 'Wi-Fi', address: '192.168.1.10' }],
    }),
  })
  try {
    const response = await call(harness.base, 'GET', '/info')
    assert.equal(response.status, 200)
    assert.equal(response.body.value.port, 40123)
    assert.equal(response.body.value.hostname, 'test-pc')
    assert.equal(response.body.value.basePath, '/dsh-vars/api')
    assert.equal(response.body.value.tokenRequired, false)
    assert.deepEqual(response.body.value.addresses, [{ nic: 'Wi-Fi', address: '192.168.1.10' }])
  } finally {
    await harness.dispose()
  }
})

test('optional Bearer token guards data endpoints and accepts header or query', async () => {
  const harness = await createServer({ token: 's3cret' })
  try {
    assert.equal((await call(harness.base, 'GET', '/variables')).status, 401)
    assert.equal((await call(harness.base, 'GET', '/variables', undefined, { authorization: 'Bearer wrong' })).status, 401)
    assert.equal((await call(harness.base, 'GET', '/variables', undefined, { authorization: 'Bearer s3cret' })).status, 200)
    assert.equal((await call(harness.base, 'GET', '/variables?token=s3cret')).status, 200)
    assert.equal((await call(harness.base, 'GET', '/health')).status, 200)
    assert.equal((await call(harness.base, 'GET', '/info')).body.value.tokenRequired, true)
    assert.equal((await call(harness.base, 'POST', '/variables', { name: 'x', type: 'string' })).status, 401)
  } finally {
    await harness.dispose()
  }
})

test('create, list, get, update and delete through HTTP', async () => {
  const harness = await createServer()
  try {
    const created = await call(harness.base, 'POST', '/variables', { name: 'demo', type: 'number', initialValue: 1 })
    assert.equal(created.status, 201)
    assert.equal(created.body.value.value, 1)

    const list = await call(harness.base, 'GET', '/variables')
    assert.equal(list.status, 200)
    assert.equal(list.body.value.length, 1)

    const single = await call(harness.base, 'GET', '/variables/demo')
    assert.equal(single.status, 200)
    assert.equal(single.body.value.type, 'number')

    const updated = await call(harness.base, 'POST', '/variables/demo', { value: 7 })
    assert.equal(updated.status, 200)
    assert.equal(updated.body.value.value, 7)

    const put = await call(harness.base, 'PUT', '/variables/demo', { value: 9 })
    assert.equal(put.status, 200)
    assert.equal(put.body.value.value, 9)

    const deleted = await call(harness.base, 'DELETE', '/variables/demo')
    assert.equal(deleted.status, 200)
    assert.equal((await call(harness.base, 'GET', '/variables/demo')).status, 404)
  } finally {
    await harness.dispose()
  }
})

test('GET /set updates an existing variable (the "GET request" requirement)', async () => {
  const harness = await createServer()
  try {
    await call(harness.base, 'POST', '/variables', { name: 'flag', type: 'boolean' })
    const response = await call(harness.base, 'GET', '/set?name=flag&value=true')
    assert.equal(response.status, 200)
    assert.equal(response.body.value.value, true)

    const number = await call(harness.base, 'POST', '/variables', { name: 'count', type: 'number', initialValue: 0 })
    assert.equal(number.status, 201)
    const updated = await call(harness.base, 'GET', '/set?name=count&value=42')
    assert.equal(updated.body.value.value, 42)

    const json = await call(harness.base, 'POST', '/variables', { name: 'payload', type: 'json' })
    assert.equal(json.status, 201)
    const jsonUpdated = await call(harness.base, 'GET', '/set?name=payload&value=' + encodeURIComponent('{"ok":true}'))
    assert.deepEqual(jsonUpdated.body.value.value, { ok: true })
  } finally {
    await harness.dispose()
  }
})

test('POST /set accepts a JSON body', async () => {
  const harness = await createServer()
  try {
    await call(harness.base, 'POST', '/variables', { name: 'text', type: 'string' })
    const response = await call(harness.base, 'POST', '/set', { name: 'text', value: 'hello' })
    assert.equal(response.status, 200)
    assert.equal(response.body.value.value, 'hello')
  } finally {
    await harness.dispose()
  }
})

test('validation and missing resources map to stable HTTP errors', async () => {
  const harness = await createServer()
  try {
    assert.equal((await call(harness.base, 'POST', '/variables', { name: '1bad', type: 'string' })).status, 400)
    assert.equal((await call(harness.base, 'POST', '/variables', { name: 'x', type: 'date' })).status, 400)
    assert.equal((await call(harness.base, 'POST', '/variables', { name: 'x', type: 'string' })).status, 201)
    assert.equal((await call(harness.base, 'POST', '/variables', { name: 'x', type: 'string' })).status, 409)
    assert.equal((await call(harness.base, 'POST', '/variables/x', { value: 1 })).status, 400)
    assert.equal((await call(harness.base, 'GET', '/variables/missing')).status, 404)
    assert.equal((await call(harness.base, 'GET', '/set?name=missing&value=1')).status, 404)
    assert.equal((await call(harness.base, 'GET', '/set?name=x')).status, 400)
    assert.equal((await call(harness.base, 'GET', '/nope')).status, 404)
    assert.equal((await call(harness.base, 'PATCH', '/variables/x')).status, 405)
    assert.equal((await call(harness.base, 'GET', '/variables/x')).status, 200)
  } finally {
    await harness.dispose()
  }
})

test('malformed JSON bodies are rejected', async () => {
  const harness = await createServer()
  try {
    const response = await fetch(`${harness.base}/variables`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{broken',
    })
    assert.equal(response.status, 400)
    const body = await response.json()
    assert.equal(body.ok, false)
    assert.equal(body.error.code, 'invalid-json')
  } finally {
    await harness.dispose()
  }
})
