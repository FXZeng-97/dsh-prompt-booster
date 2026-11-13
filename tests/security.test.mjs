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
  isSameText,
  isShallowVariant,
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

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
