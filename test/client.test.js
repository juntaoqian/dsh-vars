import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('the client bundle registers a 设置 → 变量 section', async () => {
  const code = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

  let registration
  const fakeWindow = {
    __ModuleLoader__: {
      load(value) {
        registration = value
      },
    },
  }
  // eslint-disable-next-line no-new-func
  new Function('window', code)(fakeWindow)

  assert.ok(registration, 'bundle must call window.__ModuleLoader__.load')
  assert.equal(registration.id, 'dsh-vars')

  const plugin = registration.factory((specifier) => {
    if (specifier === 'react') return { createElement() {}, useState() {}, useEffect() {} }
    throw new Error(`unexpected module: ${specifier}`)
  })
  assert.deepEqual(plugin.inject, ['slots', 'locale'])
  assert.equal(typeof plugin.apply, 'function')

  let localeCall
  let section
  const ctx = {
    effect(callback) {
      return callback()
    },
    locale: {
      register(namespace, dictionaries) {
        localeCall = { namespace, dictionaries }
        return () => {}
      },
    },
    slots: {
      inject(name, callback) {
        assert.equal(name, 'settings.section')
        callback()
      },
      register(specification, component) {
        section = { specification, component }
        return () => {}
      },
    },
  }

  plugin.apply(ctx)
  assert.equal(localeCall.namespace, 'dsh-vars')
  assert.equal(typeof localeCall.dictionaries.zh.nav, 'string')
  assert.equal(typeof localeCall.dictionaries.en.nav, 'string')
  assert.equal(section.specification.id, 'dsh-vars')
  assert.equal(section.specification.order, 3)
  assert.equal(typeof section.specification.inject, 'function')
  const injected = section.specification.inject()
  assert.equal(typeof injected.api.list, 'function')
  assert.equal(typeof injected.api.create, 'function')
  assert.equal(typeof injected.api.set, 'function')
  assert.equal(typeof injected.api.remove, 'function')
  assert.equal(typeof section.component, 'function')
})
