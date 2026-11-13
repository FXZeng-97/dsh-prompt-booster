/**
 * 安全回归测试（零依赖，直接 `node tests/security.test.mjs`）。
 *
 * 覆盖审查报告中的 P1/P2 修复：
 * - 严格回环判断（不再用 startsWith('127.') 放过攻击者域名）
 * - Host/端口校验（DNS rebinding）
 * - 页面 token（http 来源必须回传）
 * - 诊断字段白名单
 * - 项目文件符号链接/目录逃逸
 * - 最近对话输入校验（不再由 Host 读取会话历史）
 * - 输出长度上限计算
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isLoopbackAddress,
  hostHeaderMatches,
  evaluateRequestTrust,
  sanitizeDiagDetail,
  safeProjectFile,
  outputLengthCap,
  looksLikeAnswer,
  buildEnhanceUserText,
  buildTaskHint,
  isSameText,
  isShallowVariant,
  modalityIssue,
  recentFromBody,
  PAGE_TOKEN,
  PAGE_TOKEN_HEADER,
} from '../index.js'

let passed = 0
let failed = 0
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`PASS ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${name}: ${error && error.message}`)
  }
}

/* ---------- 1. 回环地址严格判断 ---------- */
const loopbackOk = ['127.0.0.1', '127.255.0.1', '::1', '::ffff:127.0.0.1']
const loopbackBad = ['127.evil.test', '127.0.0.1.evil.test', 'localhost', '10.0.0.1', '::ffff:10.0.0.1', '', 'abc', '::2']
for (const value of loopbackOk) test(`loopback accepts ${value}`, () => assert.equal(isLoopbackAddress(value), true))
for (const value of loopbackBad) test(`loopback rejects ${value}`, () => assert.equal(isLoopbackAddress(value), false))

/* ---------- 2. Host + 端口校验（DNS rebinding） ---------- */
const reqWithHost = (host) => ({ socket: { remoteAddress: '127.0.0.1' }, headers: host === undefined ? {} : { host } })
for (const host of ['127.0.0.1:2887', 'localhost:2887', '[::1]:2887']) {
  test(`host accepts ${host}`, () => assert.equal(hostHeaderMatches(reqWithHost(host), 2887), true))
}
for (const host of ['127.evil.test:2887', '127.0.0.1.evil.test:2887', 'example.com:2887', '127.0.0.1:9999', '127.0.0.1', 'evil.example']) {
  test(`host rejects ${host}`, () => assert.equal(hostHeaderMatches(reqWithHost(host), 2887), false))
}
test('host rejects missing Host', () => assert.equal(hostHeaderMatches(reqWithHost(undefined), 2887), false))

/* ---------- 3. 请求信任判定 ---------- */
const trustReq = (remote, headers) => ({ socket: { remoteAddress: remote }, headers })
const baseHeaders = { host: '127.0.0.1:2887' }

test('trust accepts plain loopback request', () => {
  assert.equal(evaluateRequestTrust(trustReq('127.0.0.1', baseHeaders), { expectedPort: 2887 }).ok, true)
})
test('trust accepts desktop-shell origin', () => {
  const headers = { ...baseHeaders, origin: 'dsh-app://app' }
  assert.equal(evaluateRequestTrust(trustReq('127.0.0.1', headers), { expectedPort: 2887 }).ok, true)
})
test('trust rejects non-loopback remote', () => {
  assert.equal(evaluateRequestTrust(trustReq('10.0.0.2', baseHeaders), { expectedPort: 2887 }).ok, false)
})
test('trust rejects evil origin', () => {
  const headers = { ...baseHeaders, origin: 'http://127.0.0.1.evil.test:2887' }
  const result = evaluateRequestTrust(trustReq('127.0.0.1', headers), { expectedPort: 2887 })
  assert.equal(result.ok, false)
})
test('trust rejects cross-site fetch metadata', () => {
  const headers = { ...baseHeaders, 'sec-fetch-site': 'cross-site' }
  assert.equal(evaluateRequestTrust(trustReq('127.0.0.1', headers), { expectedPort: 2887 }).ok, false)
})
test('trust requires page token for http origin', () => {
  const headers = { ...baseHeaders, origin: 'http://127.0.0.1:2887' }
  const result = evaluateRequestTrust(trustReq('127.0.0.1', headers), { expectedPort: 2887 })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'token-required')
})
test('trust accepts http origin with page token', () => {
  const headers = {
    ...baseHeaders,
    origin: 'http://127.0.0.1:2887',
    [PAGE_TOKEN_HEADER]: PAGE_TOKEN,
  }
  assert.equal(evaluateRequestTrust(trustReq('127.0.0.1', headers), { expectedPort: 2887 }).ok, true)
})
test('trust rejects wrong page token', () => {
  const headers = {
    ...baseHeaders,
    origin: 'http://127.0.0.1:2887',
    [PAGE_TOKEN_HEADER]: 'x'.repeat(PAGE_TOKEN.length),
  }
  assert.equal(evaluateRequestTrust(trustReq('127.0.0.1', headers), { expectedPort: 2887 }).ok, false)
})

/* ---------- 4. 诊断字段白名单 ---------- */
test('diag keeps whitelisted structured fields', () => {
  const detail = sanitizeDiagDetail({ rendered: true, buttons: 1, slot: 'conversation.input.right', secret: 'abc', text: 'draft body' })
  assert.deepEqual(detail, { rendered: true, buttons: 1, slot: 'conversation.input.right' })
})
test('diag rejects oversized/free-form strings', () => {
  const detail = sanitizeDiagDetail({ slot: 'x'.repeat(41), chars: 3 })
  assert.deepEqual(detail, { chars: 3 })
})

/* ---------- 5. 项目文件读取：普通文件 OK、符号链接/逃逸拒绝 ---------- */
const root = mkdtempSync(join(tmpdir(), 'pb-security-'))
try {
  const project = join(root, 'project')
  const outside = join(root, 'outside')
  mkdirSync(project)
  mkdirSync(outside)
  writeFileSync(join(project, 'AGENTS.md'), 'inside rules')
  writeFileSync(join(outside, 'secret.txt'), 'outside secret')
  test('safe file reads normal file', () => {
    assert.equal(safeProjectFile(project, 'AGENTS.md', 100), 'inside rules')
  })
  let symlinkReady = false
  try {
    symlinkSync(join(outside, 'secret.txt'), join(project, 'README.md'))
    symlinkReady = true
  } catch {
    /* Windows 无权限创建符号链接时跳过（需开发者模式） */
  }
  if (symlinkReady) {
    test('safe file rejects symlink escaping project', () => {
      assert.equal(safeProjectFile(project, 'README.md', 100), '')
    })
  } else {
    console.log('SKIP symlink test (Windows symlink permission unavailable)')
  }
  test('safe file rejects missing file', () => {
    assert.equal(safeProjectFile(project, 'nope.md', 100), '')
  })
} finally {
  rmSync(root, { recursive: true, force: true })
}

/* ---------- 6. 最近对话输入校验（由客户端提供） ---------- */
test('recent accepts at most 4 valid messages from the tail', () => {
  const result = recentFromBody({
    recent: [
      { role: 'user', text: 'u1' },
      { role: 'assistant', text: 'a1' },
      { role: 'user', text: 'u2' },
      { role: 'assistant', text: 'a2' },
      { role: 'system', text: 'not allowed role' },
      { role: 'user', text: '   ' },
    ],
  })
  assert.equal(result.count, 4)
  for (const expected of ['u1', 'a1', 'u2', 'a2']) assert.equal(result.text.includes(expected), true)
  assert.equal(result.text.includes('not allowed role'), false)
})
test('recent rejects non-array input', () => {
  assert.deepEqual(recentFromBody({ recent: 'abc' }), { text: '', count: 0 })
  assert.deepEqual(recentFromBody({ recentText: 'abc' }), { text: '', count: 0 })
})

/* ---------- 7. 输出长度上限 ---------- */
test('length cap for short draft', () => assert.equal(outputLengthCap(50), 160))
test('length cap for medium draft', () => assert.equal(outputLengthCap(100), 130))
test('length cap for long draft', () => assert.equal(outputLengthCap(400), 300))

/* ---------- 8. 只改写、不回答（答案化检测） ---------- */
const questionDraft = '发布到 GitHub 还需要提供哪些东西？列个操作步骤给我'
test('answer guard accepts a prompt rewrite', () => {
  assert.equal(looksLikeAnswer(questionDraft, '发布到 GitHub 前，还需要准备哪些东西？请列一份操作步骤。'), false)
})
test('answer guard detects numbered answer steps', () => {
  const answer =
    '发布到 GitHub 前，请按顺序完成以下准备。\n1. 安装 Git，并配置用户名和邮箱。\n2. 在项目根目录执行 git init。\n3. 执行 git commit -m "first" 完成首次提交。'
  assert.equal(looksLikeAnswer(questionDraft, answer), true)
})
test('answer guard detects direct command content', () => {
  assert.equal(looksLikeAnswer(questionDraft, '先安装 Git，再执行 git init，最后推送。'), true)
})
test('answer guard converts an answer-list draft into a request', () => {
  const answerList =
    '1. 安装 Git，并配置用户名和邮箱。\n2. 在项目根目录执行 git init。\n3. 执行 git commit -m "first" 完成首次提交。'
  assert.equal(looksLikeAnswer(answerList, answerList), true)
  assert.equal(looksLikeAnswer(answerList, '请整理发布到 GitHub 的完整操作步骤，每条一句。'), false)
})
test('answer guard accepts a corrected answer draft with format words', () => {
  const answerDraft =
    '发布到 GitHub 前，请按顺序完成以下准备。每步一句，可直接照做。1. 安装 Git。2. 执行 git init。'
  assert.equal(
    looksLikeAnswer(answerDraft, '发布到 GitHub 前还需要提供哪些东西？请列出操作步骤。按顺序写，每步一句，可直接照做。'),
    false,
  )
})
test('answer guard keeps a task-list draft', () => {
  const taskList = '1. 把按钮改大\n2. 颜色换成蓝色'
  assert.equal(looksLikeAnswer(taskList, taskList), false)
})
test('answer guard detects an answer-intro rewrite', () => {
  const answerIntro = '发布到 GitHub 前，请按顺序完成以下准备。每步写一句，可直接照做。'
  assert.equal(looksLikeAnswer(questionDraft, answerIntro), true)
})
test('answer guard detects flattened answer text', () => {
  const flattened =
    '发布到 GitHub 前，请按顺序完成以下准备，每步一句，可直接照做。安装 Git 并配置用户名和邮箱。在项目根目录执行 git init。补写 README，说明用途和运行方式。'
  assert.equal(looksLikeAnswer(questionDraft, flattened), true)
})
test('answer guard converts a single-line numbered answer draft', () => {
  const inlineAnswer =
    '发布到 GitHub 前，请按顺序完成以下准备。每步一句，可直接照做。1. 安装 Git，并配置用户名和邮箱。2. 在项目根目录执行 git init。'
  assert.equal(looksLikeAnswer(inlineAnswer, inlineAnswer), true)
  assert.equal(looksLikeAnswer(inlineAnswer, '请列出发布到 GitHub 的操作步骤，每条一句。'), false)
})
test('answer guard accepts a clean request rewrite', () => {
  const answerList =
    '1. 安装 Git，并配置用户名和邮箱。\n2. 在项目根目录执行 git init。'
  assert.equal(looksLikeAnswer(answerList, '请列出发布到 GitHub 前需要准备的内容和操作步骤，每条一句。'), false)
})

/* ---------- 9. 多次增强：原句最高权重 + 连续纠正 ---------- */
const originalDraft = '发布到 GitHub 还需要提供哪些东西？列个操作步骤给我'
test('fresh enhance uses only the draft', () => {
  const text = buildEnhanceUserText({ text: originalDraft, base: '', contextText: '' })
  assert.equal(text.includes(originalDraft), true)
  assert.equal(text.includes('【原句'), false)
})
test('repeat enhance sends original as top weight and previous as candidate', () => {
  const previous = '请列出发布到 GitHub 还需要提供哪些东西。请给出对应的操作步骤。'
  const text = buildEnhanceUserText({ text: previous, base: originalDraft, contextText: '' })
  assert.equal(text.includes('【原句（最高权重，忠于原意）】\n' + originalDraft), true)
  assert.equal(text.includes('【上一版增强（保留正确部分，只修正偏差）】\n' + previous), true)
  assert.equal(text.includes('【本次任务】'), true)
})
test('base equal to draft falls back to fresh enhance', () => {
  const text = buildEnhanceUserText({ text: originalDraft, base: originalDraft, contextText: '' })
  assert.equal(text.includes('【原句'), false)
})

/* ---------- 10. 每次增强要有"表达层面"的变化 ---------- */
test('same-text is insensitive to spaces and punctuation', () => {
  assert.equal(isSameText('请列出A。请给出B。', '请列出 A，请给出 B'), true)
  assert.equal(isSameText('请列出A并给出B。', '请列出A，并给出B。'), true)
})
test('same-text detects real wording changes', () => {
  assert.equal(isSameText('请列出A并给出B。', '请说明A并列出B。'), false)
  assert.equal(isSameText('请列出发布到 GitHub 的步骤。', '请列出发布到 GitHub 的操作步骤。'), false)
})
test('shallow-variant flags synonym/connector-only rewrites', () => {
  assert.equal(
    isShallowVariant(
      '请列出发布到 GitHub 还需要提供哪些东西，并给出对应的操作步骤。',
      '请说明发布到 GitHub 还需要提供哪些东西，并列出操作步骤。',
    ),
    true,
  )
  assert.equal(isShallowVariant('请列出A并给出B。', '请给出A并列出B。'), true)
})
test('shallow-variant accepts real restructure', () => {
  assert.equal(
    isShallowVariant(
      '请列出发布到 GitHub 还需要提供哪些东西，并给出对应的操作步骤。',
      '发布到 GitHub 前需要准备哪些东西？请按操作步骤列出来。',
    ),
    false,
  )
})

/* ---------- 11. 目标解析 / 人物视角 提示 ---------- */
test('task hint detects vague visual goal', () => {
  const hint = buildTaskHint('帮我把这个页面的按钮改好看点')
  assert.equal(hint.includes('判定标准'), true)
  assert.equal(hint.includes('维度'), true)
})
test('task hint detects audience', () => {
  const hint = buildTaskHint('给应用部总监写一段话，说明这个插件能提升效率')
  assert.equal(hint.includes('受众'), true)
  assert.equal(hint.includes('评判标准'), true)
})
test('task hint covers goal + audience together', () => {
  const hint = buildTaskHint('把发布到 GitHub 的步骤整理清楚，给新同事看')
  assert.equal(hint.includes('模糊目标'), true)
  assert.equal(hint.includes('受众'), true)
})
test('task hint skips pure mechanical rewrites', () => {
  assert.equal(buildTaskHint('把这段说明压缩到 100 字以内'), '')
  assert.equal(buildTaskHint('把按钮改成蓝色'), '')
})
test('task hint adds multilingual guidance for translation', () => {
  const hint = buildTaskHint('把这段话翻译成英文')
  assert.equal(hint.includes('多语言'), true)
  assert.equal(hint.includes('不翻译'), true)
})
test('task hint detects task type contract', () => {
  const hint = buildTaskHint('帮我排查一下接口 500 错误')
  assert.equal(hint.includes('任务画像'), true)
  assert.equal(hint.includes('执行端所需的最低信息'), true)
})
test('task hint flags high-risk operations', () => {
  const hint = buildTaskHint('删除测试环境的所有旧数据')
  assert.equal(hint.includes('高风险'), true)
  assert.equal(hint.includes('备份'), true)
})
test('task hint covers task type + audience', () => {
  const hint = buildTaskHint('写一份周报，给老板看')
  assert.equal(hint.includes('任务画像'), true)
  assert.equal(hint.includes('受众'), true)
})

/* ---------- 12. 领域约束包 / 复杂场景 ---------- */
test('domain pack: security', () => {
  const hint = buildTaskHint('帮我做个安全渗透测试')
  assert.equal(hint.includes('安全领域'), true)
  assert.equal(hint.includes('授权范围'), true)
})
test('domain pack: legal', () => {
  const hint = buildTaskHint('帮我看下这份合同条款')
  assert.equal(hint.includes('法务/合规'), true)
  assert.equal(hint.includes('不构成法律意见'), true)
})
test('domain pack: finance', () => {
  const hint = buildTaskHint('帮我做预算报表')
  assert.equal(hint.includes('财务领域'), true)
  assert.equal(hint.includes('不构成投资建议'), true)
})
test('domain pack: medical', () => {
  const hint = buildTaskHint('帮我分析下这个症状')
  assert.equal(hint.includes('医疗领域'), true)
  assert.equal(hint.includes('医生'), true)
})
test('domain pack: production change', () => {
  const hint = buildTaskHint('帮我做上线发布计划')
  assert.equal(hint.includes('生产变更'), true)
  assert.equal(hint.includes('回滚'), true)
})
test('domain pack: meeting', () => {
  const hint = buildTaskHint('整理一下会议纪要')
  assert.equal(hint.includes('决策'), true)
  assert.equal(hint.includes('行动项'), true)
})
test('domain pack: testing', () => {
  const hint = buildTaskHint('帮我写测试用例')
  assert.equal(hint.includes('预期结果'), true)
})
test('complexity: multi-file / long / citation hints', () => {
  assert.equal(buildTaskHint('批量处理目录下所有文件').includes('多文件/批量'), true)
  assert.equal(buildTaskHint('按参考链接整理成文档').includes('引用/附件'), true)
})

/* ---------- 13. 否定/范围、长文档续写、批量断点、交付形态 ---------- */
test('negation and scope constraints are preserved as hints', () => {
  assert.equal(buildTaskHint('不要用列表，改成一段话').includes('否定/范围约束'), true)
  const hint = buildTaskHint('只改错别字，别动内容')
  assert.equal(hint.includes('否定/范围约束'), true)
  assert.equal(hint.includes('不得改写成正向要求'), true)
})
test('long document / continuation hint', () => {
  const hint = buildTaskHint('把这份长文档拆成章节并续写下一段')
  assert.equal(hint.includes('长文档/续写'), true)
  assert.equal(hint.includes('分段边界'), true)
})
test('batch hint includes checkpoint and failure summary', () => {
  const hint = buildTaskHint('批量处理列表里的每一项，支持断点续跑')
  assert.equal(hint.includes('多文件/批量'), true)
  assert.equal(hint.includes('断点续跑'), true)
  assert.equal(hint.includes('汇总成功/失败'), true)
})
test('deliverable format hint', () => {
  const hint = buildTaskHint('把结果输出成 JSON 表格')
  assert.equal(hint.includes('交付形态'), true)
  assert.equal(hint.includes('未指定不擅自添加'), true)
})
test('rewrite-style hint avoids asking the user', () => {
  const hint = buildTaskHint('换一种风格重写这段话，但保留原意')
  assert.equal(hint.includes('改写/换风格'), true)
  assert.equal(hint.includes('不要要求用户补充'), true)
})
test('action-owner hint preserves who does what', () => {
  const hint = buildTaskHint('正好harness有新版本了，我更新一下你再验证一次')
  assert.equal(hint.includes('动作归属/视角'), true)
  assert.equal(hint.includes('禁止角色互换'), true)
})
test('action-owner hint works for reversed roles', () => {
  const hint = buildTaskHint('你先更新 harness，我再验证')
  assert.equal(hint.includes('动作归属'), true)
})
test('fidelity hint catches numbers, time and modality', () => {
  const hint = buildTaskHint('尽量在周五前给我 3 个方案，不要超过 2 页')
  assert.equal(hint.includes('保真核对'), true)
  assert.equal(hint.includes('数量/时间/条件/否定/情态'), true)
})
test('fidelity hint catches condition and order', () => {
  const hint = buildTaskHint('先跑测试，有问题再回滚')
  assert.equal(hint.includes('保真核对'), true)
})
test('fidelity hint catches quote and source', () => {
  const hint = buildTaskHint('客户原话是界面不够专业，你按这个改')
  assert.equal(hint.includes('保真核对'), true)
})
test('fidelity hint catches scope and tentative wording', () => {
  assert.equal(buildTaskHint('把 A 改成 B，其他不动').includes('保真核对'), true)
  assert.equal(buildTaskHint('暂时先这样，之后再说').includes('保真核对'), true)
})
test('modality issue flags must-to-please downgrade', () => {
  assert.notEqual(modalityIssue('必须周五前给我 3 个方案', '请在周五前给我 3 个方案。'), '')
})
test('modality issue flags weak-to-strong upgrade', () => {
  assert.notEqual(modalityIssue('尽量周五前给我', '必须在周五前给我。'), '')
})
test('modality issue flags question-to-directive', () => {
  assert.notEqual(modalityIssue('可以周五前给我吗', '请你在周五前给我。'), '')
})
test('modality issue accepts preserved modality', () => {
  assert.equal(modalityIssue('尽量在周五前给我 3 个方案', '请尽量在周五前给我 3 个方案。'), '')
  assert.equal(modalityIssue('必须周五前给我 3 个方案', '请必须在周五前给我 3 个方案。'), '')
  assert.equal(modalityIssue('可以周五前给我吗', '请确认能否在周五前给我。'), '')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
