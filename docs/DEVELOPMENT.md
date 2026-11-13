# 开发与发布

## 测试

```bash
node tests/security.test.mjs
```

覆盖：严格回环判断、Host/端口校验、页面 token、跨站拒绝、诊断字段白名单、符号链接防护、
最近对话输入校验、输出长度上限、答案守卫、目标解析/人物视角/领域约束提示等。零依赖。

## 诊断

- `data/diag.jsonl`：Host 侧诊断，只记结构化字段（字符数/布尔/枚举/attempt 元数据），
  不记草稿、上下文、错误原文；超过 2MB 自动轮转为 `.1`。
- 常见事件：`host-apply`、`client-apply`、`client-mounted`、`enhance-request`、`enhance-ok`、
  `enhance-error`、`request-blocked`、`enhance-attempt`、`enhance-variation`、`enhance-answer-guard`。

## 发布到 npm（可选）

`dsh-prompt-booster` 是本机/公开安装用的包名。要发布到 npm 或换名，先改成唯一包名
（如 `dsh-prompt-booster` 或 `@你的账号/dsh-prompt-booster`），并**同步改三处**：

1. `package.json` 的 `"name"`；
2. `cordis.patch.yml` 里 insert 行的 `name:`；
3. `client.js` 里的 `id:`（浏览器 loader 的 id 必须等于包名）。

然后 `npm publish --access public`；使用者用 `plugin_manager install_bundle <包名>` 安装。

## 上架第三方插件市场（参考）

- 仓库公开、`package.json` 有可解析的 `dsh.bundle.patch`；
- 入口 ID 唯一，不使用 `@deepseek-ai` 命名空间；
- 无安装/构建生命周期脚本，或如实声明；
- README 写清用途、安装/启用、外部依赖、风险、兼容范围；
- 安装源固定到完整 40 位 Commit。

## 版本与 tag

- 版本号在 `package.json`；
- 发布后打 tag：`git tag -a vX.Y.Z -m "prompt-booster vX.Y.Z"`，再 `git push origin vX.Y.Z`。
