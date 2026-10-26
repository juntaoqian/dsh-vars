/**
 * dsh-vars — typed variable store.
 *
 * Values are persisted as one JSON document with an atomic write per mutation
 * (unique temp file + rename) and owner-only permissions. Reads are served from
 * memory; every mutation is serialised through one promise chain so concurrent
 * HTTP requests cannot interleave a read-modify-write.
 *
 * @module lib/store
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Supported variable types. */
export const VARIABLE_TYPES = Object.freeze(['string', 'number', 'boolean', 'json'])

/** Maximum number of variables kept in one store. */
export const MAX_VARIABLES = 200

/** Maximum variable-name length. */
export const MAX_NAME_LENGTH = 64

/** Maximum serialised size of a JSON value, in bytes. */
export const MAX_JSON_BYTES = 64 * 1024

/** Maximum length of a string value. */
export const MAX_STRING_LENGTH = 64 * 1024

/** File-format version. */
const FILE_VERSION = 1

/** `my_var`, `a.b`, `flag-1` … but never empty, spaces or a leading digit. */
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/

/**
 * A rejected variable operation with a stable machine-readable code.
 */
export class VariableError extends Error {
  /**
   * @param {string} code stable error code.
   * @param {string} message human-readable message.
   */
  constructor(code, message) {
    super(message)
    this.name = 'VariableError'
    this.code = code
  }
}

/** @returns {VariableError} */
function invalidName() {
  return new VariableError('invalid-name', '变量名必须以字母或下划线开头，只能包含字母、数字、_ . -，最长 64 个字符')
}

/** @returns {VariableError} */
function invalidType() {
  return new VariableError('invalid-type', `变量类型必须是 ${VARIABLE_TYPES.join(' / ')} 之一`)
}

/**
 * Whether a name is a valid variable identifier.
 * @param {unknown} value candidate.
 * @returns {boolean} true when usable as a variable name.
 */
export function isVariableName(value) {
  return typeof value === 'string' && NAME_PATTERN.test(value)
}

/**
 * Default value for a type when the caller does not supply one.
 * @param {'string'|'number'|'boolean'|'json'} type variable type.
 * @returns {unknown} default value.
 */
export function defaultValueFor(type) {
  switch (type) {
    case 'string':
      return ''
    case 'number':
      return 0
    case 'boolean':
      return false
    case 'json':
      return null
    default:
      throw invalidType()
  }
}

/**
 * Validate and convert one incoming value for an existing type.
 *
 * Numbers and booleans also accept their textual HTTP-query form, so a plain
 * `GET /set?name=n&value=42` works without a JSON body.
 * @param {'string'|'number'|'boolean'|'json'} type variable type.
 * @param {unknown} input raw value (body value or query string).
 * @returns {unknown} validated value.
 * @throws {VariableError} on a type mismatch or oversized value.
 */
export function coerceValue(type, input) {
  switch (type) {
    case 'string': {
      if (typeof input !== 'string') throw new VariableError('invalid-value', '字符串变量的值必须是字符串')
      if (Buffer.byteLength(input, 'utf8') > MAX_STRING_LENGTH) {
        throw new VariableError('invalid-value', `字符串变量最长 ${MAX_STRING_LENGTH} 字节`)
      }
      return input
    }
    case 'number': {
      const numeric = typeof input === 'number' ? input : typeof input === 'string' && input.trim() !== '' ? Number(input) : Number.NaN
      if (!Number.isFinite(numeric)) throw new VariableError('invalid-value', '数字变量的值必须是有限数字')
      return numeric
    }
    case 'boolean': {
      if (typeof input === 'boolean') return input
      if (input === 'true') return true
      if (input === 'false') return false
      throw new VariableError('invalid-value', '布尔变量的值必须是 true / false')
    }
    case 'json': {
      let value = input
      if (typeof input === 'string') {
        try {
          value = JSON.parse(input)
        } catch {
          throw new VariableError('invalid-value', 'JSON 变量的值不是合法 JSON 文本')
        }
      }
      let text
      try {
        text = JSON.stringify(value)
      } catch {
        throw new VariableError('invalid-value', 'JSON 变量的值无法序列化')
      }
      if (text === undefined || Buffer.byteLength(text, 'utf8') > MAX_JSON_BYTES) {
        throw new VariableError('invalid-value', `JSON 变量最大 ${MAX_JSON_BYTES} 字节`)
      }
      return JSON.parse(text)
    }
    default:
      throw invalidType()
  }
}

/** Deep-clone a JSON value without sharing references. */
function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/**
 * Create a variable store backed by one JSON file.
 *
 * @param {object} options options.
 * @param {string} options.file absolute path of `variables.json`.
 * @param {{info?: Function, warn?: Function}} [options.logger] optional logger.
 * @param {() => number} [options.now] clock (tests).
 * @returns {ReturnType<typeof buildStore>} store facade.
 */
export function createVariableStore(options) {
  const { file, logger, now = Date.now } = options
  if (typeof file !== 'string' || file === '') throw new Error('createVariableStore: file is required')

  /** @type {Map<string, {name: string, type: string, value: unknown, createdAt: string, updatedAt: string}>} */
  let variables = new Map()
  let initPromise = null
  /** @type {Promise<unknown>} */
  let chain = Promise.resolve()
  /** @type {Set<(event: object) => void>} */
  const listeners = new Set()

  /**
   * Notify subscribers about one committed mutation.
   * @param {{type: 'created'|'updated'|'deleted', name: string}} event change event.
   */
  function emit(event) {
    for (const listener of [...listeners]) {
      try {
        listener(event)
      } catch {
        // a broken subscriber must never break a write
      }
    }
  }

  function snapshotDocument() {
    return {
      version: FILE_VERSION,
      variables: [...variables.values()].map((variable) => ({
        name: variable.name,
        type: variable.type,
        value: clone(variable.value),
        createdAt: variable.createdAt,
        updatedAt: variable.updatedAt,
      })),
    }
  }

  async function persist() {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
    try {
      await writeFile(tmp, `${JSON.stringify(snapshotDocument(), null, 2)}\n`, { mode: 0o600, flag: 'wx' })
      await rename(tmp, file)
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {})
      throw error
    }
  }

  async function load() {
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if (/** @type {{code?: string}} */ (error)?.code === 'ENOENT') return
      throw error
    }
    try {
      const parsed = JSON.parse(text)
      if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.variables)) {
        throw new Error('variables must be an array')
      }
      const next = new Map()
      for (const row of parsed.variables) {
        if (row === null || typeof row !== 'object') throw new Error('variable row must be an object')
        if (!isVariableName(row.name)) throw new Error(`invalid variable name: ${String(row.name)}`)
        if (!VARIABLE_TYPES.includes(row.type)) throw new Error(`invalid variable type: ${String(row.type)}`)
        const value = coerceValue(row.type, row.value)
        const timestamp = typeof row.createdAt === 'string' ? row.createdAt : new Date(now()).toISOString()
        next.set(row.name, {
          name: row.name,
          type: row.type,
          value,
          createdAt: timestamp,
          updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : timestamp,
        })
      }
      variables = next
    } catch (error) {
      // Keep the unreadable document for forensics and fail open with an empty
      // store: a corrupt cache must never make the plugin unmountable.
      const archived = `${file}.corrupt-${new Date(now()).toISOString().replace(/[:.]/g, '-')}`
      await rename(file, archived).catch(() => {})
      logger?.warn?.(`dsh-vars: 变量文件损坏，已备份到 ${archived}：${error instanceof Error ? error.message : String(error)}`)
      variables = new Map()
    }
  }

  function ensureLoaded() {
    if (!initPromise) {
      initPromise = load()
    }
    return initPromise
  }

  function enqueue(task) {
    const run = chain.then(async () => {
      await ensureLoaded()
      const result = await task()
      await persist()
      return result
    })
    chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  function publicView(variable) {
    return {
      name: variable.name,
      type: variable.type,
      value: clone(variable.value),
      createdAt: variable.createdAt,
      updatedAt: variable.updatedAt,
    }
  }

  function assertName(name) {
    if (!isVariableName(name)) throw invalidName()
  }

  return {
    file,

    /** Load the document (idempotent). */
    init() {
      return ensureLoaded()
    },

    /** @returns {Promise<Array<object>>} every variable, sorted by name. */
    async list() {
      await ensureLoaded()
      return [...variables.values()].sort((left, right) => left.name.localeCompare(right.name)).map(publicView)
    },

    /** @returns {Promise<object|undefined>} one variable. */
    async get(name) {
      await ensureLoaded()
      if (!isVariableName(name)) return undefined
      const variable = variables.get(name)
      return variable === undefined ? undefined : publicView(variable)
    },

    /**
     * Create a variable.
     * @param {{name: unknown, type: unknown, value?: unknown, initialValue?: unknown}} input
     * @returns {Promise<object>} the created variable.
     */
    create(input) {
      return enqueue(async () => {
        const name = input?.name
        const type = input?.type
        assertName(name)
        if (!VARIABLE_TYPES.includes(type)) throw invalidType()
        if (variables.has(name)) throw new VariableError('conflict', `变量 ${name} 已存在`)
        if (variables.size >= MAX_VARIABLES) {
          throw new VariableError('too-many-variables', `最多只能创建 ${MAX_VARIABLES} 个变量`)
        }
        const raw = input.initialValue !== undefined ? input.initialValue : input.value
        const value = raw === undefined ? defaultValueFor(type) : coerceValue(type, raw)
        const timestamp = new Date(now()).toISOString()
        const variable = { name, type, value, createdAt: timestamp, updatedAt: timestamp }
        variables.set(name, variable)
        emit({ type: 'created', name })
        return publicView(variable)
      })
    },

    /**
     * Replace an existing variable's value (its type is immutable).
     * @param {string} name variable name.
     * @param {unknown} value new value.
     * @returns {Promise<object>} the updated variable.
     */
    set(name, value) {
      return enqueue(async () => {
        assertName(name)
        const variable = variables.get(name)
        if (variable === undefined) throw new VariableError('not-found', `变量 ${name} 不存在`)
        variable.value = coerceValue(variable.type, value)
        variable.updatedAt = new Date(now()).toISOString()
        emit({ type: 'updated', name })
        return publicView(variable)
      })
    },

    /**
     * Delete a variable.
     * @param {string} name variable name.
     * @returns {Promise<boolean>} true when it existed.
     */
    remove(name) {
      return enqueue(async () => {
        assertName(name)
        const removed = variables.delete(name)
        if (removed) emit({ type: 'deleted', name })
        return removed
      })
    },

    /**
     * Subscribe to committed changes (`created` / `updated` / `deleted`).
     * @param {(event: {type: 'created'|'updated'|'deleted', name: string}) => void} listener subscriber.
     * @returns {() => void} unsubscribe.
     */
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {}
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
