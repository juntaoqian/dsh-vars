/**
 * dsh-vars — browser half (hand-written CJS factory).
 *
 * Mounts 设置 → 变量:
 *   - create typed variables (name / type / initial value, aligned columns)
 *   - edit and delete values
 *   - live refresh through the WebSocket change feed
 *   - optional Bearer token (kept in localStorage, sent on HTTP + WS)
 *   - local address / port shown at the top
 *
 * HTTP calls go to `/dsh-vars/api`; the change feed is
 * `ws(s)://<host>/dsh-vars/api/events`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-vars',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var h = React.createElement

    var NS = 'dsh-vars'
    var API_PATH = '/dsh-vars/api'
    var TOKEN_KEY = 'dsh-vars-token'
    var TYPES = ['string', 'number', 'boolean', 'json']

    var zh = {
      nav: '变量',
      title: '变量',
      subtitle: '创建带类型的变量，并通过本机 HTTP GET / POST 请求读取或修改它们的值。变量保存在本机 DSH 数据目录中。',
      infoTitle: '本机访问信息',
      infoPort: 'DSH 端口',
      infoLoopback: '本机',
      infoLan: '局域网',
      infoToken: 'API 令牌',
      tokenEnabled: '已启用',
      tokenDisabled: '未启用',
      infoHint: '脚本/其他程序请使用上面的地址；局域网地址仅在 DSH 监听非 loopback 时可用，变量接口本身仍只接受本机请求。',
      apiTitle: 'HTTP 接口',
      apiHint: 'GET 和 POST 都可以修改值（带令牌时需加 Authorization: Bearer <token>）：',
      tokenTitle: 'API 令牌（可选）',
      tokenHint: '当插件启用了 Bearer token（DSH_VARS_TOKEN 或 config.json）时，在这里填入同一个令牌；只保存在当前浏览器 localStorage，不会上传。',
      tokenPlaceholder: '留空表示不使用令牌',
      saveToken: '保存令牌',
      clearToken: '清除令牌',
      tokenSaved: '令牌已保存到本机浏览器',
      tokenCleared: '令牌已清除',
      wsConnected: '实时同步：已连接',
      wsDisconnected: '实时同步：未连接（可手动刷新）',
      createTitle: '新建变量',
      name: '变量名',
      namePlaceholder: '例如 demo_var',
      type: '类型',
      initialValue: '初始值',
      initialValuePlaceholder: '字符串直接填；数字如 42；布尔 true/false；JSON 合法文本',
      create: '创建变量',
      created: '变量已创建',
      listTitle: '已有变量',
      refresh: '刷新',
      empty: '还没有变量，先在上方创建一个。',
      loading: '正在读取变量…',
      edit: '修改值',
      save: '保存',
      cancel: '取消',
      remove: '删除',
      removed: '变量已删除',
      confirmRemove: '确定删除变量 {name} 吗？',
      updatedAt: '更新时间',
      value: '值',
      noValue: '（空）',
      saved: '变量值已更新',
      invalidRequest: '请求失败',
      nameHint: '字母或下划线开头，可包含字母、数字、_ . -，最长 64 个字符',
      loadingInfo: '正在读取本机地址…',
    }

    var en = {
      nav: 'Variables',
      title: 'Variables',
      subtitle: 'Create typed variables and read or modify them through local HTTP GET / POST requests. Values are stored in the local DSH data directory.',
      infoTitle: 'Local access',
      infoPort: 'DSH port',
      infoLoopback: 'Loopback',
      infoLan: 'LAN',
      infoToken: 'API token',
      tokenEnabled: 'enabled',
      tokenDisabled: 'disabled',
      infoHint: 'Use these addresses from scripts. The LAN address only exists when DSH listens beyond loopback; the variables API itself still only accepts loopback requests.',
      apiTitle: 'HTTP API',
      apiHint: 'Both GET and POST can modify values (add Authorization: Bearer <token> when a token is enabled):',
      tokenTitle: 'API token (optional)',
      tokenHint: 'When the plugin has a Bearer token (DSH_VARS_TOKEN or config.json), enter the same token here. It stays in this browser localStorage and is never uploaded anywhere else.',
      tokenPlaceholder: 'Leave empty to send no token',
      saveToken: 'Save token',
      clearToken: 'Clear token',
      tokenSaved: 'Token saved in this browser',
      tokenCleared: 'Token cleared',
      wsConnected: 'Live sync: connected',
      wsDisconnected: 'Live sync: disconnected (refresh manually)',
      createTitle: 'New variable',
      name: 'Name',
      namePlaceholder: 'e.g. demo_var',
      type: 'Type',
      initialValue: 'Initial value',
      initialValuePlaceholder: 'String as-is; number e.g. 42; boolean true/false; JSON text',
      create: 'Create variable',
      created: 'Variable created',
      listTitle: 'Variables',
      refresh: 'Refresh',
      empty: 'No variables yet. Create one above.',
      loading: 'Loading variables…',
      edit: 'Edit value',
      save: 'Save',
      cancel: 'Cancel',
      remove: 'Delete',
      removed: 'Variable deleted',
      confirmRemove: 'Delete variable {name}?',
      updatedAt: 'Updated',
      value: 'Value',
      noValue: '(empty)',
      saved: 'Variable updated',
      invalidRequest: 'Request failed',
      nameHint: 'Start with a letter or underscore; letters, digits, _ . - allowed; max 64 characters',
      loadingInfo: 'Loading local addresses…',
    }

    /** Columns shared by the list header and every row, so name/type line up. */
    var COLUMNS = 'minmax(140px, 1.1fr) 84px minmax(160px, 1.8fr) 168px 168px'

    var UI = {
      section: { display: 'flex', flexDirection: 'column', gap: '14px' },
      title: { margin: '0 0 2px', fontSize: '18px' },
      subtitle: { margin: '0', color: 'var(--dsh-text-secondary, #6b7280)', fontSize: '13px', lineHeight: 1.6 },
      card: { border: '1px solid var(--dsh-border, #e5e7eb)', borderRadius: '12px', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '10px' },
      cardHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' },
      cardTitle: { fontWeight: 600, fontSize: '14px' },
      muted: { color: 'var(--dsh-text-secondary, #6b7280)', fontSize: '12px', lineHeight: 1.6 },
      field: { display: 'flex', flexDirection: 'column', gap: '4px' },
      label: { fontSize: '12px', fontWeight: 600 },
      input: { padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--dsh-border, #d1d5db)', background: 'transparent', color: 'inherit', fontSize: '13px', width: '100%', boxSizing: 'border-box' },
      select: { padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--dsh-border, #d1d5db)', background: 'transparent', color: 'inherit', fontSize: '13px', width: '100%', boxSizing: 'border-box' },
      createGrid: { display: 'grid', gridTemplateColumns: 'minmax(150px, 1fr) 120px minmax(180px, 1.8fr) auto', gap: '10px', alignItems: 'end' },
      createHint: { gridColumn: '1 / span 3' },
      listWrap: { overflowX: 'auto' },
      listGrid: { display: 'grid', gridTemplateColumns: COLUMNS, gap: '0', minWidth: '720px' },
      headCell: { padding: '6px 8px', fontSize: '11px', fontWeight: 700, color: 'var(--dsh-text-secondary, #6b7280)', textTransform: 'uppercase', letterSpacing: '0.02em' },
      cell: { padding: '8px', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 },
      row: { borderTop: '1px solid var(--dsh-border, #e5e7eb)' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: '12px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' },
      badge: { fontSize: '11px', padding: '2px 8px', borderRadius: '999px', background: 'rgba(77,107,254,0.12)', color: '#4d6bfe', fontWeight: 600, whiteSpace: 'nowrap' },
      okBadge: { fontSize: '11px', padding: '2px 8px', borderRadius: '999px', background: 'rgba(34,197,94,0.14)', color: '#15803d', fontWeight: 600, whiteSpace: 'nowrap' },
      warnBadge: { fontSize: '11px', padding: '2px 8px', borderRadius: '999px', background: 'rgba(245,158,11,0.16)', color: '#b45309', fontWeight: 600, whiteSpace: 'nowrap' },
      primary: { padding: '8px 16px', borderRadius: '8px', border: 0, background: '#4d6bfe', color: '#fff', fontWeight: 600, cursor: 'pointer', fontSize: '13px' },
      secondary: { padding: '7px 12px', borderRadius: '8px', border: '1px solid var(--dsh-border, #d1d5db)', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: '12px' },
      danger: { padding: '7px 12px', borderRadius: '8px', border: '1px solid #ef4444', background: 'transparent', color: '#ef4444', cursor: 'pointer', fontSize: '12px' },
      error: { padding: '10px 12px', borderRadius: '8px', border: '1px solid #fca5a5', background: 'rgba(239,68,68,0.08)', color: '#b91c1c', fontSize: '13px', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
      notice: { padding: '10px 12px', borderRadius: '8px', border: '1px solid #86efac', background: 'rgba(34,197,94,0.08)', color: '#15803d', fontSize: '13px' },
      code: { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: '12px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', padding: '10px', borderRadius: '8px', background: 'rgba(127,127,127,0.08)', margin: 0 },
      infoRow: { display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap', fontSize: '13px' },
      infoLabel: { width: '96px', color: 'var(--dsh-text-secondary, #6b7280)', fontSize: '12px' },
      buttonRow: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' },
    }

    /** Read the optional token from localStorage (never sent anywhere else). */
    function storedToken() {
      try {
        return localStorage.getItem(TOKEN_KEY) || ''
      } catch {
        return ''
      }
    }

    /** Persist the optional token in this browser only. */
    function persistToken(value) {
      try {
        if (value === '') localStorage.removeItem(TOKEN_KEY)
        else localStorage.setItem(TOKEN_KEY, value)
      } catch {
        // private mode / disabled storage: the token still works for this page
      }
    }

    /**
     * Fetch JSON from the host API and unwrap the `{ok, value}` envelope.
     * @param {string} method HTTP method.
     * @param {string} path path below API_PATH.
     * @param {unknown} [body] JSON body.
     * @returns {Promise<any>} unwrapped value.
     */
    async function request(method, path, body) {
      var headers = { accept: 'application/json' }
      var token = storedToken()
      if (token !== '') headers.authorization = 'Bearer ' + token
      var init = { method: method, headers: headers, credentials: 'same-origin' }
      if (body !== undefined) {
        headers['content-type'] = 'application/json'
        init.body = JSON.stringify(body)
      }
      var response = await fetch(API_PATH + path, init)
      var text = await response.text()
      var parsed
      try {
        parsed = text === '' ? undefined : JSON.parse(text)
      } catch {
        throw new Error('接口返回了无法解析的响应（HTTP ' + response.status + '）')
      }
      if (parsed && parsed.ok === true) return parsed.value
      var message = parsed && parsed.error && typeof parsed.error.message === 'string' ? parsed.error.message : 'HTTP ' + response.status
      var error = new Error(message)
      error.code = parsed && parsed.error && parsed.error.code
      throw error
    }

    /** @returns {object} API facade used by the section. */
    function createApi() {
      return {
        list: function () { return request('GET', '/variables') },
        all: function () { return request('GET', '/all') },
        info: function () { return request('GET', '/info') },
        get: function (name) { return request('GET', '/variables/' + encodeURIComponent(name)) },
        create: function (payload) { return request('POST', '/variables', payload) },
        set: function (name, value) { return request('POST', '/variables/' + encodeURIComponent(name), { value: value }) },
        remove: function (name) { return request('DELETE', '/variables/' + encodeURIComponent(name)) },
      }
    }

    /** Render one value as compact text. */
    function formatValue(variable) {
      if (variable.value === undefined) return ''
      if (variable.type === 'json') return JSON.stringify(variable.value)
      return String(variable.value)
    }

    /** Format an ISO timestamp for the list. */
    function formatTime(iso) {
      if (typeof iso !== 'string' || iso === '') return ''
      var date = new Date(iso)
      return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
    }

    /** The 设置 → 变量 section. */
    function Section(props) {
      var t = typeof props.t === 'function' ? props.t : function (key) { return zh[key] !== undefined ? zh[key] : key }
      var api = props.api || createApi()

      var listState = React.useState([])
      var variables = listState[0]
      var setVariables = listState[1]
      var infoState = React.useState(null)
      var info = infoState[0]
      var setInfo = infoState[1]
      var tokenState = React.useState(storedToken())
      var token = tokenState[0]
      var setToken = tokenState[1]
      var tokenDraftState = React.useState(storedToken())
      var tokenDraft = tokenDraftState[0]
      var setTokenDraft = tokenDraftState[1]
      var loadingState = React.useState(true)
      var loading = loadingState[0]
      var setLoading = loadingState[1]
      var wsState = React.useState(false)
      var wsConnected = wsState[0]
      var setWsConnected = wsState[1]
      var errorState = React.useState(null)
      var error = errorState[0]
      var setError = errorState[1]
      var noticeState = React.useState('')
      var notice = noticeState[0]
      var setNotice = noticeState[1]
      var busyState = React.useState('')
      var busy = busyState[0]
      var setBusy = busyState[1]
      var nameState = React.useState('')
      var name = nameState[0]
      var setName = nameState[1]
      var typeState = React.useState('string')
      var type = typeState[0]
      var setType = typeState[1]
      var valueState = React.useState('')
      var value = valueState[0]
      var setValue = valueState[1]
      var editingState = React.useState(null)
      var editing = editingState[0]
      var setEditing = editingState[1]
      var editValueState = React.useState('')
      var editValue = editValueState[0]
      var setEditValue = editValueState[1]
      var wsRef = React.useRef(null)
      var refreshTimerRef = React.useRef(null)

      function reportFailure(failure) {
        setError({ code: failure && failure.code, message: failure && failure.message ? failure.message : t('invalidRequest') })
      }

      async function loadInfo() {
        try {
          setInfo(await api.info())
        } catch (failure) {
          // info is informational only
        }
      }

      async function refresh() {
        setLoading(true)
        setError(null)
        try {
          setVariables(await api.list())
        } catch (failure) {
          reportFailure(failure)
        } finally {
          setLoading(false)
        }
      }

      React.useEffect(function () {
        void loadInfo()
        void refresh()
      }, [])

      function scheduleRefresh() {
        if (refreshTimerRef.current !== null) return
        refreshTimerRef.current = setTimeout(function () {
          refreshTimerRef.current = null
          void refresh()
        }, 150)
      }

      // Live change feed: one WebSocket, reconnect with a short backoff.
      React.useEffect(function () {
        var disposed = false
        var retry = null
        var attempt = 0
        function connect() {
          if (disposed) return
          var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
          var query = storedToken() === '' ? '' : '?token=' + encodeURIComponent(storedToken())
          var socket
          try {
            socket = new WebSocket(protocol + '//' + location.host + API_PATH + '/events' + query)
          } catch {
            setWsConnected(false)
            return
          }
          wsRef.current = socket
          socket.onopen = function () {
            attempt = 0
            setWsConnected(true)
          }
          socket.onmessage = function (event) {
            try {
              var payload = JSON.parse(String(event.data))
              if (payload && payload.type === 'change') scheduleRefresh()
            } catch {
              // ignore malformed frames
            }
          }
          socket.onclose = function () {
            setWsConnected(false)
            wsRef.current = null
            if (disposed) return
            attempt += 1
            var delay = Math.min(1000 * attempt, 10_000)
            retry = setTimeout(connect, delay)
          }
          socket.onerror = function () {
            setWsConnected(false)
          }
        }
        connect()
        return function () {
          disposed = true
          if (retry !== null) clearTimeout(retry)
          if (refreshTimerRef.current !== null) clearTimeout(refreshTimerRef.current)
          var socket = wsRef.current
          wsRef.current = null
          try {
            socket?.close()
          } catch {
            // already closed
          }
        }
      }, [token])

      function run(label, action) {
        setBusy(label)
        setError(null)
        setNotice('')
        return Promise.resolve().then(action).catch(reportFailure).finally(function () { setBusy('') })
      }

      function onCreate() {
        void run('create', async function () {
          var created = await api.create({ name: name, type: type, initialValue: value })
          setName('')
          setValue('')
          setNotice(t('created') + '：' + created.name)
          await refresh()
        })
      }

      function onStartEdit(variable) {
        setEditing(variable.name)
        setEditValue(formatValue(variable))
      }

      function onSaveEdit(variable) {
        void run('save:' + variable.name, async function () {
          await api.set(variable.name, editValue)
          setEditing(null)
          setEditValue('')
          setNotice(t('saved') + '：' + variable.name)
          await refresh()
        })
      }

      function onRemove(variable) {
        var message = String(t('confirmRemove')).replace('{name}', variable.name)
        var ok = true
        try {
          ok = typeof window.confirm === 'function' ? window.confirm(message) : true
        } catch {
          ok = true
        }
        if (!ok) return
        void run('remove:' + variable.name, async function () {
          await api.remove(variable.name)
          setNotice(t('removed') + '：' + variable.name)
          await refresh()
        })
      }

      function onSaveToken() {
        var next = tokenDraft.trim()
        persistToken(next)
        setToken(next)
        if (next === '') setNotice(t('tokenCleared'))
        else setNotice(t('tokenSaved'))
        void refresh()
        void loadInfo()
      }

      var base = typeof location !== 'undefined' ? String(location.origin) + API_PATH : API_PATH
      var port = info && typeof info.port === 'number' ? info.port : undefined
      var lan = info && Array.isArray(info.addresses) ? info.addresses : []
      var tokenRequired = Boolean(info && info.tokenRequired === true)
      var children = [
        h('h2', { style: UI.title, key: 'title' }, t('title')),
        h('p', { style: UI.subtitle, key: 'subtitle' }, t('subtitle')),
      ]

      if (error) {
        children.push(h('div', { style: UI.error, key: 'error' },
          h('span', null, '⚠ ' + error.message),
          error.code ? h('span', { style: UI.badge }, error.code) : null,
          h('button', { style: UI.secondary, onClick: function () { setError(null) } }, t('cancel')),
        ))
      }
      if (notice !== '') children.push(h('div', { style: UI.notice, key: 'notice' }, notice))

      // ---- local address / port -------------------------------------------
      children.push(h('div', { style: UI.card, key: 'info' },
        h('div', { style: UI.cardHead },
          h('div', { style: UI.cardTitle }, t('infoTitle')),
          wsConnected ? h('span', { style: UI.okBadge }, t('wsConnected')) : h('span', { style: UI.warnBadge }, t('wsDisconnected')),
        ),
        info === null
          ? h('div', { style: UI.muted }, t('loadingInfo'))
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
            h('div', { style: UI.infoRow },
              h('span', { style: UI.infoLabel }, t('infoPort')),
              h('span', { style: UI.mono }, port === undefined ? '?' : String(port)),
            ),
            h('div', { style: UI.infoRow },
              h('span', { style: UI.infoLabel }, t('infoLoopback')),
              h('span', { style: UI.mono }, info.loopback ? info.loopback + API_PATH : base),
            ),
            lan.length === 0
              ? null
              : h('div', { style: UI.infoRow },
                h('span', { style: UI.infoLabel }, t('infoLan')),
                h('span', { style: UI.mono }, lan.map(function (item) { return 'http://' + item.address + (port ? ':' + port : '') + API_PATH }).join('   ')),
              ),
            h('div', { style: UI.infoRow },
              h('span', { style: UI.infoLabel }, t('infoToken')),
              tokenRequired ? h('span', { style: UI.okBadge }, t('tokenEnabled')) : h('span', { style: UI.warnBadge }, t('tokenDisabled')),
            ),
            h('div', { style: UI.muted }, t('infoHint')),
          ),
      ))

      // ---- API examples ----------------------------------------------------
      children.push(h('div', { style: UI.card, key: 'api' },
        h('div', { style: UI.cardTitle }, t('apiTitle')),
        h('div', { style: UI.muted }, t('apiHint')),
        h('pre', { style: UI.code },
          'GET  ' + base + '/all\n' +
          'GET  ' + base + '/set?name=demo&value=42\n' +
          'POST ' + base + '/variables   {"name":"demo","type":"number","initialValue":42}\n' +
          'POST ' + base + '/variables/demo   {"value":7}\n' +
          'DEL  ' + base + '/variables/demo\n' +
          'WS   ws://' + (typeof location !== 'undefined' ? location.host : '<host>') + API_PATH + '/events'),
      ))

      // ---- optional token --------------------------------------------------
      children.push(h('div', { style: UI.card, key: 'token' },
        h('div', { style: UI.cardTitle }, t('tokenTitle')),
        h('div', { style: UI.muted }, t('tokenHint')),
        h('div', { style: UI.buttonRow },
          h('input', {
            style: Object.assign({}, UI.input, { flex: '1 1 260px' }),
            type: 'password',
            autoComplete: 'off',
            spellCheck: false,
            placeholder: t('tokenPlaceholder'),
            value: tokenDraft,
            onChange: function (event) { setTokenDraft(event.target.value) },
          }),
          h('button', { style: UI.primary, onClick: onSaveToken }, t('saveToken')),
          h('button', { style: UI.secondary, onClick: function () { setTokenDraft(''); persistToken(''); setToken(''); setNotice(t('tokenCleared')); void refresh() } }, t('clearToken')),
        ),
      ))

      // ---- create form (aligned grid) -------------------------------------
      children.push(h('div', { style: UI.card, key: 'create' },
        h('div', { style: UI.cardTitle }, t('createTitle')),
        h('div', { style: UI.createGrid },
          h('div', { style: UI.field },
            h('label', { style: UI.label }, t('name')),
            h('input', {
              style: UI.input,
              value: name,
              placeholder: t('namePlaceholder'),
              onChange: function (event) { setName(event.target.value) },
            }),
          ),
          h('div', { style: UI.field },
            h('label', { style: UI.label }, t('type')),
            h('select', { style: UI.select, value: type, onChange: function (event) { setType(event.target.value) } },
              TYPES.map(function (item) { return h('option', { key: item, value: item }, item) }),
            ),
          ),
          h('div', { style: UI.field },
            h('label', { style: UI.label }, t('initialValue')),
            h('input', {
              style: UI.input,
              value: value,
              placeholder: t('initialValuePlaceholder'),
              onChange: function (event) { setValue(event.target.value) },
            }),
          ),
          h('div', null,
            h('button', { style: UI.primary, disabled: busy !== '', onClick: onCreate }, busy === 'create' ? '…' : t('create')),
          ),
        ),
        h('div', { style: Object.assign({}, UI.muted, UI.createHint) }, t('nameHint')),
      ))

      // ---- variable list (table-like grid) --------------------------------
      var list = [h('div', { style: UI.cardHead, key: 'head' },
        h('div', { style: UI.cardTitle }, t('listTitle')),
        h('div', { style: UI.buttonRow },
          h('button', { style: UI.secondary, disabled: loading, onClick: function () { void refresh() } }, t('refresh')),
        ),
      )]

      if (loading) {
        list.push(h('div', { style: UI.muted, key: 'loading' }, t('loading')))
      } else if (variables.length === 0) {
        list.push(h('div', { style: UI.muted, key: 'empty' }, t('empty')))
      } else {
        var grid = [
          h('div', { style: UI.headCell, key: 'h-name' }, t('name')),
          h('div', { style: UI.headCell, key: 'h-type' }, t('type')),
          h('div', { style: UI.headCell, key: 'h-value' }, t('value')),
          h('div', { style: UI.headCell, key: 'h-time' }, t('updatedAt')),
          h('div', { style: UI.headCell, key: 'h-actions' }, ''),
        ]
        variables.forEach(function (variable) {
          var isEditing = editing === variable.name
          grid.push(h('div', { style: Object.assign({}, UI.row, UI.cell), key: 'n:' + variable.name }, h('span', { style: UI.mono }, variable.name)))
          grid.push(h('div', { style: Object.assign({}, UI.row, UI.cell), key: 't:' + variable.name }, h('span', { style: UI.badge }, variable.type)))
          grid.push(h('div', { style: Object.assign({}, UI.row, UI.cell), key: 'v:' + variable.name },
            isEditing
              ? h('input', {
                style: UI.input,
                value: editValue,
                disabled: busy !== '',
                onChange: function (event) { setEditValue(event.target.value) },
              })
              : h('span', { style: UI.mono }, formatValue(variable) === '' ? t('noValue') : formatValue(variable)),
          ))
          grid.push(h('div', { style: Object.assign({}, UI.row, UI.cell), key: 'u:' + variable.name },
            h('span', { style: UI.muted }, formatTime(variable.updatedAt)),
          ))
          grid.push(h('div', { style: Object.assign({}, UI.row, UI.cell), key: 'a:' + variable.name },
            isEditing
              ? h('div', { style: UI.buttonRow },
                h('button', { style: UI.primary, disabled: busy !== '', onClick: function () { void run('save:' + variable.name, async function () { await api.set(variable.name, editValue); setEditing(null); setEditValue(''); setNotice(t('saved') + '：' + variable.name); await refresh() }) } }, t('save')),
                h('button', { style: UI.secondary, disabled: busy !== '', onClick: function () { setEditing(null); setEditValue('') } }, t('cancel')),
              )
              : h('div', { style: UI.buttonRow },
                h('button', { style: UI.secondary, disabled: busy !== '', onClick: function () { onStartEdit(variable) } }, t('edit')),
                h('button', { style: UI.danger, disabled: busy !== '', onClick: function () { onRemove(variable) } }, t('remove')),
              ),
          ))
        })
        list.push(h('div', { style: UI.listWrap, key: 'wrap' }, h('div', { style: UI.listGrid }, grid)))
      }
      children.push(h('div', { style: UI.card, key: 'list' }, list))

      return h('div', { style: UI.section }, children)
    }

    /** Register an effect with a fallback for hosts without `ctx.effect`. */
    function addEffect(ctx, callback, label) {
      if (ctx && typeof ctx.effect === 'function') {
        try {
          ctx.effect(callback, label)
          return
        } catch {
          // fall through
        }
      }
      try {
        callback()
      } catch {
        // a missing service must never break the page
      }
    }

    /**
     * Mount the locale dictionary and the settings section.
     * @param {any} ctx browser plugin context.
     * @returns {void}
     */
    function apply(ctx) {
      addEffect(ctx, function () {
        if (!ctx || !ctx.locale || typeof ctx.locale.register !== 'function') return function () {}
        return ctx.locale.register(NS, { zh: zh, en: en })
      }, 'dsh-vars: locale')

      var slots = ctx ? ctx.slots : undefined
      if (slots && typeof slots.inject === 'function' && typeof slots.register === 'function') {
        slots.inject('settings.section', function () {
          return slots.register({
            name: 'settings.section',
            id: 'dsh-vars',
            order: 3,
            label: function () { return zh.nav },
            locale: NS,
            inject: function () { return { api: createApi() } },
          }, Section)
        })
      }
    }

    module.exports.inject = ['slots', 'locale']
    module.exports.apply = apply
    return module.exports
  },
})
