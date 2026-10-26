import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { coerceValue, createVariableStore, isVariableName } from '../lib/store.js'

async function createTempStore() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-vars-store-'))
  const file = join(dir, 'variables.json')
  return { dir, file, store: createVariableStore({ file }) }
}

test('creates every type with defaults and lists them by name', async () => {
  const { dir, store } = await createTempStore()
  try {
    const text = await store.create({ name: 'greeting', type: 'string' })
    assert.equal(text.value, '')
    const count = await store.create({ name: 'counter', type: 'number', initialValue: 3 })
    assert.equal(count.value, 3)
    const flag = await store.create({ name: 'flag', type: 'boolean' })
    assert.equal(flag.value, false)
    const payload = await store.create({ name: 'payload', type: 'json', initialValue: '{"a":1}' })
    assert.deepEqual(payload.value, { a: 1 })

    const list = await store.list()
    assert.deepEqual(list.map((item) => item.name), ['counter', 'flag', 'greeting', 'payload'])
    assert.deepEqual(await store.get('payload'), payload)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('rejects invalid names, types and values', async () => {
  const { dir, store } = await createTempStore()
  try {
    await assert.rejects(() => store.create({ name: '1bad', type: 'string' }), /变量名/)
    await assert.rejects(() => store.create({ name: 'has space', type: 'string' }), /变量名/)
    await assert.rejects(() => store.create({ name: 'x', type: 'date' }), /变量类型/)
    await assert.rejects(() => store.create({ name: 'x', type: 'number', initialValue: 'abc' }), /数字/)
    await assert.rejects(() => store.create({ name: 'x', type: 'boolean', initialValue: 'yes' }), /布尔/)
    await assert.rejects(() => store.create({ name: 'x', type: 'json', initialValue: '{oops' }), /JSON/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('set coerces HTTP-query text according to the declared type', async () => {
  const { dir, store } = await createTempStore()
  try {
    await store.create({ name: 'n', type: 'number' })
    assert.equal((await store.set('n', '42')).value, 42)
    assert.equal((await store.set('n', '3.5')).value, 3.5)
    await store.create({ name: 'b', type: 'boolean' })
    assert.equal((await store.set('b', 'true')).value, true)
    assert.equal((await store.set('b', 'false')).value, false)
    await store.create({ name: 'j', type: 'json' })
    assert.deepEqual((await store.set('j', '[1,2,3]')).value, [1, 2, 3])
    await store.create({ name: 's', type: 'string' })
    assert.equal((await store.set('s', 'hello')).value, 'hello')

    await assert.rejects(() => store.set('n', 'NaN'), /数字/)
    await assert.rejects(() => store.set('missing', '1'), /不存在/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('persists to disk and reloads from a new store instance', async () => {
  const { dir, file, store } = await createTempStore()
  try {
    await store.create({ name: 'persisted', type: 'json', initialValue: { nested: [1, 2] } })
    await store.set('persisted', '{"nested":[3]}')
    const raw = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(raw.variables[0].name, 'persisted')

    const reopened = createVariableStore({ file })
    const list = await reopened.list()
    assert.equal(list.length, 1)
    assert.deepEqual(list[0].value, { nested: [3] })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('duplicate creation conflicts and delete removes', async () => {
  const { dir, store } = await createTempStore()
  try {
    await store.create({ name: 'dup', type: 'string' })
    await assert.rejects(() => store.create({ name: 'dup', type: 'string' }), /已存在/)
    assert.equal(await store.remove('dup'), true)
    assert.equal(await store.remove('dup'), false)
    assert.equal(await store.get('dup'), undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a corrupt file is archived and the store starts empty', async () => {
  const { dir, file } = await createTempStore()
  try {
    await writeFile(file, '{ this is not json')
    const store = createVariableStore({ file })
    assert.deepEqual(await store.list(), [])
    const entries = await readdir(dir)
    assert.ok(entries.some((name) => name.includes('.corrupt-')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('concurrent mutations are serialised without losing variables', async () => {
  const { dir, store } = await createTempStore()
  try {
    await Promise.all(
      Array.from({ length: 20 }, (_, index) => store.create({ name: `v${index}`, type: 'number', initialValue: index })),
    )
    const list = await store.list()
    assert.equal(list.length, 20)
    await Promise.all(list.map((item) => store.set(item.name, String(Number(item.value) + 100))))
    const updated = await store.list()
    const byName = new Map(updated.map((item) => [item.name, item.value]))
    for (let index = 0; index < 20; index += 1) {
      assert.equal(byName.get(`v${index}`), index + 100)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('coerceValue and isVariableName edge cases', () => {
  assert.equal(isVariableName('a'), true)
  assert.equal(isVariableName('a.b-c_1'), true)
  assert.equal(isVariableName('_x'), true)
  assert.equal(isVariableName(''), false)
  assert.equal(isVariableName('1a'), false)
  assert.equal(isVariableName('a b'), false)
  assert.equal(isVariableName('x'.repeat(65)), false)
  assert.deepEqual(coerceValue('json', '{"k":true}'), { k: true })
  assert.equal(coerceValue('string', ''), '')
})

test('subscribe emits created / updated / deleted events', async () => {
  const { dir, store } = await createTempStore()
  try {
    const events = []
    const unsubscribe = store.subscribe((event) => events.push(event))
    await store.create({ name: 'watched', type: 'number', initialValue: 1 })
    await store.set('watched', 2)
    await store.remove('watched')
    unsubscribe()
    await store.create({ name: 'after', type: 'string' })
    assert.deepEqual(events, [
      { type: 'created', name: 'watched' },
      { type: 'updated', name: 'watched' },
      { type: 'deleted', name: 'watched' },
    ])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
