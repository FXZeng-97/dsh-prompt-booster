# 提示词增强（Prompt Booster）

DSH（DeepSeek Harness）profile 级插件：在每个会话的聊天输入框工具栏加一个「✨ 增强」按钮。
点一下，当前草稿会被模型改写成更清楚、可执行、便于执行端理解的提示词，回填到输入框，可继续编辑再发送。

> 社区/个人开源插件，**非 DeepSeek 官方产品**，与深度求索公司无隶属关系。

## 功能

- **一键增强**：把草稿改写成任务描述，只改写、不直接回答草稿里的问题。
- **连续纠正**：再次点击时以原句为最高权重，只修偏差、保留上一版正确的内容。
- **两个回退**：`退改` 返回上一版，`撤销` 返回最初原句。
- **每次增强有表达变化**：换句式/结构，而不是只换标点或同义词。
- **通用任务处理**：目标解析、人物视角、任务画像、领域约束（安全/法务/财务/医疗等）、
  长文档/续写、批量任务、否定与范围约束、交付形态等。
- **轻量改写不越权**：改一下/润色/压缩/翻译只改表达，不补受众、渠道、卖点或交付要求；
  单点小改动只加半句安全检查，不堆完整回滚流程。
- **变更类任务加安全执行要求**：改代码/文档/数据/配置/设计稿时，自动要求先备份或建快照、
  只改目标范围、异常立即停止并汇报、完成后给改动清单和验证结果；对外发送类先出草稿等确认。
- **持续性任务加“定目标跑完”**：用户说“你自己做完/别停/全部做完/不用问我”或批评中途停止时，
  自动要求一句「设定目标，继续做完剩余任务，中途不要停；完成后汇总结果、未完成项和风险」。
- **本地优先**：只在本机运行，无外联、无 API Key、无数据上传。

## 安装

前提：已安装 DSH（桌面或 Web profile），并在 **Settings → Models** 配好模型。
插件本身零依赖、无安装脚本。已验证环境：DSH `0.2.1-rc.5`；其他版本未逐一验证。

### 方式 A：下载 ZIP（最简单，不用 Git）

1. 打开 https://github.com/FXZeng-97/dsh-prompt-booster
2. 点 **Code → Download ZIP**，解压到任意目录（路径尽量不含中文/空格）。
3. 在 DSH 里让 Agent 安装（把路径换成你的解压目录）：

   > 把 `D:\dsh-prompt-booster` 目录用 plugin_manager 的 `install_bundle` 装进当前 profile

4. 刷新页面（或重启 DSH），输入框工具栏出现「✨ 增强」。

### 方式 B：git clone（开发者）

```bash
git clone https://github.com/FXZeng-97/dsh-prompt-booster.git
```

然后同样让 Agent 安装该目录。

### 卸载

`plugin_manager remove_bundle`，目标 `dsh-prompt-booster`。

> 说明：代码和增强规则一样，但不同人的**模型**（各自 `agentDefaultModel`）、**DSH 版本**、
> **项目上下文**和**会话历史**不同，输出不会逐字相同；安装流程在本机验证过，
> 其他人的系统/DSH 版本未逐一实测，遇到问题请开 Issue。

## 使用

1. 在输入框写草稿，点「✨ 增强」。
2. 结果回填后可直接编辑；不满意再点增强（连续纠正）。
3. 想回退：`退改` 回上一版，`撤销` 回最初原句。

## 配置（可选）

在 profile 的 `cordis.patch.yml` 里覆盖行 `prompt-booster` 的 `config`：

| 配置 | 默认 | 说明 |
|---|---|---|
| `provider` / `model` | 跟随 `agentDefaultModel` | 固定增强模型，两个同时给 |
| `maxInputChars` | `20000` | 草稿上限，超过拒绝 |
| `maxOutputTokens` | `500` | 输出预算；空输出会兜底放大重试 |
| `timeoutMs` | `60000` | 模型调用超时 |
| `projectContext` | `true` | 是否带会话所在项目上下文（仅用于消解指代） |
| `conversationContext` | `true` | 是否带最近 2 轮对话（浏览器侧提取） |
| `rateLimitPerMinute` | `20` | `/enhance` 每分钟每 IP 上限 |
| `maxConcurrentEnhance` | `2` | `/enhance` 并发上限 |
| `diag` | `true` | 是否写 `data/diag.jsonl` 诊断 |

其余项见 `cordis.patch.yml` 注释。

## 安全与隐私

- 路由只接受**本机回环**来源；Host、端口、跨站、Origin、页面 token 都有校验，响应无通配 CORS。
- 项目上下文只从会话元数据取 cwd，拒绝符号链接与目录逃逸；最近对话由浏览器侧提供，Host 不读会话历史。
- 诊断只记结构化元数据，不记草稿、上下文或错误原文；`data/diag.jsonl` 超过 2MB 自动轮转。
- 增强会把「草稿 + 最近 2 轮对话 + 受限项目上下文」发给**你自己配置的模型提供方**；
  **不要在草稿里放密钥或敏感凭据**。

详见 [SECURITY.md](SECURITY.md)。

## 外部依赖与风险

- **无运行时依赖、无安装脚本**，纯 JS。
- 风险：增强内容会发送到模型提供方；项目文件/会话预览会进入模型输入，存在提示注入可能；
  插件以 DSH 进程权限运行。请自行评估后再安装。

## 文档

- [ARCHITECTURE.md](docs/ARCHITECTURE.md)：路由、安装结构、稳定性机制、手工验证
- [BEHAVIOR.md](docs/BEHAVIOR.md)：增强行为约定
- [DEVELOPMENT.md](docs/DEVELOPMENT.md)：测试、诊断、发布 npm
- [SECURITY.md](SECURITY.md)、[COMPLIANCE.md](COMPLIANCE.md)

## License

[MIT](LICENSE)
