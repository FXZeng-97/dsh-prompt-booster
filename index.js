/**
 * @local/prompt-booster —— Host 半边。
 *
 * 仅做两件事：
 *  1. 在 DSH Web server 上注册 /prompt-booster 路由（/health、/enhance、/diag）；
 *  2. 通过 ctx.llm 流式调用模型，把用户草稿改写成更完整的提示词。
 *
 * 浏览器侧按钮在 client.js（slot conversation.input.right）。
 * 这里刻意只依赖 node 内置模块，避免本地插件解析 @deepseek-ai/* 包的问题。
 */
import { mkdirSync, appendFileSync, readFileSync, lstatSync, realpathSync, statSync, readdirSync, renameSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, sep } from 'node:path'
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
import { fileURLToPath } from 'node:url'

export const name = 'prompt-booster'

const ROUTE_PREFIX = '/prompt-booster'
const MAX_BODY_BYTES = 1024 * 1024
const DIAG_FILE = fileURLToPath(new URL('./data/diag.jsonl', import.meta.url))
const DIAG_MAX_BYTES = 2 * 1024 * 1024
const PROJECT_CONTEXT_TTL_MS = 90 * 1000
const PROJECT_CONTEXT_MAX_ENTRIES = 50
const RATE_WINDOW_MS = 60 * 1000
const RATE_MAX_OTHER = 120
const BODY_READ_TIMEOUT_MS = 15000
const MODEL_INFO_TIMEOUT_MS = 5000
/** 每次插件激活生成一个页面 token；浏览器页面通过 index 注入的全局变量拿到它。 */
const PAGE_TOKEN = randomBytes(24).toString('hex')
const PAGE_TOKEN_HEADER = 'x-pb-token'
const PAGE_TOKEN_GLOBAL = '__PROMPT_BOOSTER_TOKEN__'

const DEFAULTS = {
  provider: '',
  model: '',
  reasoningEffort: '',
  temperature: 0,
  maxInputChars: 20000,
  maxOutputTokens: 500,
  timeoutMs: 60000,
  systemPrompt: '',
  projectContext: true,
  contextMaxChars: 1000,
  conversationContext: true,
  rateLimitPerMinute: 20,
  maxConcurrentEnhance: 2,
  allowClientProject: false,
  diag: true,
}

/** 内置增强指令：忠于原意的最小增强 + 短句 + 长度硬上限 + 上下文不得新增要求 + 疑问保留条件句。 */
const SYSTEM_PROMPT = [
  "你是「提示词增强器」。用户写一段草稿，你把它优化成一条更清楚、更好执行的提示词，返回给用户发送。",
  "要求：忠于原意，句子短，表达直白，尽量简洁。",
  "",
  "【最高目标（其他规则都服从它）】",
  "0a. 忠于原意：目标、对象、事实、语气、约束不变；不编造、不丢关键信息。",
  "0b. 便于执行端（另一个 LLM）理解和执行：动作清楚、对象清楚、产出形式清楚、约束清楚；消除指代和歧义；保留原句术语与数据。",
  "0c. 两者冲突时：先保原意，再把话说清楚；不得为了「变化」或「简短」牺牲可执行性。",
  "",
  "【原则】",
  "1. 忠于原意：目标、对象、篇幅、语气不变。不加用户没提的交付范围。输出语言必须和草稿一致：英文草稿全用英文，中文草稿全用中文，禁止混用。",
  "2. 不编造：数据、型号、路径、结论一律不能编。用户给的数字照抄。缺指标就写「作概括表述」。",
  "3. 草稿没说的受众、结构、篇幅、格式、交付范围，一律不补；例外：模糊目标的判定维度和受众的判定标准属于执行方法（见【目标解析】【人物视角】），不算新增需求。",
  "4. 「…吧？」「应该…了吧」「可以写个…」是确定语气（用户已经知道或已经决定），按事实和结论直接写，不要改成「若…则…」，也不要让执行者再确认。只有真正的疑问（「…吗？」「是否…？」「要不要…？」「哪个？」）才保留成疑问或条件句。",
  "",
  "【只改写，不回答（最重要）】",
  "4a. 你是改写器，不是回答器：输出必须是「请对方做什么」的任务描述，不是任务结果。禁止输出答案、解释、操作步骤、命令、清单内容。",
  "4b. 草稿是问句（…吗/哪些/怎么/如何/多少/是否）时：改写成「请回答/请列出/请说明…」的请求，不得直接回答，也不得保留成反问句。",
  "4c. 即使草稿要求「列出步骤/给出方案/写清楚」，也只写这个要求本身，不得展开具体步骤、条目或方案内容。",
  "4d. 草稿本身已经是答案/步骤清单时：改写成「请整理/列出…」的任务描述，删除答案内容，不要保留清单。",
  "4e. 问句只改写成一句请求，不要把同一个要求写两遍（如「请列出…请给出…」）。",
  "5. 上下文只用来消解指代（「这个插件」「这段说明」「初版」指什么）和核对数据来源；不得用来新增受众、结构、篇幅、格式要求。最近对话按轮取最近 2 轮：以【最近一轮对话】为主（约 65% 参考权重），【更早一轮对话】只作辅助（约 35%）；两者冲突时以最近一轮为准。",
  "",
  "【目标解析：模糊目标 → 判定维度（通用规则）】",
  "G1. 草稿出现模糊的质量/改进目标（好看、美观、好用、高级、专业、清楚、简洁、流畅、稳定、快、高效、有说服力、优化、改进、提升、整理、美化、体验、效果、质量…）时，先解析目标，再写任务。",
  "G2. 解析三步：① 确定对象（草稿里的对象；没有就用上下文能确定的泛指，如「当前页面」「这段内容」「现有方案」，不编具体对象）；② 先定义「好」在本对象上的判定标准，展开成 3~5 个可验证维度；③ 任务写成「请从 A、B、C…角度分析<对象>的现状，指出问题，给出优化方案/建议（可先试优化，并说明预期效果）」。",
  "G3. 维度按「目标词 + 对象」选择，不能按对象套错类：同一对象不同目标用不同维度（页面的『好看』用视觉维度，页面的『体验/好用』用交互维度）。示例，不要照抄、不要堆满：页面/按钮「好看」→ 布局对齐、间距节奏、颜色与对比、视觉层级与重点、组件一致性、点击反馈；页面/产品「体验/好用」→ 可发现性、操作路径、反馈及时性、错误处理、状态一致、可访问性、性能感知；文档「清楚」→ 结构、术语一致、信息完整、示例、无歧义、可执行步骤；方案「专业」→ 目标范围、依据数据、可行性与成本、风险限制、落地步骤、验收标准；性能「提升」→ 基线测量、瓶颈定位、优化手段、预期收益、回归验证；日志「整理」→ 字段规范、去重合并、分类归档、命名规则、异常提取、保留策略；代码「整洁」→ 命名、分层、重复度、可读性、注释、测试。",
  "G4. 这些维度是「分析角度/执行方法」，不是新增需求：不编造事实、不替用户决定具体改法；只让执行端先分析、再给方案或建议。",
  "G5. 纯机械任务（翻译、压缩到 N 字、改格式、提取字段、改写一句）不套用目标解析，按原要求直接改写。",
  "",
  "【人物视角：受众 → 判定标准（通用规则）】",
  "P1. 草稿出现「给X看/向X说明/汇报给X/让X判断/给X评审」时，先解析 X：角色、要做的决定、评判标准、需要的信息；任务写成「以 X 的视角，按 X 的判断标准组织」，并说明输出形式（结论、证据、风险、建议等）。",
  "P2. 角色标准示例（按对象选 2~4 条，不要堆）：总监/老板→ 值不值得做、投入与成本、收益、风险、推进建议（结论先行）；新同事→ 从零开始、每步可照做、前置条件、常见坑（按操作顺序）；客户→ 对他的价值、可信证据、成本周期、交付与售后；评审/专家→ 目标范围、依据、备选方案对比、风险边界；投资/商务→ 市场增长、数据、竞争、回报与风险。",
  "P3. 受众是「组织信息的方式」，不是新增事实：草稿没写受众就不写；写了就必须按该角色的关注点组织，不能只贴标签。",
  "",
  "【任务画像与执行契约（通用规则）】",
  "R1. 先判断草稿属于哪类任务，再补该类任务执行端所需的最低信息；补的是「执行要素」，不是新增业务要求。",
  "R2. 常见任务类型的执行契约（按需取用，不要堆砌）：",
  "- 写作/汇报/邮件：读者、目的、结论先行、结构与依据、语气、长度；",
  "- 方案/分析/调研：目标与范围、依据/来源、备选方案与对比、风险与限制、落地步骤、验收标准；",
  "- 代码/脚本/命令：输入输出、边界与异常、运行环境/方式、依赖、验证或测试；",
  "- 设计/视觉/交互：对象与现状、判定维度、约束（品牌/平台/可访问性）、交付形式；",
  "- 计划/排期：目标、里程碑、依赖、资源、风险与缓冲；",
  "- 决策/选型：选项、评估维度与权重、推荐结论、理由与风险；",
  "- 修改/润色/翻译/压缩：只改指定范围、保留原意/格式/术语、说明修改点（如需）；",
  "- 问答/研究：问题边界、时效、来源要求、输出形式；",
  "- 沟通/回复：对象、目的、语气、关键要点、期望行动项；",
  "- 排障/操作：环境、现象、步骤、前置条件、回滚/验证。",
  "R3. 信息缺口：草稿缺少执行必需信息（对象、输入、格式、验收）时，不编造；写成「若缺少 X，先列出缺失项并按合理假设继续，标注假设」。",
  "R4. 冲突/多目标：要求之间可能冲突时写明优先级或让执行端给取舍方案；多个交付物/目标逐项保留，不合并丢失。",
  "R5. 高风险：涉及删除/覆盖/上线/发布/生产/财务/法律/医疗/隐私/密钥时，任务里要求先确认、备份/回滚、标注依据与不确定性。",
  "R6. 迭代方向：草稿说换方向/重写/否定上一版时，按新方向；说只改某处时，明确保留其余部分。",
  "R7. 以上是执行方法，不是新增业务需求；不得编造事实、数字、对象、受众。",
  "",
  "【允许补全（仅当草稿明确要求时）】",
  "6. 写文档/报告/方案：可给 3~4 个短结构词，如「价值概述、能力亮点、落地形态」；用户说「写一句/一段/改写这句」时保持原形态，不拆分。",
  "8. 草稿明确写了篇幅/格式：照原意落成一句可执行的话；没写就绝不加「一页内」「字数」等要求。",
  "",
  "【执行端可执行性】",
  "8a. 把含糊动作落成可执行动作：做什么、对什么做、产出什么；草稿没给的事实不编。",
  "8b. 结合上下文把「这个/那个/它」消解成明确对象；没有上下文就保留原指代，不编造具体对象。",
  "8c. 草稿明确要求的结构、受众、篇幅、格式必须保留并写清；没要求的不加。",
  "8d. 输出前自检：执行端能否直接照做？原意是否保留？有没有编造或遗漏？",
  "",
  "【写法：短句直给】",
  "9. 每句不超过 30 字，一个短句只说一个意思。多用句号、分号。不用长定语、括号嵌套、破折号插入语。",
  "10. 短草稿写成 2~5 句；原文超过 200 字时压缩成 1 段，不要改成编号列表（列表会变长）。任何情况都不要输出编号步骤列表（那是答案，不是提示词）。不要 Markdown 标题分级，不要四件套模板，不要空泛套话。",
  "11. 数据、路径、型号照抄；只改表达方式和任务要求，不改事实。",
  "",
  "【长度硬上限】",
  "12. 原文 ≤60 字：输出 60~160 字；原文 60~200 字：输出不超过原文 1.3 倍；原文 >200 字：输出必须不超过原文字数，只压缩整理，不扩写、不加列表。",
  "13. 任何情况中文不超过 300 字，英文不超过 180 词。",
  "",
  "【稳定性与禁止项】",
  "14. 同一草稿多次增强应同构：段落数、要点数一致，字数差不超过 20%。",
  "15. 不额外向用户提问；禁止「要 Word 还是 Markdown」这类自造问题，也尽量不用「请确认」开头。草稿带问号在确认事实时，用「若…则…」条件句表达，不要直接断言。",
  "16. 只输出提示词本身：没有前言、没有修改说明、没有对话分析、不用代码围栏包全文。语言跟原文一致，代码、命令、路径、型号原样保留。",
  "17. 若草稿已经是一条请求式提示词：只做同义压缩和措辞微调，不新增事实、步骤、清单或要求，输出长度不超过输入。",
  "",
  "【多次增强：连续纠正】",
  "18. 消息里带【原句】和【上一版增强】时按纠正流程处理：原句是最高权重，目标、对象、事实、语气都以原句为准。",
  "19. 上一版可能对也可能错：只修正不符合原意、没有依据、或把问题答成答案的部分；正确的措辞、结构、已有要求必须保留，不要整段重写，也不要因为再次增强就否定上一版。",
  "20. 不新增原句没有的要求；输出长度不超过原句与上一版中较大者的 1.1 倍。",
  "21. 每次增强都要有可见的表达变化：重新理解原句意图，换一种更准确或更顺的句式（调整句子结构、拆分/合并短句、调整信息顺序、换用更准确的对象表述）。变化必须让表达更清楚或更利于执行，不得为变而变，不得弱化约束、省略信息或改变重点。",
  "22. 不许用换标点、换连接词、换同义词来充当变化（「请列出」↔「请给出」这种不算）；变化要落在语义理解和文字表达上，但目标、事实、要求、受众不能变。",
].join('\n')

/** 上一版答成答案时的修正提示（保留正确内容，只把答案改回请求）。 */
const ANSWER_GUARD_PROMPT = [
  '【本次特别注意】',
  '上一版把问题答成了答案，不是提示词。',
  '请对照原句修正：只把答案/步骤内容改回请求，保留原句里的对象、事实和上一版正确的措辞与结构。',
  '不要整段重写，不要退化成空泛模板。',
].join('\n')

/** 再次增强与上一版太接近时的两种更强改写提示（先结构、再表达）。 */
const VARIATION_PROMPTS = [
  [
    '【本次特别注意】',
    '上一版与当前太接近，几乎只是换了同义词或连接词。',
    '请在不改变目标、事实、要求、受众的前提下，改变句子结构或组织顺序：',
    '例如合并或拆分短句、调整「先…再…」的顺序、换用更准确的对象表述。',
    '不得只改标点、连接词或同义词，也不得新增要求。',
  ].join('\n'),
  [
    '【本次特别注意】',
    '上一版与当前仍然很像，需要换一种表达方式。',
    '请先想清楚原句真正想要什么，再用另一种句式（问句/请求句/分句式）表达；',
    '可以调整信息顺序和重点位置，但原意、事实、要求不变，不得新增要求。',
  ].join('\n'),
]

/** 比较两次增强文本是否"实质相同"（忽略空白与标点）。 */
function normalizeForCompare(text) {
  return String(text || '')
    .replace(/\s+/g, '')
    .replace(/[，。；：！？、,.!?;:'"“”‘’（）()\[\]【】《》<>—\-…·]/g, '')
}

function isSameText(a, b) {
  return normalizeForCompare(a) === normalizeForCompare(b)
}

function bigramSet(text) {
  const chars = [...text]
  const set = new Set()
  for (let index = 0; index < chars.length - 1; index += 1) set.add(chars[index] + chars[index + 1])
  return set
}

/** 字符二元组 Jaccard 相似度（0~1）：用来识别"只换词不换结构"的浅层改写。 */
function bigramSimilarity(a, b) {
  const left = normalizeForCompare(a)
  const right = normalizeForCompare(b)
  if (!left || !right) return 0
  if (left === right) return 1
  const leftSet = bigramSet(left)
  const rightSet = bigramSet(right)
  if (!leftSet.size || !rightSet.size) return 0
  let inter = 0
  for (const gram of leftSet) if (rightSet.has(gram)) inter += 1
  return inter / (leftSet.size + rightSet.size - inter)
}

/** 与上一版"几乎一样"（含只换标点/连接词/同义词）返回 true。 */
function isShallowVariant(previous, next) {
  const left = normalizeForCompare(previous)
  const right = normalizeForCompare(next)
  if (!left || !right) return true
  if (left === right) return true
  return bigramSimilarity(previous, next) >= 0.55
}

/** 首次增强直接用草稿；多次增强时把原句作为最高权重、上一版作为待纠正的候选。 */
function buildEnhanceUserText({ text, base, contextText }) {  const draft = String(text || '')
  const original = typeof base === 'string' ? base.trim() : ''
  if (!original || original === draft.trim()) {
    return contextText ? `${contextText}\n\n【草稿】\n${draft}` : draft
  }
  const parts = []
  if (contextText) parts.push(contextText)
  parts.push('【原句（最高权重，忠于原意）】\n' + original)
  parts.push('【上一版增强（保留正确部分，只修正偏差）】\n' + draft)
  parts.push(
    '【本次任务】对照原句修正上一版：只改不符合原意、没有依据、或把问题答成答案的部分；' +
      '保留正确的措辞、结构和已有要求；不新增原句没有的要求；直接输出最终提示词。',
  )
  return parts.join('\n\n')
}

/* 模糊目标/受众检测：只在 Host 侧追加"解析提示"，帮助模型按通用规则展开。 */
const VAGUE_GOAL_RE =
  /(好看|美观|漂亮|好用|易用|高级|专业|清楚|清晰|简洁|流畅|稳定|高效|有说服力|优化|改进|提升|整理|美化|体验|效果|质量|靠谱|合理|完善|加强|丰富|精简|打磨|更好|更顺手|更有价值)/
const MECHANICAL_RE =
  /(翻译成|翻译为|压缩到|缩到|扩写到|改成|改为|提取|导出|转换成|换算|写一句|改写这句|补全|转成|格式|精简到|缩短到)/
const TASK_TYPE_RE =
  /(写个|写一份|撰写|报告|方案|周报|汇报|邮件|复盘|PRD|需求|设计|页面|界面|按钮|代码|脚本|函数|接口|SQL|正则|命令|部署|安装|配置|排查|报错|bug|测试|审查|重构|分析|调研|对比|选型|计划|排期|文案|标题|翻译|压缩|改写|润色|总结|纪要|演讲|PPT)/
const RISK_RE = /(删除|删掉|覆盖|上线|发布|生产环境|财务|法务|医疗|隐私|密钥|权限|合同|合规|用户数据|个人信息)/
const AUDIENCE_RE =
  /(?:给|向|让|供)([^，。；\n]{1,16}?)(?:看|汇报|说明|判断|评审|过目|决策|阅读)|(总监|老板|领导|客户|新同事|同事|团队|评审|专家|投资|甲方|用户)/

/** 根据草稿返回"任务解析提示"；无匹配时返回空。 */
function buildTaskHint(text) {
  const value = String(text || '').trim()
  if (!value) return ''
  const vague = VAGUE_GOAL_RE.test(value)
  const mechanical = MECHANICAL_RE.test(value) && !vague
  const goal = vague && !mechanical
  const taskType = TASK_TYPE_RE.test(value) && !mechanical
  const risk = RISK_RE.test(value)
  const audienceMatch = AUDIENCE_RE.exec(value)
  const audience = !!audienceMatch && !/^(我|自己|我们)$/.test(audienceMatch[1] || '')
  if (!goal && !audience && !taskType && !risk) return ''
  const lines = ['【任务解析提示】']
  if (goal) {
    lines.push(
      '- 草稿含模糊目标：按【目标解析】先定义「好」在本对象上的判定标准，展开 3~5 个可验证维度，' +
        '写成「从这些角度分析现状→指出问题→给出优化方案/建议」。',
    )
  }
  if (audience) {
    lines.push(
      '- 草稿指定了受众：按【人物视角】先分析该角色的决策关注点和评判标准，' +
        '任务按该视角组织，不要只贴「给X看」的标签。',
    )
  }
  if (taskType) {
    lines.push('- 按【任务画像】R2 补该类任务执行端所需的最低信息（输入/产出/约束/验收），不要堆砌、不新增业务要求。')
  }
  if (risk) {
    lines.push('- 草稿涉及高风险操作/领域：按 R5 在任务里要求先确认、备份/回滚、标注依据与不确定性。')
  }
  lines.push('- 维度/标准/契约是执行方法，不是新增事实或具体改法；原意、对象、约束不变。')
  return lines.join('\n')
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function diag(enabled, entry) {
  if (!enabled) return
  try {
    mkdirSync(dirname(DIAG_FILE), { recursive: true })
    try {
      if (statSync(DIAG_FILE).size > DIAG_MAX_BYTES) renameSync(DIAG_FILE, DIAG_FILE + '.1')
    } catch {
      /* 不存在或轮转失败都不影响追加 */
    }
    appendFileSync(DIAG_FILE, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n', 'utf8')
  } catch {
    /* 诊断失败不影响主流程 */
  }
}

/** 严格回环判断：先确认是合法 IP 字面量，再判断 127/8、::1 与 IPv4-mapped IPv6。 */
function isLoopbackAddress(address) {
  if (typeof address !== 'string' || !address) return false
  const value = address.toLowerCase().replace(/^\[|\]$/g, '')
  const family = isIP(value)
  if (family === 4) return value.startsWith('127.')
  if (family === 6) {
    if (value === '::1') return true
    if (!value.startsWith('::ffff:')) return false
    const mapped = value.slice('::ffff:'.length)
    return isIP(mapped) === 4 && mapped.startsWith('127.')
  }
  return false
}

function isHttpOrigin(origin) {
  return origin.startsWith('http://') || origin.startsWith('https://')
}

function tokensEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || a.length !== b.length) return false
  let diff = 0
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index)
  return diff === 0
}

/**
 * Host 头必须存在、是回环名，且端口等于 Web server 实际监听端口。
 * 攻击者域名（DNS rebinding）即使解析到 127.0.0.1，Host 也不是回环名或端口不符，会被拒绝。
 */
function hostHeaderMatches(req, expectedPort) {
  const raw = typeof req.headers.host === 'string' ? req.headers.host.trim() : ''
  if (!raw || raw.length > 300 || /[\\/\s@]/.test(raw)) return false
  let parsed
  try {
    parsed = new URL('http://' + raw)
  } catch {
    return false
  }
  const hostname = parsed.hostname.toLowerCase()
  const host = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname
  if (host !== 'localhost' && !isLoopbackAddress(host)) return false
  if (Number.isInteger(expectedPort)) {
    const port = parsed.port ? Number(parsed.port) : 80
    if (port !== expectedPort) return false
  }
  return true
}

/**
 * 请求信任判定：
 * 1) 必须来自回环地址（严格 IP 校验）；
 * 2) Host 必须是回环名，端口必须等于实际监听端口（防 DNS rebinding）；
 * 3) 拒绝 `sec-fetch-site: cross-site`；
 * 4) Origin：无 Origin/null/自定义协议（桌面壳）放行；http(s) 必须同源且携带页面 token；
 * 5) 页面 token 由 index 注入 `__PROMPT_BOOSTER_TOKEN__`，浏览器页面通过请求头回传。
 */
function evaluateRequestTrust(req, options) {
  const remote = req.socket && req.socket.remoteAddress
  if (!isLoopbackAddress(remote)) return { ok: false, status: 403, reason: 'not-loopback', origin: '' }
  if (!hostHeaderMatches(req, options && options.expectedPort)) return { ok: false, status: 403, reason: 'host-mismatch', origin: '' }
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase()
  if (site === 'cross-site') return { ok: false, status: 403, reason: 'cross-site', origin: '' }
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : ''
  const pageToken = typeof req.headers[PAGE_TOKEN_HEADER] === 'string' ? req.headers[PAGE_TOKEN_HEADER] : ''
  if (!origin || origin === 'null') return { ok: true, origin: '' }
  if (isHttpOrigin(origin)) {
    let parsed
    try {
      parsed = new URL(origin)
    } catch {
      return { ok: false, status: 403, reason: 'bad-origin', origin: '' }
    }
    const host = typeof req.headers.host === 'string' ? req.headers.host : ''
    if (!host || parsed.host !== host) return { ok: false, status: 403, reason: 'bad-origin', origin: '' }
    if (!tokensEqual(pageToken, PAGE_TOKEN)) return { ok: false, status: 403, reason: 'token-required', origin: '' }
    return { ok: true, origin }
  }
  // 非 http(s) 自定义协议（桌面壳）：web 页面无法用它发起可读响应，仍要求回环 + Host 校验
  return { ok: true, origin }
}

function corsHeadersFor(origin) {
  if (!origin || origin === 'null') return {}
  return {
    'access-control-allow-origin': origin,
    vary: 'Origin',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-pb-token',
    'access-control-max-age': '600',
  }
}

function send(res, code, obj) {
  if (res.writableEnded) return
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  for (const [key, value] of Object.entries(corsHeadersFor(res.pbOrigin))) res.setHeader(key, value)
  res.end(JSON.stringify(obj))
}

/** 内存限流：按 远端地址 + 桶 计数，滑动窗口 60s。 */
const rateBuckets = new Map()
function rateLimitOk(bucket, address, limit) {
  const now = Date.now()
  const key = bucket + ':' + String(address || '')
  let entry = rateBuckets.get(key)
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + RATE_WINDOW_MS }
    rateBuckets.set(key, entry)
  }
  entry.count += 1
  if (rateBuckets.size > 2000) {
    for (const [bucketKey, value] of rateBuckets) {
      if (value.resetAt <= now) rateBuckets.delete(bucketKey)
    }
  }
  return entry.count <= limit
}

function hasJsonContentType(req) {
  const value = String(req.headers['content-type'] || '').toLowerCase()
  return value.split(';')[0].trim() === 'application/json'
}

/** 读取请求体：带总超时，防止慢速连接长期占用并发名额。 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    let timer = null
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      callback(value)
    }
    timer = setTimeout(() => {
      finish(reject, Object.assign(new Error('读取请求体超时'), { status: 408 }))
      try {
        req.destroy()
      } catch {
        /* 已关闭 */
      }
    }, BODY_READ_TIMEOUT_MS)
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        finish(reject, Object.assign(new Error('请求体过大'), { status: 413 }))
        try {
          req.destroy()
        } catch {
          /* 已关闭 */
        }
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => finish(resolve, Buffer.concat(chunks)))
    req.on('error', (err) => finish(reject, err))
    req.on('aborted', () => finish(reject, Object.assign(new Error('请求已中断'), { status: 400 })))
  })
}

/* 诊断脱敏：事件名白名单 + 结构化字段白名单，不落盘自由文本。 */
const DIAG_EVENT_RE = /^(client-(apply|mounted|apply-error)|enhance-(click|applied|undo|step-back|failed)|verify-probe)$/
const DIAG_DETAIL_KEYS = new Set([
  'rendered',
  'buttons',
  'slot',
  'sessions',
  'hardened',
  'security',
  'chars',
  'charsIn',
  'charsOut',
  'hasProject',
  'hasSession',
  'hasBase',
  'tokenPresent',
  'chatTurns',
])
function sanitizeDiagDetail(detail) {
  if (!detail || typeof detail !== 'object') return undefined
  const output = {}
  for (const [key, value] of Object.entries(detail)) {
    if (!DIAG_DETAIL_KEYS.has(key)) continue
    if (typeof value === 'boolean' || typeof value === 'number') {
      output[key] = value
      continue
    }
    if (typeof value === 'string' && value.length <= 40 && /^[\w.:-]+$/.test(value)) output[key] = value
  }
  return Object.keys(output).length ? output : undefined
}

/** 给任意 Promise 套硬超时（模型元数据查询等可能不响应 abort 的调用）。 */
function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Object.assign(new Error(label || '操作超时'), { status: 504 })),
      timeoutMs,
    )
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function clampInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function normalizeConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {}
  const provider = typeof cfg.provider === 'string' ? cfg.provider.trim() : ''
  const model = typeof cfg.model === 'string' ? cfg.model.trim() : ''
  const systemPrompt = typeof cfg.systemPrompt === 'string' && cfg.systemPrompt.trim() ? cfg.systemPrompt : SYSTEM_PROMPT
  return {
    provider: provider && model ? provider : '',
    model: provider && model ? model : '',
    reasoningEffort: typeof cfg.reasoningEffort === 'string' ? cfg.reasoningEffort.trim() : '',
    temperature: Number.isFinite(Number(cfg.temperature)) ? Math.min(2, Math.max(0, Number(cfg.temperature))) : DEFAULTS.temperature,
    maxInputChars: clampInt(cfg.maxInputChars, DEFAULTS.maxInputChars, 200, 200000),
    maxOutputTokens: clampInt(cfg.maxOutputTokens, DEFAULTS.maxOutputTokens, 128, 16000),
    timeoutMs: clampInt(cfg.timeoutMs, DEFAULTS.timeoutMs, 5000, 600000),
    systemPrompt,
    projectContext: cfg.projectContext === false ? false : true,
    contextMaxChars: clampInt(cfg.contextMaxChars, DEFAULTS.contextMaxChars, 500, 20000),
    conversationContext: cfg.conversationContext === false ? false : true,
    rateLimitPerMinute: clampInt(cfg.rateLimitPerMinute, DEFAULTS.rateLimitPerMinute, 1, 120),
    maxConcurrentEnhance: clampInt(cfg.maxConcurrentEnhance, DEFAULTS.maxConcurrentEnhance, 1, 8),
    allowClientProject: cfg.allowClientProject === true,
    diag: cfg.diag === false ? false : true,
  }
}

/** 解析增强路由：config 固定 > agentDefaultModel 的当前默认 > null。 */
function resolveRoute(ctx, cfg) {
  if (cfg.provider && cfg.model) {
    return { provider: cfg.provider, model: cfg.model, reasoningEffort: cfg.reasoningEffort || undefined, source: 'config' }
  }
  try {
    const service = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : undefined
    const selection = service && typeof service.currentSelection === 'function' ? service.currentSelection() : undefined
    if (selection && selection.provider && selection.model) {
      return {
        provider: String(selection.provider),
        model: String(selection.model),
        reasoningEffort: cfg.reasoningEffort || undefined,
        source: 'agent-default-model',
      }
    }
  } catch {
    /* 服务缺失时保持 null，由调用方报错 */
  }
  return null
}

/** 兜底清理模型输出：去整体代码围栏、去“以下是…”类前言。 */
function cleanOutput(raw) {
  let text = String(raw == null ? '' : raw).replace(/\r\n/g, '\n').trim()
  const fence = text.match(/^```[A-Za-z0-9_+-]*[ \t]*\n([\s\S]*?)\n```[ \t]*$/)
  if (fence) text = fence[1].trim()
  else text = text.replace(/^```[A-Za-z0-9_+-]*[ \t]*\n([\s\S]*?)\n```[ \t]*(?:\n|$)/, '$1').trim()
  text = text
    .replace(/^(?:以下是|下面是|这就是|这是)[^\n]{0,40}[：:][ \t]*\n+/, '')
    .replace(/^(?:优化后|增强后|改写后)的?提示词[：:][ \t]*\n+/, '')
    .replace(/^【?增强后的提示词】?[：:][ \t]*\n+/, '')
  return text.trim()
}

/* ------------------------------------------------------------------ */
/* 项目上下文                                                          */
/* ------------------------------------------------------------------ */

const projectContextCache = new Map()

/** 解析项目目录为真实路径（realpath）；失败返回空。 */
function realProjectDir(cwd) {
  if (!cwd || !isAbsolute(cwd)) return ''
  try {
    const real = realpathSync(cwd)
    if (!statSync(real).isDirectory()) return ''
    return real
  } catch {
    return ''
  }
}

/**
 * 受限读取项目内普通文件：
 * - 拒绝符号链接（防 AGENTS.md 等被链接到项目外敏感文件）；
 * - realpath 后必须仍在项目目录内（防目录逃逸）；
 * - 单文件 ≤1MB。
 */
function safeProjectFile(projectDir, name, maxChars) {
  if (!projectDir) return ''
  try {
    const filePath = join(projectDir, name)
    const stats = lstatSync(filePath)
    if (!stats.isFile() || stats.isSymbolicLink()) return ''
    if (stats.size > 1024 * 1024) return ''
    const real = realpathSync(filePath)
    const base = projectDir.endsWith(sep) ? projectDir : projectDir + sep
    if (!real.startsWith(base)) return ''
    return readFileSync(real, 'utf8').slice(0, maxChars)
  } catch {
    return ''
  }
}

function packageHints(projectDir) {
  const hints = []
  const raw = safeProjectFile(projectDir, 'package.json', 200000)
  if (raw) {
    try {
      const pkg = JSON.parse(raw)
      if (pkg.name) hints.push('包名：' + String(pkg.name).slice(0, 80))
      const deps = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }).slice(0, 12)
      if (deps.length) hints.push('dependencies：' + deps.join(', '))
      const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? Object.keys(pkg.scripts).slice(0, 10) : []
      if (scripts.length) hints.push('scripts：' + scripts.join(', '))
    } catch {
      /* 无法解析的 package.json：忽略 */
    }
  }
  const manifests = [
    ['pyproject.toml', 'Python(pyproject.toml)'],
    ['requirements.txt', 'Python(requirements.txt)'],
    ['Cargo.toml', 'Rust(Cargo.toml)'],
    ['go.mod', 'Go(go.mod)'],
    ['pom.xml', 'Java(Maven)'],
    ['composer.json', 'PHP(composer.json)'],
  ]
  for (const [file, label] of manifests) {
    const text = safeProjectFile(projectDir, file, 1200)
    if (!text) continue
    hints.push(label + '：' + text.split('\n').filter(Boolean).slice(0, 8).join(' | ').replace(/\s+/g, ' ').slice(0, 300))
  }
  return hints
}

/** git 分支：异步 + 硬超时，避免阻塞 Host 事件循环。 */
function gitHints(projectDir) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', projectDir, 'rev-parse', '--abbrev-ref', 'HEAD'],
      { timeout: 4000, windowsHide: true, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve('')
          return
        }
        const branch = String(stdout || '').trim().split(/\r?\n/).filter(Boolean)[0] || ''
        resolve(branch ? `git 分支：${branch}` : '')
      },
    )
  }).catch(() => '')
}

function normalizeProject(raw) {
  // 客户端只允许提供会话标题；项目路径只信 Host 会话元数据
  if (!raw || typeof raw !== 'object') return null
  const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, 200) : ''
  return title ? { title } : null
}

/** 只从 Host 会话元数据取权威 cwd；客户端传来的路径一律不信任。 */
function sessionCwdOf(ctx, sessionId) {
  try {
    if (!sessionId) return ''
    const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
    const session = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined
    const cwd = session && session.header && typeof session.header.cwd === 'string' ? session.header.cwd : ''
    return cwd && isAbsolute(cwd) ? cwd : ''
  } catch {
    return ''
  }
}

function emptyProjectContext() {
  return { text: '', info: { hasAgents: false, hasManifest: false } }
}

/** 项目上下文缓存：LRU，最多 PROJECT_CONTEXT_MAX_ENTRIES 条。 */
function cacheProjectContext(key, value) {
  projectContextCache.set(key, { at: Date.now(), value })
  while (projectContextCache.size > PROJECT_CONTEXT_MAX_ENTRIES) {
    const oldest = projectContextCache.keys().next().value
    if (oldest === undefined) break
    projectContextCache.delete(oldest)
  }
}

/** 把会话所在项目整理成精简上下文：只读受限普通文件、异步 git、90s 缓存。 */
async function buildProjectContext(project, cfg) {
  if (!cfg.projectContext || !project || !project.cwd) return emptyProjectContext()
  const key = project.cwd
  const cached = projectContextCache.get(key)
  if (cached && Date.now() - cached.at < PROJECT_CONTEXT_TTL_MS) return cached.value

  const projectDir = realProjectDir(project.cwd)
  if (!projectDir) {
    const value = emptyProjectContext()
    cacheProjectContext(key, value)
    return value
  }

  const parts = []
  const info = { hasAgents: false, hasManifest: false }
  const title = typeof project.title === 'string' ? project.title.trim().slice(0, 200) : ''
  if (title) parts.push('会话标题：' + title)
  parts.push('项目目录：' + projectDir + '（' + basename(projectDir) + '）')

  const names = []
  try {
    for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
      if (names.length >= 12) break
      if (!entry || typeof entry.name !== 'string') continue
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.DS_Store') continue
      if (typeof entry.isSymbolicLink === 'function' && entry.isSymbolicLink()) continue
      names.push(entry.name + (entry.isDirectory() ? '/' : ''))
    }
  } catch {
    /* 目录不可读：跳过 */
  }
  if (names.length) parts.push('顶层结构：' + names.join(', '))

  const hints = packageHints(projectDir)
  if (hints.length) {
    info.hasManifest = true
    parts.push(...hints)
  }
  for (const file of ['AGENTS.md', 'AGENTS.local.md', 'CLAUDE.md']) {
    const text = safeProjectFile(projectDir, file, 800)
    if (!text.trim()) continue
    info.hasAgents = true
    parts.push(`项目规范（${file}）：` + text.replace(/\s+/g, ' ').slice(0, 350))
    break
  }
  try {
    const git = await withTimeout(gitHints(projectDir), 5000, 'git 查询超时')
    if (git) parts.push(git)
  } catch {
    /* git 不可用或超时：忽略 */
  }

  let text = parts.join('\n')
  if (text.length > cfg.contextMaxChars) text = text.slice(0, cfg.contextMaxChars) + '\n…（上下文已截断）'
  const value = { text, info }
  cacheProjectContext(key, value)
  return value
}

/* ------------------------------------------------------------------ */
/* 最近对话                                                            */
/* ------------------------------------------------------------------ */

const CONVERSATION_MESSAGE_LIMIT = 4
const CONVERSATION_MESSAGE_MAX_CHARS = 400
const CONVERSATION_TOTAL_MAX_CHARS = 800
const CONVERSATION_RECENT_SHARE = 0.65
const CONVERSATION_OLDER_SHARE = 0.35

/** 一段对话按权重预算渲染：每条消息均分该段预算，段内超出从前面截断。 */
function formatConversationBlock(label, messages, budget) {
  if (!messages.length || budget <= 0) return ''
  const perMessage = Math.max(60, Math.floor(budget / messages.length))
  const lines = messages.map((message) => {
    const cap = Math.min(CONVERSATION_MESSAGE_MAX_CHARS, perMessage)
    const role = message.role === 'user' ? '用户' : '助手'
    return `${role}：${String(message.text).slice(0, cap)}`
  })
  let text = lines.join('\n')
  if (text.length > budget) text = '…' + text.slice(-budget)
  return `【${label}】\n${text}`
}

/**
 * 最近对话改为由客户端从当前页面 Chat 视图提取后传入（最多 4 条）。
 * Host 不再读取任何会话历史，避免凭 sessionId 越权读取其他会话内容。
 * 这里只做结构与长度校验：角色白名单、每条 ≤400 字、总计 ≤800 字。
 */
function recentFromBody(body) {
  if (!body || !Array.isArray(body.recent)) return { text: '', count: 0 }
  const valid = []
  for (let index = body.recent.length - 1; index >= 0 && valid.length < CONVERSATION_MESSAGE_LIMIT; index -= 1) {
    const item = body.recent[index]
    if (!item || typeof item !== 'object') continue
    const role = item.role === 'user' || item.role === 'assistant' ? item.role : ''
    if (!role) continue
    const raw = typeof item.text === 'string' ? item.text.trim() : ''
    if (!raw) continue
    valid.push({ role, text: raw.slice(0, CONVERSATION_MESSAGE_MAX_CHARS) })
  }
  if (!valid.length) return { text: '', count: 0 }
  valid.reverse()

  // 总长超预算时从最旧的消息开始丢弃，保证最近的对话优先保留
  let used = 0
  for (let index = valid.length - 1; index >= 0; index -= 1) {
    used += valid[index].text.length
    if (used > CONVERSATION_TOTAL_MAX_CHARS && valid.length > 1) valid.shift()
  }

  const recentRound = valid.slice(-2)
  const olderRound = valid.slice(0, Math.max(0, valid.length - 2))
  const recentBudget = Math.floor(CONVERSATION_TOTAL_MAX_CHARS * CONVERSATION_RECENT_SHARE)
  const olderBudget = CONVERSATION_TOTAL_MAX_CHARS - recentBudget
  const blocks = []
  const olderBlock = formatConversationBlock('更早一轮对话（次要参考）', olderRound, olderBudget)
  if (olderBlock) blocks.push(olderBlock)
  const recentBlock = formatConversationBlock('最近一轮对话（重点参考）', recentRound, recentBudget)
  if (recentBlock) blocks.push(recentBlock)
  return { text: blocks.join('\n\n'), count: valid.length }
}

/**
 * 上下文门控：只有当草稿确实依赖上下文时才带，避免把历史里的项目细节/受众/篇幅
 * 当成新要求写进增强结果（"开卷考试"）。
 * - 最近对话：短草稿（≤25 字，通常是回答/接话）或含明确指代词时带上；
 * - 项目上下文：草稿里出现页面/项目/插件/功能/组件等对象、或含指代词时带上。
 */
function draftNeedsContext(text) {
  const value = String(text || '').trim()
  const length = [...value].length
  const recentPointer = /(这个|那个|它|上述|前面|刚才|上面|就按|那就|这轮|这版)/.test(value)
  const projectPointer = /(页面|项目|插件|功能|后台|界面|组件|模块|仓库|代码库)/.test(value)
  return {
    recent: length <= 25 || recentPointer,
    project: length <= 80 && projectPointer,
  }
}

/* ------------------------------------------------------------------ */
/* 增强执行                                                            */
/* ------------------------------------------------------------------ */

/**
 * 读取该路由可选 reasoning effort（由低到高）。查不到就返回空数组。
 * 增强是辅助请求：默认走最低 effort 的快速路径，减少等待和 reasoning 吃光输出预算的概率。
 */
async function resolveEfforts(llm, route, signal) {
  try {
    if (!llm || typeof llm.resolveModelInfo !== 'function') return []
    const info = await withTimeout(
      llm.resolveModelInfo(route.provider, route.model, signal),
      MODEL_INFO_TIMEOUT_MS,
      '模型元数据查询超时',
    )
    const reasoning = info && info.reasoning
    return reasoning && Array.isArray(reasoning.efforts) ? reasoning.efforts : []
  } catch {
    return []
  }
}

/** 输出长度上限（与提示词规则一致）：Host 侧只度量不强制截断，结果里带 lengthOver。 */
function outputLengthCap(inputLength) {
  const base =
    inputLength <= 60
      ? Math.max(160, Math.round(inputLength * 3))
      : inputLength <= 200
        ? Math.round(inputLength * 1.3)
        : inputLength
  return Math.min(300, base)
}

function countNumberedLines(text) {
  const matches = String(text || '').match(/^\s*\d+[.、)]\s+\S/gm)
  return matches ? matches.length : 0
}

/** 单行内也统计 "1. xxx 2. xxx" 这种被压平的答案。 */
function countInlineNumbers(text) {
  const matches = String(text || '').match(/(?:^|[\s。；])\d{1,2}[.、)]\s+\S/g)
  return matches ? matches.length : 0
}

function hasActionContent(text) {
  return /(安装\s*(Git|Node|依赖)|执行\s*(git|npm|pnpm|命令)|新建仓库|创建仓库|第一步|步骤如下|运行\s*`|按顺序完成|直接照做|每步一句|每步写一句)/.test(
    String(text || ''),
  )
}

function hasRequestVerb(text) {
  return /(?:^|[。；\n！？!?])\s*(?:请|帮我|帮忙|麻烦)?\s*(列出|回答|说明|梳理|给出|整理|总结|分析|解释|告诉我)/.test(
    String(text || ''),
  )
}

/** 草稿本身是否是一段答案/步骤清单（编号 ≥2 或带答案式开头，且有具体动作）。 */
function draftIsAnswer(text) {
  const value = String(text || '')
  if (!hasActionContent(value)) return false
  const numbered = Math.max(countNumberedLines(value), countInlineNumbers(value))
  return numbered >= 2 || /(按顺序完成|直接照做|每步一句|每步写一句)/.test(value)
}

/**
 * 判断输出是否"答成了答案"：
 * - 草稿本身是答案/步骤清单：输出应是"请列出/请整理…"的请求，保留答案内容或清单都算答案；
 * - 草稿是问句/短请求，输出却出现 ≥2 行编号步骤 → 答案；
 * - 输出含具体执行内容（安装/执行命令/新建仓库/第一步），却没有"请对方…"的请求动词 → 答案。
 * 命中时由 Host 用更严格的系统提示重试一次（兜底，不保证 100%）。
 */
function looksLikeAnswer(draft, output) {
  const draftText = String(draft || '')
  const outText = String(output || '')
  if (!outText.trim()) return false
  if (draftIsAnswer(draftText)) {
    // 修正为请求：有请求动词、且没有再出现编号步骤，就视为已纠正（保留格式要求可以）
    const cleanRequest = hasRequestVerb(outText) && countNumberedLines(outText) < 2
    return !cleanRequest
  }
  if (countNumberedLines(outText) >= 2 && countNumberedLines(draftText) === 0) return true
  return hasActionContent(outText) && !hasRequestVerb(outText)
}

/** 单次流式尝试：收集文本、usage、终止原因；每次 next() 都有硬 deadline。 */
async function streamOnce({ llm, route, cfg, text, effort, maxTokens, signal, systemOverride, temperatureOverride }) {
  const controller = new AbortController()
  const deadline = Date.now() + cfg.timeoutMs
  const timer = setTimeout(() => controller.abort(new Error('enhance-timeout')), cfg.timeoutMs)
  const onAbort = () => controller.abort(new Error('client-abort'))
  if (signal) {
    if (signal.aborted) controller.abort(new Error('client-abort'))
    else signal.addEventListener('abort', onAbort, { once: true })
  }

  const startedAt = Date.now()
  let output = ''
  let usage = null
  let finishReason = null
  let iterator = null
  try {
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      ...(effort ? { reasoningEffort: effort } : {}),
      system: systemOverride || cfg.systemPrompt,
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      temperature: Number.isFinite(temperatureOverride) ? temperatureOverride : cfg.temperature,
      maxTokens,
      signal: controller.signal,
    })
    iterator = stream && typeof stream[Symbol.asyncIterator] === 'function' ? stream[Symbol.asyncIterator]() : null
    if (!iterator) throw Object.assign(new Error('模型服务未返回可读取的流'), { status: 502 })
    for (;;) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw Object.assign(new Error('模型调用超时'), { status: 504, code: 'TIMEOUT' })
      const next = await withTimeout(iterator.next(), remaining, '模型调用超时')
      if (!next || next.done) break
      const chunk = next.value
      if (!chunk || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta') output += chunk.text
      else if (chunk.type === 'usage') usage = chunk.usage
      else if (chunk.type === 'finish') {
        finishReason = chunk.reason
        break
      }
    }
  } catch (error) {
    if (error && error.status === 504) controller.abort(new Error('enhance-timeout'))
    throw error
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
    if (iterator && typeof iterator.return === 'function') {
      try {
        await withTimeout(Promise.resolve(iterator.return()), 1000, '流关闭超时')
      } catch {
        /* 关闭失败不影响结果 */
      }
    }
  }

  return { output, usage, finishReason, ms: Date.now() - startedAt, effort: effort || null, maxTokens }
}

function finishToError(finishReason) {
  const failure = finishReason.failure || {}
  const err = new Error(
    finishReason.kind === 'aborted'
      ? `模型调用被中断${failure.message ? '：' + failure.message : ''}`
      : `模型调用失败${failure.code ? '(' + failure.code + ')' : ''}${failure.message ? '：' + failure.message : ''}`,
  )
  err.status = finishReason.kind === 'aborted' ? 504 : 502
  err.code = failure.code
  return err
}

async function runEnhance({ ctx, cfg, text, base, contextText, signal }) {
  const llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
  if (!llm || typeof llm.stream !== 'function') {
    throw Object.assign(new Error('LLM 服务不可用'), { status: 503 })
  }
  const route = resolveRoute(ctx, cfg)
  if (!route) {
    throw Object.assign(new Error('未找到可用模型路由：请在插件 config 里指定 provider/model，或先配置默认模型'), { status: 503 })
  }
  // 多次增强 = 连续纠正：原句是最高权重，上一版作为待纠正候选；首次增强只看草稿。
  const basePromptText = buildEnhanceUserText({ text, base, contextText })
  const isCorrection = !!(base && String(base).trim() && String(base).trim() !== String(text).trim())
  const taskHint = buildTaskHint(isCorrection ? String(base || text) : text)
  const promptText = taskHint ? basePromptText + '\n\n' + taskHint : basePromptText

  const startedAt = Date.now()
  const efforts = await resolveEfforts(llm, route, signal)
  const explicit = route.reasoningEffort || ''
  const fastEffort = explicit || (efforts.length ? String(efforts[0].id) : '')
  const thoroughEffort = explicit || (efforts.length ? String(efforts[efforts.length - 1].id) : '')

  // 第一次：快速路径（最低 reasoning effort）。第二次：兜底（最高 effort + 更大输出预算），
  // 覆盖“reasoning 吃满 maxTokens 导致空输出”这类情况。
  const plans = [
    { label: 'fast', effort: fastEffort, maxTokens: cfg.maxOutputTokens },
    { label: 'thorough', effort: thoroughEffort, maxTokens: Math.max(cfg.maxOutputTokens, 4096) },
  ]

  const attempts = []
  for (const plan of plans) {
    const result = await streamOnce({
      llm,
      route,
      cfg,
      text: promptText,
      effort: plan.effort,
      maxTokens: plan.maxTokens,
      signal,
    })
    const attempt = {
      label: plan.label,
      effort: result.effort,
      maxTokens: plan.maxTokens,
      finish: result.finishReason ? result.finishReason.kind : 'none',
      rawChars: result.output.length,
      ms: result.ms,
    }
    attempts.push(attempt)
    diag(cfg.diag, { kind: 'enhance-attempt', ...attempt })

    if (result.finishReason && (result.finishReason.kind === 'error' || result.finishReason.kind === 'aborted')) {
      const err = finishToError(result.finishReason)
      err.detail = { attempts }
      throw err
    }

    const cleaned = cleanOutput(result.output)
    if (!cleaned) continue

    const buildResult = (value, res, guard, variation) => {
      const lengthCap = outputLengthCap([...text].length)
      return {
        text: value,
        mode: isCorrection ? 'correction' : 'fresh',
        provider: route.provider,
        model: route.model,
        routeSource: route.source,
        ms: Date.now() - startedAt,
        usage: res.usage || undefined,
        finish: res.finishReason ? res.finishReason.kind : 'stop',
        lengthCap,
        lengthOver: [...value].length > lengthCap,
        answerGuard: guard,
        variation: variation || 'ok',
        attempts,
      }
    }

    // 再次增强要有"表达层面"的变化：与上一版相同/只换词就调高温度、要求改句式再试
    if (isCorrection && (isSameText(text, cleaned) || isShallowVariant(text, cleaned))) {
      const shallow = !isSameText(text, cleaned)
      diag(cfg.diag, { kind: 'enhance-variation', reason: shallow ? 'shallow' : 'same', chars: [...cleaned].length })
      let best = null
      for (let attemptIndex = 0; attemptIndex < VARIATION_PROMPTS.length; attemptIndex += 1) {
        try {
          const variationTemp = attemptIndex === 0 ? 0.8 : 1.05
          const varied = await streamOnce({
            llm,
            route,
            cfg,
            text: promptText,
            effort: plan.effort,
            maxTokens: plan.maxTokens,
            signal,
            temperatureOverride: variationTemp,
            systemOverride: cfg.systemPrompt + '\n\n' + VARIATION_PROMPTS[attemptIndex],
          })
          attempts.push({
            label: 'variation-' + (attemptIndex + 1),
            effort: varied.effort,
            maxTokens: plan.maxTokens,
            finish: varied.finishReason ? varied.finishReason.kind : 'none',
            rawChars: varied.output.length,
            ms: varied.ms,
          })
          if (varied.finishReason && (varied.finishReason.kind === 'error' || varied.finishReason.kind === 'aborted')) {
            continue
          }
          const variedCleaned = cleanOutput(varied.output)
          if (!variedCleaned || looksLikeAnswer(text, variedCleaned)) continue
          if (!isSameText(text, variedCleaned) && !isShallowVariant(text, variedCleaned)) {
            return buildResult(variedCleaned, varied, 'ok', 'varied')
          }
          if (!best) best = { value: variedCleaned, res: varied }
        } catch {
          /* 微调重试失败：尝试下一种提示 */
        }
      }
      if (best) return buildResult(best.value, best.res, 'ok', 'shallow')
      return buildResult(cleaned, result, 'ok', 'same')
    }

    if (!looksLikeAnswer(text, cleaned)) return buildResult(cleaned, result, 'ok')

    // 上一版把任务答成答案时：只做"修正"重试（带上原句，保留正确部分），不退化成模板。
    diag(cfg.diag, { kind: 'enhance-answer-guard', mode: isCorrection ? 'correction' : 'fresh', charsOut: [...cleaned].length })
    try {
      const strictMaxTokens = Math.max(plan.maxTokens, 1024)
      const strictText = isCorrection
        ? promptText +
          '\n\n【修正要求】上一版把问题答成了答案；请改回请求，保留原句的对象、事实和上一版正确措辞，不要退化成空泛模板。'
        : promptText
      const strict = await streamOnce({
        llm,
        route,
        cfg,
        text: strictText,
        effort: plan.effort,
        maxTokens: strictMaxTokens,
        signal,
        systemOverride: cfg.systemPrompt + '\n\n' + ANSWER_GUARD_PROMPT,
      })
      attempts.push({
        label: 'answer-guard',
        effort: strict.effort,
        maxTokens: strictMaxTokens,
        finish: strict.finishReason ? strict.finishReason.kind : 'none',
        rawChars: strict.output.length,
        ms: strict.ms,
      })
      if (!strict.finishReason || (strict.finishReason.kind !== 'error' && strict.finishReason.kind !== 'aborted')) {
        const strictCleaned = cleanOutput(strict.output)
        if (strictCleaned && !looksLikeAnswer(text, strictCleaned)) {
          return buildResult(strictCleaned, strict, 'retried')
        }
      }
    } catch {
      /* 修正重试失败：返回第一版，不阻塞用户 */
    }
    return buildResult(cleaned, result, 'failed')
  }

  const err = Object.assign(new Error('模型没有返回可用内容，请重试或换个说法'), { status: 502 })
  err.detail = { attempts }
  throw err
}

/* ------------------------------------------------------------------ */
/* HTTP 路由                                                           */
/* ------------------------------------------------------------------ */

function makeHandler(ctx, cfg) {
  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
  const expectedPort = webServer && Number.isInteger(webServer.port) ? webServer.port : undefined

  const readJson = async (req, limit) => {
    const buf = await readBody(req, limit)
    if (!buf.length) return {}
    try {
      return JSON.parse(buf.toString('utf8'))
    } catch {
      throw Object.assign(new Error('请求体不是合法 JSON'), { status: 400 })
    }
  }

  let inflightEnhance = 0

  const describeOrigin = (value) => {
    if (!value) return 'absent'
    if (value === 'null') return 'null'
    if (value.startsWith('dsh-app:')) return 'desktop-shell'
    if (/^https?:\/\/(127\.|\[::1\]|localhost)/i.test(value)) return 'loopback-http'
    return 'other'
  }
  const describeSite = (value) => {
    if (!value) return 'absent'
    return value === 'cross-site' || value === 'same-origin' || value === 'same-site' || value === 'none' ? value : 'other'
  }

  return async function handler(req, res) {
    const startedAt = Date.now()
    try {
      /* ---- 安全：回环 + Host/端口(防 DNS rebinding) + Origin/页面 token + 跨站 + 仅 JSON + 限流 ---- */
      const trust = evaluateRequestTrust(req, { expectedPort })
      res.pbOrigin = trust.ok ? trust.origin : ''
      if (!trust.ok) {
        diag(cfg.diag, {
          kind: 'request-blocked',
          reason: trust.reason,
          method: String(req.method || '').toUpperCase().slice(0, 10),
        })
        return send(res, trust.status, { ok: false, error: '请求来源不被信任', reason: trust.reason })
      }

      if (req.method === 'OPTIONS') {
        res.statusCode = 204
        for (const [key, value] of Object.entries(corsHeadersFor(trust.origin))) res.setHeader(key, value)
        res.setHeader('x-content-type-options', 'nosniff')
        res.end()
        return
      }

      if (req.method === 'POST' && !hasJsonContentType(req)) {
        return send(res, 415, { ok: false, error: '只接受 application/json 请求体' })
      }

      const url = new URL(req.url || '/', 'http://localhost')
      const pathname = url.pathname
      const rel = pathname.slice(ROUTE_PREFIX.length) || '/'
      const remoteAddress = (req.socket && req.socket.remoteAddress) || ''
      const enhanceRoute = rel === '/enhance'
      if (!rateLimitOk(enhanceRoute ? 'enhance' : 'misc', remoteAddress, enhanceRoute ? cfg.rateLimitPerMinute : RATE_MAX_OTHER)) {
        return send(res, 429, { ok: false, error: '请求过于频繁，请稍后重试', retryAfterMs: RATE_WINDOW_MS })
      }

      /* ---- 健康检查 ---- */
      if (rel === '/health' || rel === '/') {
        const llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
        const route = resolveRoute(ctx, cfg)
        let efforts = []
        try {
          if (route) efforts = (await resolveEfforts(llm, route)).map((item) => String(item.id))
        } catch {
          /* 模型信息不可用：返回空数组 */
        }
        diag(cfg.diag, { kind: 'health', hasLlm: !!llm, route: route ? route.provider + '/' + route.model : null, efforts })
        return send(res, 200, {
          ok: true,
          plugin: '@local/prompt-booster',
          hasLlm: !!llm,
          route: route ? { provider: route.provider, model: route.model, source: route.source } : null,
          efforts,
          config: {
            maxInputChars: cfg.maxInputChars,
            maxOutputTokens: cfg.maxOutputTokens,
            timeoutMs: cfg.timeoutMs,
            temperature: cfg.temperature,
            projectContext: cfg.projectContext,
            contextMaxChars: cfg.contextMaxChars,
            conversationContext: cfg.conversationContext,
            rateLimitPerMinute: cfg.rateLimitPerMinute,
            maxConcurrentEnhance: cfg.maxConcurrentEnhance,
            allowClientProject: cfg.allowClientProject,
          },
          security: {
            loopbackOnly: true,
            hostPortChecked: true,
            crossSiteBlocked: true,
            jsonContentTypeRequired: true,
            pageTokenRequiredForHttpOrigin: true,
          },
        })
      }

      /* ---- 客户端诊断：事件白名单 + 结构化字段，不落盘自由文本 ---- */
      if (rel === '/diag') {
        if (req.method !== 'POST') return send(res, 405, { ok: false, error: '只支持 POST' })
        const body = await readJson(req, 64 * 1024)
        const event = typeof body.event === 'string' && DIAG_EVENT_RE.test(body.event) ? body.event : 'unknown'
        diag(cfg.diag, {
          kind: 'client-diag',
          event,
          detail: sanitizeDiagDetail(body.detail),
          pageOrigin: describeOrigin(String(req.headers.origin || '')),
          fetchSite: describeSite(String(req.headers['sec-fetch-site'] || '')),
        })
        return send(res, 200, { ok: true })
      }

      /* ---- 增强 ---- */
      if (rel === '/enhance') {
        if (req.method !== 'POST') return send(res, 405, { ok: false, error: '只支持 POST' })
        if (inflightEnhance >= cfg.maxConcurrentEnhance) {
          return send(res, 429, { ok: false, error: '正在处理其他增强请求，请稍后再试' })
        }
        // 先占用并发名额，再读取请求体，避免慢速连接绕过并发限制
        inflightEnhance += 1
        const abort = new AbortController()
        const onClose = () => {
          if (!res.writableEnded) abort.abort(new Error('client-abort'))
        }
        res.on('close', onClose)
        try {
          const body = await readJson(req, MAX_BODY_BYTES)
          const rawText = typeof body.text === 'string' ? body.text : ''
          const text = rawText.trim()
          if (!text) return send(res, 400, { ok: false, error: '草稿为空，先写点内容再增强' })
          if ([...text].length > cfg.maxInputChars) {
            return send(res, 413, {
              ok: false,
              error: '草稿太长（' + [...text].length + ' 字符，上限 ' + cfg.maxInputChars + '），请先精简',
            })
          }

          const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim().slice(0, 128) : ''
          // 多次增强：客户端带上"原句"（首次增强前的草稿），作为最高权重；Host 用它纠正上一版
          const baseText =
            typeof body.base === 'string' && body.base.trim() && body.base.trim() !== text
              ? body.base.trim().slice(0, cfg.maxInputChars)
              : ''
          const project = normalizeProject(body.project)
          // 项目路径只信 Host 会话元数据；客户端提供的 cwd 一律忽略
          const trustedCwd = sessionCwdOf(ctx, sessionId)
          const projectForContext = trustedCwd ? { cwd: trustedCwd, title: project ? project.title : '' } : null
          const cwdSource = trustedCwd ? 'session' : 'none'
          const contextNeeds = draftNeedsContext(text)
          const projectContext =
            contextNeeds.project && projectForContext
              ? await buildProjectContext(projectForContext, cfg)
              : emptyProjectContext()
          // 最近对话由客户端从当前页面 Chat 视图提取；Host 不再读取会话历史
          const recent =
            cfg.conversationContext && contextNeeds.recent ? recentFromBody(body) : { text: '', count: 0 }

          const contextParts = []
          if (recent.text) contextParts.push(recent.text)
          if (projectContext.text) {
            contextParts.push(
              '【项目上下文】（仅用于消解指代，最多引用 1 条相关事实，不要复述细节）\n' + projectContext.text,
            )
          }
          const contextText = contextParts.join('\n\n')

          diag(cfg.diag, {
            kind: 'enhance-request',
            chars: [...text].length,
            hasBase: !!baseText,
            baseChars: baseText.length,
            sessionId: sessionId ? 'present' : null,
            needsContext: contextNeeds,
            gated: !contextNeeds.recent && !contextNeeds.project,
            cwdSource,
            recentCount: recent.count,
            recentChars: recent.text.length,
            hasProject: !!projectContext.text,
            hasAgents: projectContext.info.hasAgents,
            hasManifest: projectContext.info.hasManifest,
            contextChars: projectContext.text.length,
          })

          try {
            const result = await runEnhance({ ctx, cfg, text, base: baseText, contextText, signal: abort.signal })
            diag(cfg.diag, {
              kind: 'enhance-ok',
              charsIn: [...text].length,
              charsOut: [...result.text].length,
              model: result.provider + '/' + result.model,
              routeSource: result.routeSource,
              ms: result.ms,
              finish: result.finish,
              recentCount: recent.count,
              contextChars: projectContext.text.length,
              lengthCap: result.lengthCap,
              lengthOver: result.lengthOver,
              mode: result.mode,
              answerGuard: result.answerGuard,
              variation: result.variation,
              attempts: result.attempts,
            })
            return send(res, 200, {
              ok: true,
              ...result,
              contextChars: projectContext.text.length,
              recentCount: recent.count,
            })
          } catch (err) {
            const status = err && err.status ? err.status : 500
            const message = (err && err.message) || String(err)
            const code = err && err.code ? String(err.code).slice(0, 64) : status >= 500 ? 'internal' : 'invalid'
            diag(cfg.diag, { kind: 'enhance-error', status, code })
            return send(res, status, { ok: false, error: message, code: err && err.code })
          }
        } finally {
          inflightEnhance -= 1
          res.removeListener('close', onClose)
        }
      }

      return send(res, 404, { ok: false, error: '未知路径' })
    } catch (err) {
      const status = err && err.status ? err.status : 500
      const code = err && err.code ? String(err.code).slice(0, 64) : err && err.name ? String(err.name).slice(0, 64) : 'internal'
      diag(cfg.diag, { kind: 'route-error', status, code })
      return send(res, status, { ok: false, error: (err && err.message) || '请求处理失败' })
    }
  }
}

/* ------------------------------------------------------------------ */
/* 插件入口                                                            */
/* ------------------------------------------------------------------ */

export function apply(ctx, rawConfig) {
  const cfg = normalizeConfig(rawConfig)

  const mount = (c) => {
    try {
      const handler = makeHandler(c, cfg)
      c.effect(() => c.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }))
      // 页面 token：通过 index 注入到浏览器全局；http 来源的请求必须回传，防 DNS rebinding/CSRF 纵深防御
      c.effect(() =>
        c.on('webserver/index-inject', (table) => {
          if (!Array.isArray(table)) return
          table.push({ kind: 'global', name: PAGE_TOKEN_GLOBAL, value: PAGE_TOKEN })
        }),
      )
      diag(cfg.diag, {
        kind: 'host-apply',
        route: ROUTE_PREFIX,
        config: {
          provider: cfg.provider || null,
          model: cfg.model || null,
          maxInputChars: cfg.maxInputChars,
          maxOutputTokens: cfg.maxOutputTokens,
          timeoutMs: cfg.timeoutMs,
          temperature: cfg.temperature,
          projectContext: cfg.projectContext,
          contextMaxChars: cfg.contextMaxChars,
          conversationContext: cfg.conversationContext,
          rateLimitPerMinute: cfg.rateLimitPerMinute,
          maxConcurrentEnhance: cfg.maxConcurrentEnhance,
          allowClientProject: cfg.allowClientProject,
          diag: cfg.diag,
          customPrompt: cfg.systemPrompt !== SYSTEM_PROMPT,
          pageToken: 'generated',
        },
      })
    } catch (err) {
      diag(cfg.diag, { kind: 'host-apply-error', code: err && err.name ? String(err.name).slice(0, 64) : 'internal' })
    }
  }

  try {
    ctx.inject(['webServer'], mount)
  } catch (err) {
    diag(cfg.diag, { kind: 'host-inject-error', code: err && err.name ? String(err.name).slice(0, 64) : 'internal' })
  }
}

// 供回归测试直接导入（插件加载器忽略额外导出）。
export {
  isLoopbackAddress,
  hostHeaderMatches,
  evaluateRequestTrust,
  sanitizeDiagDetail,
  safeProjectFile,
  outputLengthCap,
  looksLikeAnswer,
  draftIsAnswer,
  buildEnhanceUserText,
  buildTaskHint,
  isSameText,
  isShallowVariant,
  bigramSimilarity,
  recentFromBody,
  PAGE_TOKEN,
  PAGE_TOKEN_HEADER,
}
