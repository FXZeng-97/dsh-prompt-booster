# Security Policy

## 信任模型（Threat Model）

`prompt-booster` 是一个**本地 DSH profile 插件**：Host 侧在 DSH 自己的 Web server 上注册
`/prompt-booster/*` 路由，浏览器侧只在 DSH 页面里渲染按钮。它不对外提供网络服务，
也不保存用户草稿。安全边界按「本机可信、浏览器页面不可信」设计。

### 已实施的控制

| 控制 | 行为 |
|---|---|
| 仅回环 | 严格校验 IP 字面量：只接受 `127/8`、`::1`、`::ffff:127.x`；其它来源 `403 not-loopback` |
| Host + 端口 | `Host` 头必须存在、是回环名（`localhost`/回环 IP），且端口等于 Web server 实际监听端口；否则 `403 host-mismatch`（防 DNS rebinding） |
| 拒绝跨站 | `sec-fetch-site: cross-site` → `403 cross-site` |
| Origin + 页面 token | 无 Origin / `null` / 桌面壳自定义协议（`dsh-app://`）放行；`http(s)` 来源必须与 Host 同源**且**携带页面 token（`x-pb-token`） |
| 页面 token 注入 | 每次激活生成随机 token，通过 `webserver/index-inject` 注入页面全局 `__PROMPT_BOOSTER_TOKEN__`；token 不写日志、不进仓库，请求头以常量时间比较 |
| 无通配 CORS | 响应不再返回 `Access-Control-Allow-Origin: *`；仅对可信来源回显 |
| 仅 JSON | `POST` 必须 `application/json`，否则 `415`；配合来源校验阻断浏览器跨站简单请求 |
| 限流 / 并发 | `/enhance` 默认 20 次/分钟/IP、并发 2；其它路由 120 次/分钟/IP；超出 `429 + retryAfterMs` |
| 超时 | 请求体读取总超时 15s；模型调用有硬 deadline（逐 chunk 超时 + abort）；模型元数据查询 5s 超时；git 查询 4s |
| 项目路径授权 | 项目目录只取 Host 会话元数据 `session.header.cwd`；客户端 cwd 默认忽略（`allowClientProject` 仅测试） |
| 文件读取限制 | 项目目录先 `realpath`；读取文件用 `lstat` 拒绝符号链接，`realpath` 必须仍在项目目录内，单文件 ≤1MB |
| 上下文最小化 | 只读顶层结构（≤12 项，跳过符号链接）、包管理文件（≤12 依赖）、`AGENTS.md` 等（≤350 字）、git 分支；不读任意文件 |
| 最近对话不越权 | 最近对话由浏览器侧从当前页面 Chat 视图提取后传入（≤4 条/800 字）；**Host 不读取会话历史**，不凭 sessionId 读取他人会话 |
| 诊断脱敏 | 只记录白名单事件与结构化字段（字符数/布尔值/枚举），不记录草稿、上下文、错误原文；超过 2MB 自动轮转 |
| 输出长度度量 | 按输入长度计算 `lengthCap`，响应返回 `lengthOver`；仅度量不强制截断（提示词软约束） |
| 回退地址校验 | 浏览器回退请求只允许本机回环 `http(s)` 或桌面壳自定义协议 |
| 响应头 | `cache-control: no-store`、`x-content-type-options: nosniff` |

### 数据流与隐私

增强请求会把 **草稿 + 最近 2 轮对话预览 + 受限项目上下文** 发送给当前 profile 配置的模型提供方
（默认由安装者的 `agentDefaultModel` 决定），受该提供方数据政策约束。
**不要在这类草稿里放密钥或敏感凭据。**

### 安全相关配置

| 配置项 | 默认 | 说明 |
|---|---|---|
| `rateLimitPerMinute` | `20` | `/enhance` 每分钟每 IP 上限（1~120） |
| `maxConcurrentEnhance` | `2` | `/enhance` 并发上限（1~8） |
| `allowClientProject` | `false` | 允许客户端传入 `cwd`，**仅测试用**；默认只信会话元数据 |

## 已知残余风险

1. **本机进程可调用**：回环路由没有用户级鉴权，本机其它程序可调用（与多数本地开发工具一致）；
   `http(s)` 浏览器来源有页面 token，但无 Origin 的本机调用不受 token 约束。
   如需更强隔离，请在独立低权限账号下运行 DSH 或停用插件。
2. **提示注入**：`AGENTS.md` 等项目文件与会话预览会进入模型输入，内容可能试图影响增强结果；
   增强结果只回填到输入框、发送前需用户确认。
3. **模型提供方**：草稿与上下文由安装者配置的模型服务商处理，插件本身不保存正文。
4. **长度软约束**：模型偶尔略长，Host 只度量（`lengthOver`），不强制截断。
5. **平台兼容性**：浏览器模式与桌面壳的页面 token 注入路径不同；桌面壳无 Origin 时依赖
   Host/端口与回环校验。安装/升级/卸载的运行时兼容性未在所有 DSH 版本上逐一验证。

## 安全回归测试

```bash
node tests/security.test.mjs
```

覆盖：严格回环判断、Host/端口校验、页面 token、跨站拒绝、诊断字段白名单、符号链接防护、
最近对话输入校验、输出长度上限计算。

## 报告漏洞

请在仓库开 issue（避免公开敏感细节），或直接联系仓库维护者。修复前请勿公开利用细节。
