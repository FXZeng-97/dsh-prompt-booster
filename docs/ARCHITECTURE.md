# 架构与实现

## 安装结构

| 部分 | 文件 | 作用 |
|---|---|---|
| Bundle manifest | `package.json` | `dsh.bundle.patch` + `dsh.client`（web，immediately） |
| Patch | `cordis.patch.yml` | 插入 host 行 `prompt-booster` |
| Host 半边 | `index.js` | 注册 `/prompt-booster` 路由；调用 `ctx.llm.stream` 改写 |
| Client 半边 | `client.js` | 在 `conversation.input.right` 注册「增强」控件 |
| 显示元数据 | `locale/*.json`、`icon.svg` | 插件管理/设置里的标题、描述、图标 |

profile 级 bundle：装进 profile 后对所有会话生效，重启后仍在。

## Host 路由

路由注册在 DSH Web server 上（`/prompt-booster` 前缀，本地回环，浏览器同源访问）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/prompt-booster/health` | 返回 `{ok, hasLlm, route, config}`；`route` 是实际使用的 provider/model |
| POST | `/prompt-booster/enhance` | 入参 `{text, base?, sessionId?, recent?, project?}`；返回 `{ok, text, provider, model, mode, variation, answerGuard, ms, usage, attempts}` |
| POST | `/prompt-booster/diag` | 浏览器侧诊断上报，写入 `data/diag.jsonl`（字段白名单） |

安全控制：仅回环、Host/端口校验、拒绝跨站、`http(s)` 来源需页面 token、仅 JSON、限流与并发上限。
详见 [../SECURITY.md](../SECURITY.md)。

## 增强执行

1. **连续纠正**：客户端在再次增强时带上原句 `base`；Host 按「原句最高权重 + 上一版候选」生成输入。
2. **快速路径**：最低 reasoning effort + `maxOutputTokens`，通常几秒返回。
3. **兜底重试**：若第一次没有产出文本（reasoning 吃满预算、空响应等），用最高 effort +
   `max(4096, maxOutputTokens)` 再试一次。
4. **答案守卫**：输出像"直接回答/展开步骤"时，做一次修正重试；不换通用模板。
5. **变化检测**：与上一版实质相同或只换词时，提高温度重试，要求改句式/结构。
6. **超时与上限**：请求体读取、模型调用、模型元数据查询、git 查询都有超时；请求体和输出长度有上限。

每次尝试的 effort/finish/耗时/输出字符数写入 `data/diag.jsonl` 的 `enhance-attempt`。

## 限流与资源

- `/enhance` 默认 20 次/分钟/IP，其它路由 120 次/分钟/IP；超出返回 `429` + `retryAfterMs`。
- `/enhance` 并发上限默认 2。
- 作用：防误触/脚本刷额度、防跨站放大、限制挂起请求、让成本可预期。
- 限流只保护本机插件入口，不影响模型服务商自己的限流。

## 手工验证

```powershell
Invoke-RestMethod "$env:DSH_WEB_URL/prompt-booster/health"

Invoke-RestMethod -Method Post "$env:DSH_WEB_URL/prompt-booster/enhance" `
  -ContentType 'application/json' `
  -Body (@{ text = '帮我把这个页面的按钮改好看点' } | ConvertTo-Json)
```

浏览器侧：装好后刷新页面（或等 HMR 自动加载），输入框工具栏出现「✨ 增强」；
`data/diag.jsonl` 里应出现一条 `kind=client-apply`。
