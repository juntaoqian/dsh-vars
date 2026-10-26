# dsh-vars

DeepSeek Harness（DSH）变量插件：**新建带类型和初始值的变量**，通过**本机 HTTP GET / POST** 读写，并支持 **WebSocket 变化订阅**、可选 **Bearer token**、本机 IP/端口展示。

- 变量类型：`string` / `number` / `boolean` / `json`
- 修改值：`GET /set` 查询参数，或 `POST /variables/<name>` JSON body
- 获取全部变量：`GET /all`（等价于 `GET /variables`）
- 实时变化事件：`ws://127.0.0.1:<DSH_PORT>/dsh-vars/api/events`
- 可选 Bearer token：保护所有数据接口（`/health`、`/info` 除外）
- 设置页「设置 → 变量」：新建（名称/类型/初始值对齐）、修改、删除、实时刷新、刷新按钮，顶部显示本机 IP 与端口
- 数据：`~/.dsh/plugins/dsh-vars/variables.json`（0600、原子写入）
- 零 npm 运行时依赖、无构建步骤

仓库：<https://github.com/juntaoqian/dsh-vars>

## 安装

### 一句话让 AI 安装

```text
安装 DSH 插件：https://github.com/juntaoqian/dsh-vars，进目录执行 `node scripts/install.mjs --profile desktop`，然后完全退出并重开 DeepSeek Harness，确认「设置 → 变量」出现，并告诉我怎么用 curl 修改变量。
```

### 手动安装

```powershell
git clone https://github.com/juntaoqian/dsh-vars.git
cd dsh-vars
node scripts/install.mjs --profile desktop
# 完全退出并重新打开 DeepSeek Harness
```

验证安装：

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\DeepSeek Harness.exe" scripts/validate-profile.mjs --profile desktop
```

安装/更新后需要**重启 DSH**（host 侧代码在进程启动时加载）。

## 使用

打开 **设置 → 变量**：

1. 顶部显示当前 **DSH 端口、本机地址、局域网地址、API 令牌状态、实时同步状态**；
2. 新建变量：填写名称、选择类型、填写初始值，点「创建变量」；
3. 列表按「名称 / 类型 / 值 / 更新时间 / 操作」对齐显示；
4. 支持「修改值」「删除」「刷新」；其他程序修改变量时，页面会通过 WebSocket **自动刷新**（失败时可手动点刷新）。

## HTTP API

DSH 端口见设置页顶部或 DSH 窗口地址；下文用 `http://127.0.0.1:<DSH_PORT>`，前缀 `/dsh-vars/api`。

响应统一为：

```json
{ "ok": true, "value": ... }
{ "ok": false, "error": { "code": "...", "message": "..." } }
```

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/dsh-vars/api/health` | 健康检查（公开） |
| GET | `/dsh-vars/api/info` | 本机端口、地址、`tokenRequired`（公开） |
| GET | `/dsh-vars/api/variables` | 列出全部变量 |
| **GET** | `/dsh-vars/api/all` | **获取当前所有变量**（与 `/variables` 相同） |
| POST | `/dsh-vars/api/variables` | 新建 `{ name, type, initialValue? }` |
| GET | `/dsh-vars/api/variables/<name>` | 读取单个变量 |
| POST / PUT | `/dsh-vars/api/variables/<name>` | 修改值 `{ value }` |
| DELETE | `/dsh-vars/api/variables/<name>` | 删除变量 |
| **GET** | `/dsh-vars/api/set?name=<name>&value=<value>` | **用 GET 修改值** |
| POST | `/dsh-vars/api/set` | 用 POST 修改值 `{ name, value }` |

### 示例

```powershell
$base = 'http://127.0.0.1:<DSH_PORT>/dsh-vars/api'

# 新建
Invoke-RestMethod "$base/variables" -Method Post -ContentType 'application/json' `
  -Body (@{ name='demo'; type='number'; initialValue=1 } | ConvertTo-Json)

# 获取全部变量
Invoke-RestMethod "$base/all"

# GET 修改
Invoke-RestMethod "$base/set?name=demo&value=42"

# POST 修改
Invoke-RestMethod "$base/variables/demo" -Method Post -ContentType 'application/json' `
  -Body (@{ value=7 } | ConvertTo-Json)

# 读取 / 删除
Invoke-RestMethod "$base/variables/demo"
Invoke-RestMethod "$base/variables/demo" -Method Delete
```

浏览器直接访问也可以（GET 改值）：

```text
http://127.0.0.1:<DSH_PORT>/dsh-vars/api/set?name=demo&value=42
```

## 可选 Bearer token

三选一启用（读取优先级从上到下）：

1. 插件配置行里的 `token`；
2. 环境变量 `DSH_VARS_TOKEN`（在启动 DSH 前设置）；
3. `~/.dsh/plugins/dsh-vars/config.json`：

```json
{ "token": "your-token" }
```

启用后：

- 所有数据接口都要带 `Authorization: Bearer <token>`；
- 浏览器 WebSocket 无法自定义 header，所以订阅地址支持 `?token=<token>`；
- `/health`、`/info` 始终公开，便于脚本发现端口与是否需要 token；
- 设置页「API 令牌」输入框填入同一个 token（只存当前浏览器 `localStorage`），之后页面的 HTTP 与 WebSocket 都会自动带上。

```powershell
$base = 'http://127.0.0.1:<DSH_PORT>/dsh-vars/api'
$headers = @{ Authorization = 'Bearer your-token' }
Invoke-RestMethod "$base/all" -Headers $headers
Invoke-RestMethod "$base/set?name=demo&value=42" -Headers $headers
```

## WebSocket 变化订阅

```js
const ws = new WebSocket('ws://127.0.0.1:<DSH_PORT>/dsh-vars/api/events')
ws.onmessage = (event) => {
  const message = JSON.parse(event.data)
  // { type: 'ready', count, tokenRequired }
  // { type: 'change', event: { type: 'created'|'updated'|'deleted', name }, at }
  console.log(message)
}
```

启用 token 时：`ws://127.0.0.1:<DSH_PORT>/dsh-vars/api/events?token=<token>`。

- 升级路径：`/dsh-vars/api/events`（DSH `registerUpgrade` 注册，仅本机）
- 服务端每 25 秒发送 ping 心跳；页面关闭/插件卸载时自动清理订阅
- 普通 HTTP GET 该路径返回 426 `upgrade-required`

## 类型规则

| 类型 | 默认值 | 接受的值 | 非法 |
|---|---|---|---|
| `string` | `""` | 字符串（≤64 KiB） | 400 `invalid-value` |
| `number` | `0` | 有限数字 / 数字字符串 | 400 `invalid-value` |
| `boolean` | `false` | `true` / `false`（或字符串 `"true"`/`"false"`） | 400 `invalid-value` |
| `json` | `null` | 任意 JSON 值或合法 JSON 文本（≤64 KiB） | 400 `invalid-value` |

变量名：字母或下划线开头，可含字母、数字、`_ . -`，≤64；重名 409 `conflict`；不存在 404 `not-found`；上限 200 个。

## 数据与安全

- 数据文件：`~/.dsh/plugins/dsh-vars/variables.json`，权限 `0600`，临时文件 + rename 原子写；
- 损坏文件自动备份为 `variables.json.corrupt-<时间>` 并以空表启动；
- 变量接口只接受 loopback（`127.0.0.1` / `::1`）；
- token 不会写入日志；设置页里的 token 只存在浏览器 localStorage；
- 多进程并发写同一文件没有跨进程锁（同一 DSH 实例内已串行化）。

## 卸载

```powershell
node scripts/install.mjs --profile desktop --uninstall
Remove-Item "$env:USERPROFILE\.dsh\plugins\dsh-vars" -Recurse -Force   # 可选：删数据
```

## 开发与测试

```powershell
node --test
```

22 个测试覆盖：存储（类型校验、持久化、损坏恢复、并发串行化、订阅事件）、HTTP API（CRUD、GET/POST 修改、`/all`、`/info`、Bearer token、错误码）、WebSocket 握手与变化推送、client bundle 注册、host 挂载。

```
lib/
  store.js    类型化变量存储 + 订阅
  api.js      HTTP 路由、Bearer token、/info
  ws.js       WebSocket 升级、变化推送
  index.js    DSH host 挂载（HTTP + upgrade）
  client.js   设置页（对齐布局、本机地址、token、实时刷新）
test/
scripts/
```

## License

MIT
