# 提示词增强（Prompt Booster）

DSH（DeepSeek Harness）profile 级插件：在 **每个会话 / 每个项目** 的聊天输入框工具栏里加一个
「✨ 增强」按钮。点一下，当前草稿会被模型重写成更完整、边界清晰、可直接执行的提示词，
回填到输入框；回填后旁边出现「撤销」，可以一键恢复增强前的文本。

这就是同类「增强提示词」工具常见的用法：**先增强、再发送**，增强结果始终可见、
可编辑、可撤销，不会被偷偷替换或直接发出。

```
┌─────────────────────────────────────────────────────┐
│  聊天输入框                                          │
│  ……草稿……                                    ✨ 增强 │  ← 按钮在发送按钮之前
└─────────────────────────────────────────────────────┘
        │ 点击
        ▼
   POST /prompt-booster/enhance  →  Host 用 ctx.llm 流式改写
        │
        ▼
   回填输入框（可编辑）  +  「撤销」
```

## 安装（分享给别人 / 从 GitHub）

这个仓库本身就是一个自包含的 DSH bundle 插件：纯 JS、无构建、无外部依赖。

1. 克隆到本地任意目录：

   ```bash
   git clone https://github.com/<你的账号>/dsh-prompt-booster.git
   ```

2. 在 DSH（desktop / web profile）里让 Agent 装它（或直接调用插件管理器的 `install_bundle`）：

   > 把 `/绝对路径/dsh-prompt-booster` 目录用 plugin_manager 的 install_bundle 装进当前 profile

   `install_bundle` 会自己写 profile 依赖、做链接、启用 bundle，不需要手动改 `package.json`。

3. 装好后输入框工具栏出现「✨ 增强」。没看到就刷新一次页面。
4. 卸载：`plugin_manager remove_bundle`，目标 `@local/prompt-booster`。

要求：DSH 桌面 / Web profile（`@deepseek-ai/dsh-base` + `dsh-web-app`），模型服务已配置
（增强默认跟随 `agentDefaultModel` 当前模型）。

## 发布到 npm（可选）

`@local/prompt-booster` 里的 `@local` 是本机安装用的作用域名。要发布到 npm，先改成唯一包名
（如 `dsh-prompt-booster` 或 `@你的账号/dsh-prompt-booster`），并**同步改三处**：

1. `package.json` 的 `"name"`；
2. `cordis.patch.yml` 里 insert 行的 `name:`；
3. `client.js` 里的 `id:`（浏览器 loader 的 id 必须等于包名）。

然后 `npm publish --access public`；使用者用 `plugin_manager install_bundle <包名>` 安装。

## 安装位置

| 部分 | 文件 | 作用 |
|---|---|---|
| Bundle manifest | `package.json` | `dsh.bundle.patch` + `dsh.client`（web，immediately） |
| Patch | `cordis.patch.yml` | 插入 host 行 `prompt-booster` |
| Host 半边 | `index.js` | 注册 `/prompt-booster` 路由；调用 `ctx.llm.stream` 改写 |
| Client 半边 | `client.js` | 在 `conversation.input.right` 注册「增强」控件 |
| 显示元数据 | `locale/zh.json`、`locale/en.json`、`icon.svg` | 插件管理/设置里的标题、描述、图标 |

它是 profile 级 bundle：装进 desktop profile 后对所有会话生效，重启后仍在。

## 接口（Host 路由）

路由直接注册在 DSH Web server 上（`/prompt-booster` 前缀，本地回环，浏览器同源访问）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/prompt-booster/health` | 返回 `{ok, hasLlm, route, config}`；`route` 是实际使用的 provider/model |
| POST | `/prompt-booster/enhance` | 入参 `{text, locale?}`；返回 `{ok, text, provider, model, ms, usage, attempts}` |
| POST | `/prompt-booster/diag` | 浏览器侧诊断上报，写入 `data/diag.jsonl` |

## 可调配置

在 profile 的 `cordis.patch.yml` 里覆盖行 `prompt-booster` 的 `config`（或让 Lead/插件管理器改）：

```yaml
- id: prompt-booster
  name: '@local/prompt-booster'
  config:
    provider: your-provider      # 可选：固定增强模型（provider+model 必须同时给）
    model: your-model
    reasoningEffort: low         # 可选：强制某个 effort；默认自动选该模型最低 effort 走快速路径
    temperature: 0               # 默认 0（最低随机，保证多次增强结果稳定）
    maxInputChars: 20000         # 超过直接拒绝（不截断）
    maxOutputTokens: 500         # 忠于原意的最小增强；兜底重试会放大到至少 4096
    timeoutMs: 60000
    projectContext: true         # 是否带上会话所在项目的上下文（默认开，仅用于消解指代）
    contextMaxChars: 1000        # 项目上下文最多注入多少字符
    conversationContext: true    # 是否带上最近对话（默认开；2 轮/4 条，最近一轮 65%、更早一轮 35%）
    rateLimitPerMinute: 20       # /enhance 每分钟每 IP 上限（1~120）
    maxConcurrentEnhance: 2      # /enhance 并发上限（1~8）
    allowClientProject: false    # 允许客户端 cwd（仅测试；默认只信会话元数据）
    systemPrompt: '……'          # 覆盖内置增强指令（整段替换）
    diag: true                   # 是否写 data/diag.jsonl 诊断
```

> 安全相关的 Host/端口校验、页面 token、限流等由插件自动处理，不需要配置。

> 设计原则：**忠于原意 + 必要的任务成型**。上下文（最近对话/项目）只用于消解指代
> （例如「这个插件」指什么、草稿是在回答哪一轮问题），不会被展开成需求规格；
> 增强只补「执行方式」层面的信息（内容结构 / 受众视角 / 输出形制 / 质量底线，最多 2~3 类），
> 短稿输出 60~160 字、长稿不超过原文长度，且**不会向用户反问**（缺信息用合理默认）。

不配置 `provider`/`model` 时，自动跟随安装者 profile 的 `agentDefaultModel`（Settings → Models 里选定的默认模型）。
增强是辅助请求，默认**不继承**会话默认模型上较高的 reasoning effort，而是自动取该路由可选 effort 中最低的一档跑快速路径。

### 模型调用与账号（重要）

本插件**不包含任何 API Key、API 地址或模型账号**，也不会回调作者或任何第三方服务：

- 增强请求走安装者本机 DSH 的 `ctx.llm`，由安装者 profile 里配置的 provider adapter 和凭据完成鉴权；
- provider/model 默认取安装者的 `agentDefaultModel`，也可以用上面的 `provider`/`model` 覆盖；
- 因此**每个使用者消耗的是自己的模型额度**，作者既不会被调用，也拿不到任何人的密钥；
- 插件没有任何外联请求，浏览器侧只请求本机 `/prompt-booster/*` 路由。

### 项目上下文（默认开启）

点「增强」时，Host 会从**会话元数据**（`session.header.cwd`）确定项目目录（客户端上报的 cwd 默认忽略），并对项目目录做 `realpath`；读取的项目文件会拒绝符号链接、要求 `realpath` 仍在项目目录内，防止 `AGENTS.md` 等被链接到项目外的敏感文件。读取范围：

- 项目目录、顶层结构（最多 12 项，跳过 `node_modules`/`.git`）；
- 技术栈线索：`package.json`（包名 + 前 12 个依赖 + scripts）、`pyproject.toml`、`requirements.txt`、
  `Cargo.toml`、`go.mod`、`pom.xml`、`composer.json`；
- 项目规范：`AGENTS.md` / `AGENTS.local.md` / `CLAUDE.md`（前 350 字）；
- `git` 分支名；
- 结果有 90 秒缓存，总长度受 `contextMaxChars` 限制（默认 1000 字）。

这些信息**只用于消解指代**（例如把「这个插件」落成项目里的具体功能名），不会被展开复述成需求清单；
`projectContext: false` 可关闭。

**上下文门控（重要）**：草稿本身是自包含指令时（例如一段带数据/要求的说明），插件**不会**带最近对话和
项目上下文，避免把历史里的受众、结构、篇幅当成新要求（"开卷考试"）。只有草稿很短（≤25 字，通常是
回答/接话）或含「这个/那个/它/上述/前面」等指代时，才会带最近对话；草稿出现「页面/项目/插件/功能/组件」
等对象且不超过 80 字时，才会带项目上下文。`data/diag.jsonl` 的 `enhance-request` 里有
`needsContext` 和 `gated` 字段可查。

### 最近对话（默认开启）

草稿经常只是对上一轮问题的简短回答（例如「5秒吧」）。最近对话由**浏览器侧从当前页面 Chat 视图**提取
（最近 2 轮的 prompt/response 预览，最多 4 条消息、总计最多 800 字）随请求发送；
**Host 不读取任何会话历史，也不凭 sessionId 读取他人会话**。最近一轮占 65% 参考权重，更早一轮占 35%。
`conversationContext: false` 可关闭。

### 两次尝试（稳定性）

1. **快速路径**：最低 reasoning effort + `maxOutputTokens`，通常几秒返回；
2. **兜底重试**：若第一次没有产出任何文本（例如 reasoning 吃满输出预算、空响应），
   自动用最高 effort + `max(4096, maxOutputTokens)` 再试一次；
3. 两次都空才返回失败，失败详情（每次的 effort/finish/耗时/输出字符数）写入
   `data/diag.jsonl` 的 `enhance-attempt` 记录，便于排查。

### 限流与资源保护

- `/enhance` 默认 **20 次/分钟/IP**，其它路由 120 次/分钟/IP，超出返回 `429` + `retryAfterMs`；
- `/enhance` 并发上限默认 **2**，同时只处理有限个模型请求；
- 作用：① 防止误触/脚本刷接口把模型额度打光；② 防止本机被跨站请求放大成批量调用；
  ③ 限制同时挂起的请求，避免内存/上游连接被占满；④ 让调用成本可预期；
- 限流只保护**本机插件入口**，不会绕过也不会影响模型服务商自己的限流，额度仍以安装者的模型账号为准；
- 可用 `rateLimitPerMinute`、`maxConcurrentEnhance` 配置。

## 合规声明（非官方）

- 本项目是社区/个人开源插件，**非 DeepSeek 官方产品**，与深度求索公司无隶属关系；
  "DeepSeek"、"DeepSeek Harness"（DSH）等名称仅用于说明兼容性。
- 不包含、不转发、不代理任何 API Key 或账号；模型调用由安装者本机 DSH 与安装者自己的模型账号完成。
- 不上传、不收集用户数据；草稿与上下文只在本机进程与安装者配置的模型服务之间流转。
- 许可证为 MIT；使用第三方模型服务时，请同时遵守对应服务商的服务条款。
- 合规自查清单见 [COMPLIANCE.md](COMPLIANCE.md)。

## 安全说明

安全边界、已实施控制与残余风险详见 [SECURITY.md](SECURITY.md)。要点：

- 路由**只接受本机回环**来源；`Host` 必须是回环名且端口等于实际监听端口（防 DNS rebinding）；
  拒绝 `sec-fetch-site: cross-site` 与跨源 web Origin；`http(s)` 来源还要回传**页面 token**（由 index 注入页面全局）；
  桌面壳页面请求通常不带 Origin，此时依赖回环 + Host/端口校验；
- 响应不带通配 CORS；`POST` 仅接受 `application/json`；`/enhance` 默认限流 20 次/分钟、并发上限 2；
  请求体读取带总超时，模型调用有硬 deadline；
- 项目目录只从 Host 会话元数据读取，客户端 cwd 默认忽略；项目文件读取拒绝符号链接与 `realpath` 逃逸；
- `data/diag.jsonl` 只记录白名单事件与结构化字段（字符数/布尔值等），不记录草稿、上下文、错误原文，超过 2MB 自动轮转；
- 最近对话由浏览器侧从当前页面 Chat 视图提取后传入，**Host 不读取会话历史**；
- 增强会把「草稿 + 最近 2 轮对话 + 受限项目上下文」发送给当前配置的模型提供方（默认 DeepSeek），
  **不要在草稿里放密钥**。

## 安全回归测试

```bash
node tests/security.test.mjs
```

覆盖：严格回环判断、Host/端口校验、页面 token、跨站拒绝、诊断字段白名单、符号链接防护、
最近对话输入校验、输出长度上限计算。零依赖，可直接在仓库根目录运行。

## 行为约定

- **最高目标**：**忠于原意** + **便于执行端（LLM）理解和执行**；其它规则（简短、变化、纠正）都服从这两条。
- **忠于原意 + 任务成型**：保留原文的目标、受众、篇幅与措辞，只补执行方式层面的信息
  （内容结构 / **受众视角** / 输出形制 / 质量底线，最多 2~3 类）。
- **便于执行端**：把含糊动作落成可执行动作（做什么、对什么做、产出什么）；结合上下文消解指代；
  草稿没给的事实不编；草稿明确要求的结构/受众/篇幅/格式必须保留并写清。
- **目标解析（通用，不是单点补丁）**：草稿出现模糊目标（好看、好用、高级、清楚、专业、优化、提升…）时，
  先定义"好"在本对象上的判定标准，展开 3~5 个维度，任务写成「从这些角度分析现状→指出问题→给方案/建议」；
  维度按"目标词 + 对象"选择（页面「好看」用视觉维度，页面「体验」用交互维度）。
- **人物视角（通用）**：草稿写了「给X看/汇报给X」时，先分析 X 的角色、决策关注点和评判标准，
  再按该视角组织（总监：值不值得做/成本/收益/风险；新同事：从零开始/操作顺序/常见坑；客户：价值/证据/成本周期）。
- **任务画像与执行契约（通用）**：先判断任务类型，再补该类任务的最低执行要素——写作/汇报、方案/分析、
  代码/脚本、设计/视觉、计划/排期、决策/选型、修改/润色、问答/研究、沟通/回复、排障/操作，各有一套契约。
- **其它通用处理**：信息缺口不编造（先列缺失项/标注假设）；冲突与多目标写明优先级或取舍；多个交付物逐项保留；
  高风险操作要求确认/备份/回滚/标注依据；换方向/重写/只改某处按迭代方向处理。
- **领域约束包（按需注入）**：安全、法务/合规、财务、医疗、隐私、生产变更、数据、会议、测试、
  代码审查、营销、求职等，只补该领域的必要做法（授权/依据/复核/备份/脱敏/术语表），不改变目标、不加业务内容。
- **复杂场景**：长文档先提纲后展开；多文件/批量逐项处理并汇总失败项；多语言保留术语表、代码命令不译；
  引用/附件保留原链接路径格式，不编造。
- **受众视角**：不是简单写「给 X 看」，而是写成「以 X（层级）的视角陈述」。
  汇报/说明类按他关心的 2~3 个方面拆分；步骤/操作类按执行顺序拆分。
  例如给总监：值不值得推进、投入与成本、能带来什么成效、风险与限制；给新同事：按操作顺序说明怎么上手。
- **短句直给**：每句 ≤30 字，一个短句一个意思，整体 2~5 句；不用长定语、括号嵌套、破折号插入语。
- **只改写，不回答**：草稿是问句时改写成「请回答/请列出…」的请求，不会把答案、步骤、命令直接写出来。
- **多次增强 = 连续纠正**：再次点增强时，以**原句**（首次增强前的草稿）为最高权重，上一版只作为候选；
  只修正偏离原意、没有依据或答成答案的部分，**正确的措辞、结构和已有要求保留**，不整段重写、不丢正确内容；
- **每次增强都有表达变化**：不是换标点或同义词，而是重新理解原句后换一种句式/组织顺序/用词表达；
  Host 侧用字符二元组相似度识别"只换词不换结构"的浅层改写，命中就调高温度、要求改句式再试（最多两次），
  原意、事实、要求不变；
- **两个回退按钮**：`退改` 返回上一版增强结果；`撤销` 返回最初的原句。
- **长度硬上限**：短稿（≤60 字）→ 120~200 字；中等稿 → ≤原文 1.3 倍；
  **长稿（>200 字）→ 不超过原文长度**（只压缩和整理，不扩写）；中文总量 ≤300 字、英文 ≤180 词。
- **上下文只用于理解**：最近对话/项目上下文只用来消解指代（「这个插件」指什么、草稿在回答哪一轮），
  不会把实现细节、字段名、云函数名等展开成任务要求；也**不会向用户反问**（缺信息用合理默认）。
- **稳定**：`temperature` 默认 0（最低随机），同一草稿多次增强的**长度、结构与主干语义**稳定；
  具体措辞可能有细微差异（托管模型服务侧不保证逐字确定）。
- **语言一致**：中文草稿输出中文，英文输出英文，代码/命令/路径保持原样。
- **只输出提示词**：模型不许回答草稿里的问题或加「以下是优化后的提示词」这类前言；
  host 侧还有兜底清理（去整体代码围栏、去前言）。
- **不丢编辑**：增强期间如果用户改了草稿，增强结果回填后「撤销」恢复的是**最新**草稿。
- **失败不破坏草稿**：网络/模型失败时只显示「失败」提示（悬停看原因），草稿保持原样。

## 已知限制

- 草稿里的 `@文件` 引用 chip 在回填时会被展开为纯文本（`inputActions.setDraft` 的固有行为），
  增强后请在发送前检查 @ 引用；带附件时同样建议先手动确认。
- 命令模式（输入框已进入 `/command` 状态）下按钮禁用；增强不会作用于斜杠命令。
- 增强调用不计入会话历史，也不产生模型消息；提示词草稿本身不会写入 session log
  （只有 host 侧 `data/diag.jsonl` 诊断记录，且不含草稿正文）。
- 插件是 profile 级：换 profile 需要重装。
- **路由边界**：`/prompt-booster/*` 只注册在 DSH Web server 上，且只接受回环来源；
  Host 必须匹配监听端口，`http(s)` 页面来源还需要页面 token（防 DNS rebinding/CSRF）。
  若把 DSH Web server 的 `--host` 改成非回环地址，插件仍会拒绝非回环来源；不建议暴露该端口。
- **长度是提示词软约束**：提示词要求模型控制篇幅，Host 侧会计算上限并在响应里返回
  `lengthCap` / `lengthOver`（仅度量、不强制截断）；不同模型/effort 下偶尔会略长，
  可用 `maxOutputTokens` 或 `reasoningEffort` 调节，必要时用 `systemPrompt` 整体替换指令。

## 手工验证

```powershell
Invoke-RestMethod "$env:DSH_WEB_URL/prompt-booster/health"

Invoke-RestMethod -Method Post "$env:DSH_WEB_URL/prompt-booster/enhance" `
  -ContentType 'application/json' `
  -Body (@{ text = '帮我把这个页面的按钮改好看点' } | ConvertTo-Json)
```

浏览器侧：装好后刷新页面（或等 HMR 自动加载），输入框工具栏出现「✨ 增强」；
`data/diag.jsonl` 里应出现一条 `kind=client-apply`。
