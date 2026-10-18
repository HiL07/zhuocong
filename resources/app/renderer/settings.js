/*
 * 设置窗逻辑。
 *
 * 无打包器约定（与 chat.js 一致）：普通 <script>、全局作用域，不用 type="module"
 * —— file:// 下 Chromium 会用 CORS 拦掉 ES module。
 *
 * 原则（见 docs/settings-contract.md）：
 *   后端出「表单描述」，这里只按 field.type 渲染 + 自动保存，不硬编码字段；
 *   没有 window.pet.getSettings 时退回内置 MOCK_MODEL，直接用浏览器打开也能看完整界面。
 *
 * 安全：用户会往性格框里粘长文本，所以全程 textContent / value，不用 innerHTML。
 */
'use strict'

;(function () {
  // ---------- 可调参数 ----------

  const SAVE_DEBOUNCE_MS = 500
  const CONTEXT_TOKENS = 100000 // 只用来算「占上下文 x%」，不追真实模型的窗口大小
  const TOKEN_WARN = 4000
  const TOKEN_BAD = 8000
  const FIELD_TYPES = ['textarea', 'text', 'number', 'switch', 'select', 'readonly']

  // 状态注入用的 8 个短语。只有演示模式（没有后端）自己拼 prompt 时才用到。
  const STATE_PHRASES = {
    idle: '一个人待着，没人理',
    click: '刚被点了一下',
    held: '被拎起来了',
    running: '正被你拖着跑',
    talking: '正在说话',
    thinking: '在想事情',
    error: '出了点错',
    rolling: '被甩得打滚'
  }

  const DEFAULT_PERSONALITY =
    '你是「[桌宠名字]」，一只住在[你的称呼]桌面上的 Q 版女仆桌宠。' +
    '说话口语化、简短、有一点可爱但不浮夸，不用列表和 Markdown 标记，一般一两句话就够。用中文回答。'

  // ---------- 内置假数据（没有 preload 时用；结构严格照契约 §2.1） ----------

  const MOCK_MODEL = {
    version: '0.0.1',
    info: {
      userConfigPath: 'C:\\Users\\你\\AppData\\Roaming\\pet-host\\user-config.json',
      apiKeyPresent: false,
      logPath: 'C:\\Users\\你\\AppData\\Roaming\\pet-host\\logs\\pet-host.log',
      cacheBytes: 48 * 1024 * 1024,
      gptSovits: { url: '127.0.0.1:9880', reachable: false }
    },
    sections: [
      {
        id: 'personality',
        title: '性格',
        hint: '她是谁、怎么说话。可以直接粘几百字的角色卡。',
        fields: [
          {
            key: 'chat.personality',
            type: 'textarea',
            label: '性格提示词（system prompt）',
            help: '这段会作为系统提示词发给她。支持 [桌宠名字] 和 [你的称呼] 两个占位符，发送前才替换。',
            value: DEFAULT_PERSONALITY,
            default: DEFAULT_PERSONALITY,
            rows: 16,
            monospace: true,
            maxLength: 20000,
            effect: 'now',
            placeholders: ['[桌宠名字]', '[你的称呼]']
          },
          {
            key: 'personality.stateInjection',
            type: 'switch',
            label: '末尾追加当前状态',
            help: '开启时在她的系统提示词末尾另起一段（如 【当前状态：被拎起来了】），不会插进你写的正文里。',
            value: true,
            default: true,
            effect: 'now'
          },
          {
            key: 'chat.typewriterCps',
            type: 'number',
            label: '气泡逐字速度',
            help: '每秒吐几个字。10~30 比较自然。',
            value: 18,
            default: 18,
            min: 8,
            max: 60,
            step: 1,
            effect: 'now'
          },
          {
            key: 'chat.minThinkingMs',
            type: 'number',
            label: '至少思考多久（毫秒）',
            help: '首字来得太快时让她多想一会儿，不然「思考」的神态一闪而过。',
            value: 900,
            default: 900,
            min: 0,
            max: 3000,
            step: 100,
            effect: 'now',
            advanced: true
          }
        ]
      },
      {
        id: 'identity',
        title: '身份',
        hint: '名字只影响对话里的称呼，不用改提示词。',
        fields: [
          {
            key: 'identity.name',
            type: 'text',
            label: '她的名字',
            help: '出现在 [桌宠名字] 的位置。',
            value: '鲸鱼娘',
            default: '鲸鱼娘',
            maxLength: 24,
            effect: 'now'
          },
          {
            key: 'identity.userName',
            type: 'text',
            label: '她怎么称呼你',
            help: '出现在 [你的称呼] 的位置。',
            value: '你',
            default: '你',
            maxLength: 24,
            effect: 'now'
          },
          {
            key: 'pet.id',
            type: 'readonly',
            label: '角色素材 id',
            help: '素材随安装包提供。',
            readonlyReason: '换素材要重新打包，设置页只能看。',
            value: 'whale-girl',
            default: 'whale-girl',
            effect: 'now'
          }
        ]
      },
      {
        id: 'voice',
        title: '语音',
        hint: '让她出声。edge 走网络、首音快；本地克隆像她自己的声音，但慢一点。',
        fields: [
          {
            key: 'tts.enabled',
            type: 'switch',
            label: '语音总开关',
            help: '关掉之后只显示气泡，不说话。',
            value: true,
            default: true,
            effect: 'now'
          },
          {
            key: 'tts.engine',
            type: 'select',
            label: '引擎',
            value: 'gpt-sovits',
            default: 'gpt-sovits',
            effect: 'now',
            options: [
              { value: 'edge', label: '微软 edge（免费、联网、首音约 1 秒）' },
              { value: 'gpt-sovits', label: '本地 GPT-SoVITS（克隆音色，约 5 秒一句）' }
            ]
          },
          {
            key: 'tts.voice',
            type: 'select',
            label: '音色',
            help: '免费通道的中文音色就这 8 个，没有成熟女声这一档。',
            value: 'zh-CN-XiaoyiNeural',
            default: 'zh-CN-XiaoyiNeural',
            effect: 'now',
            options: [
              { value: 'zh-CN-XiaoxiaoNeural', label: '晓晓（女，温柔）' },
              { value: 'zh-CN-XiaoyiNeural', label: '晓伊（女，偏活泼）' },
              { value: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北（女，东北）' },
              { value: 'zh-CN-shaanxi-XiaoniNeural', label: '晓妮（女，陕西）' },
              { value: 'zh-CN-YunxiNeural', label: '云希（男，年轻）' },
              { value: 'zh-CN-YunjianNeural', label: '云健（男，沉稳）' },
              { value: 'zh-CN-YunyangNeural', label: '云扬（男，播报）' },
              { value: 'zh-CN-YunxiaNeural', label: '云夏（男，少年）' }
            ]
          },
          {
            key: 'tts.rate',
            type: 'select',
            label: '语速',
            value: '-15%',
            default: '-15%',
            effect: 'now',
            options: [
              { value: '-50%', label: '慢很多（-50%）' },
              { value: '-30%', label: '慢（-30%）' },
              { value: '-15%', label: '稍慢（-15%，默认）' },
              { value: '+0%', label: '原速（+0%）' },
              { value: '+15%', label: '稍快（+15%）' },
              { value: '+30%', label: '快（+30%）' }
            ]
          },
          {
            key: 'tts.pitch',
            type: 'select',
            label: '音调',
            value: '-10Hz',
            default: '-10Hz',
            effect: 'now',
            options: [
              { value: '-20Hz', label: '更低（-20Hz）' },
              { value: '-10Hz', label: '稍低（-10Hz，默认）' },
              { value: '+0Hz', label: '原调（+0Hz）' },
              { value: '+10Hz', label: '稍高（+10Hz）' }
            ]
          },
          {
            key: 'tts.polish',
            type: 'switch',
            label: '文本演戏',
            help: '短句句尾变省略号、感叹号降级，听起来更软。本地克隆路径不润色。',
            value: true,
            default: true,
            effect: 'now',
            advanced: true
          }
        ]
      },
      {
        id: 'look',
        title: '形象',
        hint: '渲染路线与配色。改完立刻重建渲染层。',
        fields: [
          {
            key: 'pet.renderer',
            type: 'select',
            label: '渲染路线',
            help: '出问题就切到「帧兼容」回退。',
            value: 'rig',
            default: 'rig',
            effect: 'reload',
            options: [
              { value: 'rig', label: '实时 rig（弹簧物理 / 表情 / 口型）' },
              { value: 'frames', label: '帧兼容（预烘焙 PNG 帧）' }
            ]
          },
          {
            key: 'pet.scheme',
            type: 'select',
            label: '配色方案',
            value: 'deepseek',
            default: 'deepseek',
            effect: 'now',
            options: [
              { value: 'deepseek', label: 'DeepSeek' },
              { value: 'harness', label: 'Harness' },
              { value: 'chatgpt', label: 'ChatGPT' },
              { value: 'claude', label: 'Claude' },
              { value: 'gemini', label: 'Gemini' },
              { value: 'qwen', label: 'Qwen' },
              { value: 'kimi', label: 'Kimi' },
              { value: 'minimax', label: 'MiniMax' }
            ]
          },
          {
            key: 'pet.rigScale',
            type: 'number',
            label: '缩放',
            help: '1 = 角色约占桌宠窗高度的 80%。',
            value: 1,
            default: 1,
            min: 0.7,
            max: 1.5,
            step: 0.05,
            effect: 'now'
          }
        ]
      },
      {
        id: 'window',
        title: '窗口',
        hint: '置顶、点击穿透与热键。热键要重启才生效。',
        fields: [
          {
            key: 'window.alwaysOnTop',
            type: 'switch',
            label: '窗口置顶',
            value: true,
            default: true,
            effect: 'now'
          },
          {
            key: 'window.ignoreMouseByDefault',
            type: 'switch',
            label: '点击穿透',
            help: '开启后鼠标穿过去，她像贴在墙上的贴纸 —— 拖不动也点不着。要关掉：托盘图标右键，或热键 Ctrl+Alt+O。',
            value: false,
            default: false,
            effect: 'now'
          },
          {
            key: 'hotkeys.chat',
            type: 'text',
            label: '打开聊天窗',
            help: 'Electron 写法，例如 CommandOrControl+Alt+C。格式不对后端会拒绝保存。',
            value: 'CommandOrControl+Alt+C',
            default: 'CommandOrControl+Alt+C',
            effect: 'restart',
            advanced: true
          },
          {
            key: 'hotkeys.voice',
            type: 'text',
            label: '按住说话',
            help: '默认是波浪键 —— 全局占用，任何程序里都打不出反引号了。',
            value: '`',
            default: '`',
            effect: 'restart',
            advanced: true
          },
          {
            key: 'hotkeys.toggleVisible',
            type: 'text',
            label: '显示 / 隐藏',
            value: 'CommandOrControl+Alt+O',
            default: 'CommandOrControl+Alt+O',
            effect: 'restart',
            advanced: true
          },
          {
            key: 'hotkeys.quit',
            type: 'text',
            label: '退出桌宠',
            value: 'CommandOrControl+Alt+Q',
            default: 'CommandOrControl+Alt+Q',
            effect: 'restart',
            advanced: true
          }
        ]
      },
      {
        id: 'model',
        title: '模型',
        hint: '下一句起生效。不填密钥也能玩，她会用现成台词应你。',
        fields: [
          {
            key: 'llm.model',
            type: 'text',
            label: '模型名',
            value: 'deepseek-flash',
            default: 'deepseek-flash',
            effect: 'now'
          },
          {
            key: 'llm.temperature',
            type: 'number',
            label: '温度',
            help: '越高越放得开。0.7~1.0 比较稳。',
            value: 1,
            default: 1,
            min: 0,
            max: 2,
            step: 0.1,
            effect: 'now'
          },
          {
            key: 'llm.thinking',
            type: 'switch',
            label: '让她先想一想',
            help: '开启会慢一些，但回答更周全。',
            value: false,
            default: false,
            effect: 'now'
          },
          {
            key: 'llm.maxTokens',
            type: 'number',
            label: '单条回复上限（token）',
            value: 512,
            default: 512,
            min: 64,
            max: 4096,
            step: 64,
            effect: 'now',
            advanced: true
          },
          {
            key: 'llm.stream',
            type: 'switch',
            label: '流式输出',
            value: true,
            default: true,
            effect: 'now',
            advanced: true
          },
          {
            key: 'budget.monthlyLimitCNY',
            type: 'readonly',
            label: '月度预算（元）',
            readonlyReason: '预算改错会让每条消息都被熔断，只能在 config/default.json 里改。',
            value: 30,
            default: 30,
            effect: 'now',
            advanced: true
          },
          {
            key: 'privacy.blocklist',
            type: 'readonly',
            label: '隐私黑名单',
            readonlyReason: '安全名单只能改默认配置，设置页不提供写入。',
            value: '1Password、KeePass、Bitwarden、支付宝、网上银行…（共 11 条）',
            default: '',
            effect: 'now',
            advanced: true
          }
        ]
      },
      {
        id: 'data',
        title: '数据',
        hint: '缓存、日志与配置文件都在你的用户目录里，不上传。',
        fields: [
          {
            key: 'chat.historyLimit',
            type: 'number',
            label: '带多少条历史给模型',
            help: '太大费 token，太小会忘事。',
            value: 12,
            default: 12,
            min: 4,
            max: 40,
            step: 1,
            effect: 'now',
            advanced: true
          },
          {
            key: 'diagnostics.dragCapture',
            type: 'switch',
            label: '拖动诊断',
            help: '把每一步拖动坐标写进日志并截图，平时关掉（有开销）。',
            value: false,
            default: false,
            effect: 'now',
            advanced: true
          }
        ]
      },
      {
        id: 'about',
        title: '关于',
        hint: '版本、许可与致谢。',
        fields: []
      }
    ]
  }

  // ---------- DOM 引用 ----------

  const navListEl = document.getElementById('navList')
  const navVersionEl = document.getElementById('navVersion')
  const noticesEl = document.getElementById('notices')
  const formEl = document.getElementById('form')
  const saveStateEl = document.getElementById('saveState')
  const demoTagEl = document.getElementById('demoTag')
  const statusHintEl = document.getElementById('statusHint')
  const modalEl = document.getElementById('modal')
  const modalTitleEl = document.getElementById('modalTitle')
  const modalTextEl = document.getElementById('modalText')
  const modalActionsEl = document.getElementById('modalActions')
  const fileInputEl = document.getElementById('fileInput')

  // ---------- 运行时状态 ----------

  let model = null
  let demoMode = false
  let activeId = ''
  const values = new Map()       // key → 当前值（界面的唯一真相）
  const fieldEls = new Map()     // key → 控件元素（换分区后会被重建）
  const panelCache = new Map()   // section.id → 已经渲染好的面板（切回来不丢输入现场）
  let navButtons = []

  let pendingPatch = {}          // 还没写进磁盘的改动
  let saveTimer = null
  let saving = false
  let saveFailed = false

  let promptUI = null            // 性格页的 meter / 占位符 / 预览引用
  let restartKeys = new Set()
  let restartUI = null
  let modalResolve = null
  let modalPreviousFocus = null

  // ---------- 小工具 ----------

  function byId(id) {
    return document.getElementById(id)
  }

  function h(tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined && text !== null) node.textContent = String(text)
    return node
  }

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms) })
  }

  function fmtNum(n) {
    return Number(n).toLocaleString('zh-CN')
  }

  function fmtTime() {
    return new Date().toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })
  }

  function fmtStamp(d) {
    const p = function (n) { return String(n).padStart(2, '0') }
    return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
      '-' + p(d.getHours()) + p(d.getMinutes())
  }

  function fmtMs(ms) {
    const v = Number(ms)
    if (!Number.isFinite(v)) return '—'
    return v >= 1000 ? (v / 1000).toFixed(1) + ' s' : Math.round(v) + ' ms'
  }

  function fmtBytes(n) {
    const v = Number(n)
    if (!Number.isFinite(v) || v <= 0) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB']
    let x = v
    let i = 0
    while (x >= 1024 && i < units.length - 1) { x /= 1024; i++ }
    return (i === 0 ? String(Math.round(x)) : x.toFixed(x >= 10 ? 0 : 1)) + ' ' + units[i]
  }

  function clip(text, max) {
    const s = String(text ?? '')
    const chars = Array.from(s)
    return chars.length > max ? chars.slice(0, max).join('') + '…' : s
  }

  const RE_CJK = /[\u3400-\u9fff\uf900-\ufaff]/

  /** 中文 1 字≈0.72 token，其它按 4 字符≈1 token（契约 §3.2 的估算口径） */
  function countStats(text) {
    const s = String(text ?? '')
    let chars = 0
    let cjk = 0
    let other = 0
    for (const ch of s) {
      chars++
      if (RE_CJK.test(ch)) cjk++
      else other++
    }
    return { chars: chars, tokens: Math.round(cjk * 0.72 + other / 4) }
  }

  function countOccurrences(hay, needle) {
    if (!needle) return 0
    let n = 0
    let i = 0
    for (;;) {
      const j = hay.indexOf(needle, i)
      if (j < 0) break
      n++
      i = j + needle.length
    }
    return n
  }

  function readValue(key) {
    return values.get(key)
  }

  function sectionById(id) {
    return model ? model.sections.find(function (s) { return s.id === id }) : null
  }

  function fieldByKey(key) {
    if (!model) return null
    for (const section of model.sections) {
      for (const field of section.fields) {
        if (field.key === key) return field
      }
    }
    return null
  }

  // ---------- 启动 ----------

  async function boot() {
    let raw = null
    demoMode = true

    if (window.pet && typeof window.pet.getSettings === 'function') {
      try {
        const got = await window.pet.getSettings()
        if (got && Array.isArray(got.sections) && got.sections.length) {
          raw = got
          demoMode = false
        } else {
          showNotice('warn', '后端返回的设置描述是空的，先用内置演示数据。')
        }
      } catch (err) {
        showNotice('error', '读取设置失败：' + ((err && err.message) || err) + '（先用演示数据）')
      }
    }

    if (!raw) raw = MOCK_MODEL
    model = normalizeModel(raw)
    if (!model.sections.length) {
      model = normalizeModel(MOCK_MODEL)
      demoMode = true
    }

    for (const section of model.sections) {
      for (const field of section.fields) {
        values.set(field.key, field.value)
      }
    }

    renderNav()
    bindGlobalEvents()
    showSection(initialSectionId())

    setSaveState('', demoMode ? '演示数据 · 改动不会落盘' : '自动保存已开启')
    demoTagEl.hidden = !demoMode
    if (demoMode) {
      showNotice('warn', '没接通 Electron 后端，正在用内置演示数据（改动只在当前页面里有效）。')
    }

    subscribeSettingsChanged()
  }

  /** 宽容一点：后端字段缺东西时补默认值，type 不认识就退回 text，别让整页渲染失败 */
  function normalizeModel(raw) {
    const out = {
      version: typeof raw.version === 'string' ? raw.version : '',
      info: raw.info && typeof raw.info === 'object' ? raw.info : {},
      sections: []
    }
    const sections = Array.isArray(raw.sections) ? raw.sections : []
    for (const section of sections) {
      if (!section || typeof section.id !== 'string') continue
      const fields = Array.isArray(section.fields) ? section.fields : []
      out.sections.push({
        id: section.id,
        title: typeof section.title === 'string' ? section.title : section.id,
        hint: typeof section.hint === 'string' ? section.hint : '',
        fields: fields.filter(function (f) { return f && typeof f.key === 'string' }).map(function (f) {
          const fallback = f.value === undefined ? f.default : f.value
          return Object.assign({}, f, {
            type: FIELD_TYPES.indexOf(f.type) >= 0 ? f.type : 'text',
            value: fallback === undefined ? '' : fallback,
            default: f.default === undefined ? fallback : f.default,
            effect: ['now', 'reload', 'restart'].indexOf(f.effect) >= 0 ? f.effect : 'now'
          })
        })
      })
    }
    return out
  }

  function initialSectionId() {
    if (model.sections.some(function (s) { return s.id === 'personality' })) return 'personality'
    return model.sections.length ? model.sections[0].id : ''
  }

  // ---------- 左侧导航 ----------

  function renderNav() {
    navListEl.replaceChildren()
    navButtons = []
    for (const section of model.sections) {
      const btn = h('button', 'nav-item', section.title)
      btn.type = 'button'
      btn.dataset.id = section.id
      btn.setAttribute('aria-label', '打开「' + section.title + '」设置')
      btn.addEventListener('click', function () { showSection(section.id) })
      navListEl.append(btn)
      navButtons.push(btn)
    }
    navVersionEl.textContent = 'v' + (model.version || '—')
  }

  function showSection(id) {
    const section = sectionById(id)
    if (!section) return
    let panel = panelCache.get(id)
    if (!panel) {
      panel = buildSection(section)
      panelCache.set(id, panel)
    }
    formEl.replaceChildren(panel)
    activeId = id
    for (const btn of navButtons) {
      if (btn.dataset.id === id) btn.setAttribute('aria-current', 'page')
      else btn.removeAttribute('aria-current')
    }
    formEl.scrollTop = 0
    fitPromptRows()
  }

  function markNavRestart(keySet) {
    for (const btn of navButtons) {
      const section = sectionById(btn.dataset.id)
      const hit = !!section && section.fields.some(function (f) { return keySet.has(f.key) })
      btn.classList.toggle('needs-restart', hit)
      if (hit) btn.title = '这个分区有改动需要重启才生效'
      else btn.removeAttribute('title')
    }
  }

  // ---------- 分区渲染 ----------

  function buildSection(section) {
    const panel = h('section', 'panel')
    panel.dataset.section = section.id

    const head = h('div', 'section-head')
    head.append(h('h2', 'section-title', section.title))
    if (section.hint) head.append(h('p', 'section-hint', section.hint))
    panel.append(head)

    const normal = h('div', 'fields')
    const advancedRows = []
    for (const field of section.fields) {
      const row = buildFieldRow(field)
      if (field.advanced) advancedRows.push(row)
      else normal.append(row)
    }
    if (section.fields.length) panel.append(normal)

    if (advancedRows.length) {
      const details = document.createElement('details')
      details.className = 'advanced'
      const summary = document.createElement('summary')
      summary.textContent = '高级'
      details.append(summary)
      const box = h('div', 'fields')
      for (const row of advancedRows) box.append(row)
      details.append(box)
      panel.append(details)
    }

    // 下面三块不是字段，是分区级的小工具（分区 id 是契约里固定的联合类型）
    if (section.id === 'voice') panel.append(buildVoiceCard())
    if (section.id === 'data') panel.append(buildDataCard())
    if (section.id === 'about') panel.append(buildAboutCards())

    return panel
  }

  function buildFieldRow(field) {
    const row = h('div', 'field')
    row.dataset.key = field.key

    const id = 'field-' + field.key.replace(/[^\w-]/g, '-')
    const head = h('div', 'field-head')
    const label = h('label', 'field-label', field.label)
    label.htmlFor = id
    head.append(label)
    if (field.effect === 'restart') head.append(h('span', 'tag restart', '需重启'))
    else if (field.effect === 'reload') head.append(h('span', 'tag reload', '需重开窗口'))
    if (field.type === 'readonly') head.append(h('span', 'tag ro', '只读'))

    const control = createControl(field, id)
    fieldEls.set(field.key, control)

    if (field.type === 'switch') {
      head.append(h('span', 'spacer'), control)
      row.append(head)
    } else {
      row.append(head, control)
    }

    const helpText = [field.help, field.type === 'readonly' ? field.readonlyReason : '']
      .filter(Boolean)
      .join(' ')
    if (helpText) row.append(h('p', 'field-help', helpText))

    if (isPromptField(field)) buildPromptExtras(row, field)

    return row
  }

  function createControl(field, id) {
    let el

    switch (field.type) {
      case 'switch': {
        el = document.createElement('input')
        el.type = 'checkbox'
        el.className = 'switch'
        el.checked = Boolean(field.value)
        el.addEventListener('change', function () { onFieldInput(field, el.checked) })
        break
      }
      case 'select': {
        el = document.createElement('select')
        const options = Array.isArray(field.options) ? field.options : []
        for (const option of options) {
          const opt = document.createElement('option')
          opt.value = String(option.value)
          opt.textContent = option.label === undefined ? String(option.value) : String(option.label)
          el.append(opt)
        }
        // 后端给的值不在选项里时，至少别把 select 弄成一个空框
        if (!options.some(function (o) { return String(o.value) === String(field.value) })) {
          const opt = document.createElement('option')
          opt.value = String(field.value)
          opt.textContent = String(field.value)
          el.append(opt)
        }
        el.value = String(field.value)
        el.addEventListener('change', function () { onFieldInput(field, el.value) })
        break
      }
      case 'number': {
        el = document.createElement('input')
        el.type = 'number'
        el.className = 'num'
        if (typeof field.min === 'number') el.min = String(field.min)
        if (typeof field.max === 'number') el.max = String(field.max)
        if (typeof field.step === 'number') el.step = String(field.step)
        el.value = String(field.value)
        el.addEventListener('input', function () { onFieldInput(field, el.value) })
        break
      }
      case 'textarea': {
        el = document.createElement('textarea')
        if (field.monospace) el.className = 'mono'
        el.rows = clampRows(field.rows)
        el.dataset.minRows = String(clampRows(field.rows))
        el.spellcheck = false
        if (typeof field.maxLength === 'number') el.maxLength = field.maxLength
        el.value = String(field.value ?? '')
        el.addEventListener('input', function () { onFieldInput(field, el.value) })
        break
      }
      case 'readonly': {
        el = document.createElement('input')
        el.type = 'text'
        el.className = 'ro'
        el.readOnly = true
        el.value = String(field.value ?? '')
        el.addEventListener('focus', function () { el.select() })
        break
      }
      case 'text':
      default: {
        el = document.createElement('input')
        el.type = 'text'
        if (typeof field.maxLength === 'number') el.maxLength = field.maxLength
        el.value = String(field.value ?? '')
        el.addEventListener('input', function () { onFieldInput(field, el.value) })
      }
    }

    el.id = id
    if (field.type === 'readonly' && field.readonlyReason) el.title = field.readonlyReason
    // 文本域失焦兜底保存一次（debounce 万一被切窗/关窗吞掉）
    el.addEventListener('blur', function () { void flushSave() })
    return el
  }

  function clampRows(rows) {
    const n = Math.round(Number(rows))
    if (!Number.isFinite(n)) return 14
    return Math.max(14, Math.min(30, n))
  }

  /** 窗口拉高时性格框自动涨行（14~30 行），矮了也不会挤掉别的东西 */
  function fitPromptRows() {
    const auto = Math.round((window.innerHeight - 300) / 22)
    for (const ta of formEl.querySelectorAll('textarea.mono')) {
      const base = Number(ta.dataset.minRows || 14)
      ta.rows = Math.max(14, Math.min(30, Math.max(base, auto)))
    }
  }

  function writeControl(el, field, value) {
    if (field.type === 'switch') {
      el.checked = Boolean(value)
      return
    }
    el.value = value === undefined || value === null ? '' : String(value)
  }

  // ---------- 改动的收集与自动保存 ----------

  function coerce(field, raw) {
    if (field.type === 'switch') return Boolean(raw)
    if (field.type === 'number') {
      if (String(raw).trim() === '') return undefined
      let n = Number(raw)
      if (!Number.isFinite(n)) return undefined
      if (typeof field.min === 'number') n = Math.max(n, field.min)
      if (typeof field.max === 'number') n = Math.min(n, field.max)
      return n
    }
    return String(raw ?? '')
  }

  function onFieldInput(field, raw) {
    const value = coerce(field, raw)
    if (value === undefined) return
    values.set(field.key, value)
    pendingPatch[field.key] = value
    if (promptUI) updatePromptMeter()
    scheduleSave()
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer)
    setSaveState('saving', '保存中…')
    saveTimer = setTimeout(function () {
      saveTimer = null
      void flushSave()
    }, SAVE_DEBOUNCE_MS)
  }

  async function flushSave() {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    if (saving) return
    if (!Object.keys(pendingPatch).length) return

    const patch = pendingPatch
    pendingPatch = {}
    saveFailed = false

    if (!window.pet || typeof window.pet.saveSettings !== 'function') {
      // 演示模式：不落盘，但保持「已保存」的观感
      setSaveState('saved', '已保存 ' + fmtTime() + ' · 演示（未落盘）')
      return
    }

    saving = true
    try {
      const res = await window.pet.saveSettings(patch)
      if (res && res.ok === false) throw new Error('后端拒绝了这次写入')
      setSaveState('saved', '已保存 ' + fmtTime())
      if (res && Array.isArray(res.rejected) && res.rejected.length) noteRejected(res.rejected)
      if (res && Array.isArray(res.needsRestart) && res.needsRestart.length) noteNeedsRestart(res.needsRestart)
    } catch (err) {
      saveFailed = true
      // 失败时把这次的值放回待写队列（新的改动覆盖旧的，别让旧值回滚界面）
      pendingPatch = Object.assign({}, patch, pendingPatch)
      setSaveState('error', '存不下来')
      showNotice('error', '保存失败：' + ((err && err.message) || err) + '（改完再看一眼，别让它悄悄丢了）')
    } finally {
      saving = false
      // 保存期间又有新改动 → 再来一轮；刚失败则不自动重试，等下一次编辑
      if (!saveFailed && Object.keys(pendingPatch).length) scheduleSave()
    }
  }

  function setSaveState(kind, text) {
    saveStateEl.className = kind || ''
    saveStateEl.textContent = text
  }

  function noteRejected(rejected) {
    const text = rejected.map(function (item) {
      const field = fieldByKey(item.key)
      return (field ? field.label : item.key) + '：' + (item.reason || '被后端拒绝')
    }).join('；')
    showNotice('error', '有设置没存上：' + text)
  }

  function noteNeedsRestart(keys) {
    for (const key of keys) restartKeys.add(key)

    if (!restartUI) {
      const el = h('div', 'notice warn')
      const textEl = h('span', 'grow')
      el.append(textEl)

      if (window.pet && typeof window.pet.restartApp === 'function') {
        const btn = h('button', 'btn small primary', '立即重启')
        btn.type = 'button'
        btn.addEventListener('click', function () {
          btn.disabled = true
          btn.textContent = '重启中…'
          try {
            window.pet.restartApp()
          } catch (err) {
            btn.disabled = false
            btn.textContent = '立即重启'
            showNotice('error', '重启失败：' + ((err && err.message) || err))
          }
        })
        el.append(btn)
      }

      const close = h('button', 'notice-x', '×')
      close.type = 'button'
      close.setAttribute('aria-label', '关闭重启提示')
      close.addEventListener('click', function () {
        el.remove()
        restartUI = null
        restartKeys = new Set()
        markNavRestart(restartKeys)
      })
      el.append(close)

      noticesEl.append(el)
      restartUI = { el: el, textEl: textEl }
    }

    const labels = Array.from(restartKeys).map(function (key) {
      const field = fieldByKey(key)
      return field ? field.label : key
    })
    restartUI.textEl.textContent = '这些改动要重启才生效：' + labels.join('、') + '。'
    markNavRestart(restartKeys)
    trimNotices()
  }

  // ---------- 提示条 ----------

  function showNotice(kind, text) {
    const el = h('div', 'notice ' + (kind || 'warn'))
    el.append(h('span', 'grow', text))

    const close = h('button', 'notice-x', '×')
    close.type = 'button'
    close.setAttribute('aria-label', '关闭提示')
    close.addEventListener('click', function () { el.remove() })
    el.append(close)

    noticesEl.append(el)
    trimNotices()

    if (kind === 'ok') {
      setTimeout(function () { el.remove() }, 5000)
    }
    return el
  }

  function trimNotices() {
    while (noticesEl.children.length > 4) {
      const first = noticesEl.firstElementChild
      if (restartUI && first === restartUI.el) {
        const next = noticesEl.children[1]
        if (!next) break
        next.remove()
        continue
      }
      first.remove()
    }
  }

  // ---------- 性格页：字数 / token / 占位符 / 试说一句 / 导入导出 ----------

  function isPromptField(field) {
    return field.type === 'textarea' && field.monospace === true
  }

  function buildPromptExtras(row, field) {
    const textarea = fieldEls.get(field.key)

    const meter = h('div', 'meter')
    const countEl = h('span', 'meter-item')
    const tokenEl = h('span', 'meter-item')
    const pctEl = h('span', 'meter-item')
    meter.append(countEl, tokenEl, pctEl)

    const warnEl = h('p', 'warn-line')
    warnEl.hidden = true

    const phRow = h('div', 'ph-row')
    const chips = new Map()
    const placeholders = Array.isArray(field.placeholders) ? field.placeholders : []
    if (placeholders.length) {
      phRow.append(h('span', 'ph-label', '占位符'))
      const chipBox = h('div', 'chips')
      for (const ph of placeholders) {
        const chip = h('button', 'chip', ph)
        chip.type = 'button'
        chip.addEventListener('click', function () { insertAtCursor(textarea, ph) })
        chipBox.append(chip)
        chips.set(ph, chip)
      }
      phRow.append(chipBox, h('span', 'ph-hint'))
    }

    const toolbar = h('div', 'toolbar')
    const importBtn = h('button', 'btn', '导入…')
    importBtn.type = 'button'
    importBtn.title = '支持 .txt 纯文本，或本页导出的 .json 整包'
    importBtn.addEventListener('click', importPersonality)

    const exportTxt = h('button', 'btn', '导出 .txt')
    exportTxt.type = 'button'
    exportTxt.addEventListener('click', function () { exportPersonality('txt') })

    const exportJson = h('button', 'btn', '导出 .json')
    exportJson.type = 'button'
    exportJson.title = '人格 + 名字 + 状态注入开关'
    exportJson.addEventListener('click', function () { exportPersonality('json') })

    const restore = h('button', 'btn danger', '恢复默认')
    restore.type = 'button'
    restore.addEventListener('click', restoreDefault)

    toolbar.append(importBtn, exportTxt, exportJson, h('span', 'spacer'), restore)

    const defaultText = typeof field.default === 'string' ? field.default : ''
    const defHint = h('p', 'default-hint', defaultText ? '默认人格开头：' + clip(defaultText, 34) : '')

    row.append(meter, warnEl, phRow, toolbar, defHint, buildPreviewCard(field))

    promptUI = {
      field: field,
      textarea: textarea,
      meter: meter,
      countEl: countEl,
      tokenEl: tokenEl,
      pctEl: pctEl,
      warnEl: warnEl,
      chips: chips,
      phHint: phRow.querySelector('.ph-hint')
    }
    updatePromptMeter()
  }

  function updatePromptMeter() {
    if (!promptUI) return
    const text = promptUI.textarea.value
    const stats = countStats(text)
    const pct = (stats.tokens / CONTEXT_TOKENS) * 100

    promptUI.countEl.textContent = fmtNum(stats.chars) + ' 字'
    promptUI.tokenEl.textContent = '约 ' + fmtNum(stats.tokens) + ' token（估算 ±20%）'
    promptUI.pctEl.textContent = '占上下文 ' + pct.toFixed(1) + '%'

    let level = ''
    if (stats.tokens > TOKEN_BAD) level = 'bad'
    else if (stats.tokens > TOKEN_WARN) level = 'warn'

    promptUI.meter.className = 'meter' + (level ? ' ' + level : '')
    if (level === 'bad') {
      promptUI.warnEl.hidden = false
      promptUI.warnEl.className = 'warn-line bad'
      promptUI.warnEl.textContent = '太长了，会把聊天记忆挤掉。建议压到 4,000 token 以内（只是提醒，仍会保存）。'
    } else if (level === 'warn') {
      promptUI.warnEl.hidden = false
      promptUI.warnEl.className = 'warn-line'
      promptUI.warnEl.textContent = '偏长了，提示词太长会挤掉聊天记忆（只是提醒，仍会保存）。'
    } else {
      promptUI.warnEl.hidden = true
    }

    for (const entry of promptUI.chips) {
      const ph = entry[0]
      const chip = entry[1]
      const n = countOccurrences(text, ph)
      chip.classList.toggle('on', n > 0)
      chip.textContent = n > 0 ? ph + ' ×' + n : ph
      chip.title = (n > 0 ? '已经用了 ' + n + ' 次' : '当前没用上') + '，点击插入到光标处'
    }

    if (promptUI.phHint) {
      const targets = Array.from(promptUI.chips.keys()).map(function (ph) {
        return ph + ' → ' + placeholderTarget(ph)
      })
      promptUI.phHint.textContent = targets.length ? '发送前换成：' + targets.join(' · ') : ''
    }
  }

  function placeholderTarget(ph) {
    if (ph === '[桌宠名字]') return String(readValue('identity.name') ?? '（还没填）')
    if (ph === '[你的称呼]') return String(readValue('identity.userName') ?? '（还没填）')
    return '（不认识的占位符，会原样发出去）'
  }

  function insertAtCursor(textarea, text) {
    const start = textarea.selectionStart ?? textarea.value.length
    const end = textarea.selectionEnd ?? start
    textarea.setRangeText(text, start, end, 'end')
    textarea.focus()
    // setRangeText 不触发 input 事件，手动发一次，让 meter 和自动保存跟上
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  }

  function buildPreviewCard(field) {
    const refs = {}

    const card = h('section', 'card try-card')
    card.append(h('h3', 'card-title', '试说一句'))
    card.append(h('p', 'card-note', '用上面这段人格当场合成一句回复；展开下面能看到实际发出去的 system prompt。'))

    const row = h('div', 'try-row')
    const label = h('label', 'try-label', '你说')
    const input = document.createElement('input')
    input.type = 'text'
    input.id = 'try-text-' + field.key.replace(/[^\w-]/g, '-')
    input.value = '你好呀'
    input.maxLength = 200
    input.placeholder = '比如：早上好'
    label.htmlFor = input.id

    const btn = h('button', 'btn primary', '试说一句')
    btn.type = 'button'
    row.append(label, input, btn)
    card.append(row)

    const quick = h('div', 'chips quick')
    quick.setAttribute('role', 'group')
    quick.setAttribute('aria-label', '快捷短语')
    for (const phrase of ['早上好', '我回来了', '你在干嘛']) {
      const chip = h('button', 'chip', phrase)
      chip.type = 'button'
      chip.addEventListener('click', function () {
        input.value = phrase
        void runPreview(field, refs)
      })
      quick.append(chip)
    }
    card.append(quick)

    const out = h('div', 'try-out')
    out.hidden = true

    const reply = h('p', 'reply')
    const meta = h('p', 'meta')

    const details = document.createElement('details')
    details.className = 'prompt-wrap'
    const summary = document.createElement('summary')
    summary.textContent = '实际发出的 system prompt'
    const pre = document.createElement('pre')
    pre.className = 'prompt'
    details.append(summary, pre)

    out.append(reply, meta, details)
    card.append(out)

    refs.input = input
    refs.btn = btn
    refs.out = out
    refs.reply = reply
    refs.meta = meta
    refs.pre = pre

    btn.addEventListener('click', function () { void runPreview(field, refs) })

    return card
  }

  async function runPreview(field, refs) {
    if (refs.btn.disabled) return
    const personality = promptUI ? promptUI.textarea.value : String(readValue(field.key) ?? '')
    const sample = (refs.input.value || '').trim() || '你好呀'

    refs.btn.disabled = true
    refs.btn.textContent = '正在想…'
    refs.out.hidden = false
    refs.reply.className = 'reply'
    refs.reply.textContent = '（等她想一下…）'
    refs.meta.className = 'meta'
    refs.meta.textContent = ''
    refs.pre.textContent = ''

    const started = performance.now()
    try {
      const result = window.pet && typeof window.pet.previewPersonality === 'function'
        ? await window.pet.previewPersonality(personality, sample)
        : await demoPreview(personality, sample)
      const elapsed = Math.round(performance.now() - started)

      if (!result || result.ok === false) {
        refs.reply.className = 'reply err'
        refs.reply.textContent = '没回话：' + ((result && result.error) || '后端没有返回内容')
        refs.meta.textContent = '耗时 ' + fmtMs(elapsed)
        return
      }

      refs.reply.textContent = result.reply ?? '（后端返回了 ok，但没有 reply）'
      const bits = ['用时 ' + fmtMs(result.ms === undefined ? elapsed : result.ms)]
      if (result.demo) bits.push('演示模式：不是真模型')
      refs.meta.textContent = bits.join(' · ')
      refs.pre.textContent = result.promptSent ?? '（后端没有返回 promptSent）'
    } catch (err) {
      refs.reply.className = 'reply err'
      refs.reply.textContent = '试说失败：' + ((err && err.message) || err)
    } finally {
      refs.btn.disabled = false
      refs.btn.textContent = '试说一句'
    }
  }

  /** 没有后端时的演示回复：让界面完整可看，但明确标出来不是真模型 */
  async function demoPreview(personality, sample) {
    await delay(450)
    const name = String(readValue('identity.name') ?? '鲸鱼娘')
    return {
      ok: true,
      demo: true,
      reply: '（演示）我是' + name + '。你说「' + sample + '」，我听见啦 —— 接上模型后，这里会是她真的回答。',
      promptSent: composeDemoPrompt(personality)
    }
  }

  /**
   * 演示模式下按契约 §3.3 自己拼一份 prompt：先换占位符，再在末尾另起一段追加状态。
   * 只在没有后端时用；真实链路里这一步在主进程完成。
   */
  function composeDemoPrompt(personalityText) {
    let out = String(personalityText ?? '')
    const name = String(readValue('identity.name') ?? '鲸鱼娘')
    const userName = String(readValue('identity.userName') ?? '你')
    out = out.split('[桌宠名字]').join(name)
    out = out.split('[你的称呼]').join(userName)
    if (readValue('personality.stateInjection') !== false) {
      out += '\n\n【当前状态：' + STATE_PHRASES.idle + '】'
    }
    return out
  }

  function exportPersonality(kind) {
    const text = promptUI ? promptUI.textarea.value : ''
    const stamp = new Date()
    const base = 'pet-personality-' + fmtStamp(stamp)

    if (kind === 'json') {
      // 整包快照（契约 §3.6）：人格 + 名字 + 状态注入开关
      const payload = {
        schema: 1,
        kind: 'pet-host/personality',
        exportedAt: stamp.toISOString(),
        version: model.version || '',
        personality: text,
        identity: {
          name: readValue('identity.name') ?? '',
          userName: readValue('identity.userName') ?? ''
        },
        stateInjection: readValue('personality.stateInjection') !== false
      }
      download(base + '.json', JSON.stringify(payload, null, 2), 'application/json')
      showNotice('ok', '已导出整包 .json（人格 + 名字 + 状态注入）')
    } else {
      download(base + '.txt', text, 'text/plain')
      showNotice('ok', '已导出纯文本 .txt')
    }
  }

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.append(a)
    a.click()
    a.remove()
    // 立刻 revoke 会让部分环境下载失败，留几秒
    setTimeout(function () { URL.revokeObjectURL(url) }, 5000)
  }

  function importPersonality() {
    // 先清空 value：连续选同一个文件也要能触发 change
    fileInputEl.value = ''
    fileInputEl.onchange = async function () {
      const file = fileInputEl.files && fileInputEl.files[0]
      if (!file) return

      let text = ''
      let bundle = null
      try {
        const raw = await file.text()
        if (!raw.trim()) throw new Error('empty')
        if (/\.json$/i.test(file.name)) {
          const data = JSON.parse(raw)
          const p = pickPersonality(data)
          if (typeof p !== 'string') throw new Error('no-personality')
          text = p
          bundle = data && typeof data === 'object' ? data : null
        } else {
          text = raw
        }
      } catch (err) {
        showNotice('error', '这个文件读不出来，要么不是导出的 .json，要么是空的。')
        return
      }

      const current = promptUI ? promptUI.textarea.value : ''
      const ok = await confirmDialog(
        '导入人格',
        '将用 ' + countStats(text).chars + ' 字覆盖当前的 ' + countStats(current).chars + ' 字。\n' +
        '不放心的话先点「导出 .json」备份一份。',
        '覆盖'
      )
      if (!ok) return

      applyPersonality(text, bundle)
    }
    fileInputEl.click()
  }

  function pickPersonality(data) {
    if (!data || typeof data !== 'object') return null
    if (typeof data.personality === 'string') return data.personality
    if (data.personality && typeof data.personality.text === 'string') return data.personality.text
    if (data.chat && typeof data.chat.personality === 'string') return data.chat.personality
    return null
  }

  function applyPersonality(text, bundle) {
    if (!promptUI) return
    promptUI.textarea.value = text
    values.set(promptUI.field.key, text)
    pendingPatch[promptUI.field.key] = text
    updatePromptMeter()

    if (bundle) {
      // 跟着整包一起进来的身份与开关（键名照契约 §3.6）
      const identity = bundle.identity
      if (identity && typeof identity === 'object') {
        applyImportedValue('identity.name', identity.name)
        applyImportedValue('identity.userName', identity.userName)
      }
      applyImportedValue('personality.stateInjection', bundle.stateInjection)
    }

    void flushSave()
    showNotice('ok', '人格已导入，正在保存。')
  }

  function applyImportedValue(key, value) {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return
    const field = fieldByKey(key)
    if (!field) return
    values.set(key, value)
    pendingPatch[key] = value
    const el = fieldEls.get(key)
    if (el) writeControl(el, field, value)
    if (promptUI) updatePromptMeter()
  }

  async function restoreDefault() {
    if (!promptUI) return
    const field = promptUI.field
    const def = typeof field.default === 'string' ? field.default : ''
    const current = promptUI.textarea.value

    if (current === def) {
      showNotice('ok', '当前已经是默认人格。')
      return
    }

    const ok = await confirmDialog(
      '恢复默认人格',
      '当前 ' + countStats(current).chars + ' 字，会换成默认的 ' + countStats(def).chars + ' 字：\n' +
      clip(def, 60),
      '恢复默认',
      { danger: true }
    )
    if (!ok) return

    promptUI.textarea.value = def
    values.set(field.key, def)
    pendingPatch[field.key] = def
    updatePromptMeter()
    void flushSave()
    showNotice('ok', '已恢复默认人格。')
  }

  // ---------- 语音页：试听 ----------

  function buildVoiceCard() {
    const card = h('section', 'card')
    card.append(h('h3', 'card-title', '试听'))

    const gpt = model.info && model.info.gptSovits
    if (gpt && typeof gpt === 'object') {
      const note = h('p', 'card-note',
        '本地克隆 ' + (gpt.url || '—') + ' · ' + (gpt.reachable ? '可连' : '连不上，试听会自动回退 edge'))
      note.classList.add(gpt.reachable ? 'ok-text' : 'warn-text')
      card.append(note)
    } else {
      card.append(h('p', 'card-note', '后端没有报告本地克隆的状态。'))
    }

    const refs = {}
    const row = h('div', 'try-row')
    const label = h('label', 'try-label', '试听文本')
    const input = document.createElement('input')
    input.type = 'text'
    input.id = 'voice-text'
    input.value = '你好呀，我是鲸鱼娘。'
    input.maxLength = 200
    label.htmlFor = input.id

    const btn = h('button', 'btn primary', '试听')
    btn.type = 'button'
    row.append(label, input, btn)

    const meta = h('p', 'meta')
    card.append(row, meta)

    refs.input = input
    refs.btn = btn
    refs.meta = meta
    btn.addEventListener('click', function () { void runVoicePreview(refs) })

    return card
  }

  async function runVoicePreview(refs) {
    if (refs.btn.disabled) return
    const text = (refs.input.value || '').trim() || '你好呀，我是鲸鱼娘。'

    refs.btn.disabled = true
    refs.btn.textContent = '正在叫醒语音…'
    refs.meta.className = 'meta'
    refs.meta.textContent = '首音可能要一两秒，本地克隆更慢。'

    const started = performance.now()
    try {
      const result = window.pet && typeof window.pet.previewVoice === 'function'
        ? await window.pet.previewVoice(text)
        : await demoVoice()
      const elapsed = Math.round(performance.now() - started)

      if (!result || result.ok === false) {
        refs.meta.className = 'meta err'
        refs.meta.textContent = '没能出声：' + ((result && result.error) || '后端没有返回结果')
        return
      }

      const bits = []
      if (result.engine) bits.push('引擎 ' + (result.engine === 'gpt-sovits' ? '本地 GPT-SoVITS' : 'edge'))
      else bits.push('引擎 未知')
      bits.push('耗时 ' + fmtMs(result.ms === undefined ? elapsed : result.ms))

      if (result.dataUrl) {
        const audio = new Audio(result.dataUrl)
        try {
          await audio.play()
        } catch (err) {
          bits.push('拿到了音频但播放被拦（点一下页面再试）')
        }
      } else if (result.demo) {
        bits.push('演示模式：没有真声音')
      } else {
        bits.push('后端没有返回音频')
      }

      refs.meta.textContent = bits.join(' · ')
    } catch (err) {
      refs.meta.className = 'meta err'
      refs.meta.textContent = '试听失败：' + ((err && err.message) || err)
    } finally {
      refs.btn.disabled = false
      refs.btn.textContent = '试听'
    }
  }

  async function demoVoice() {
    await delay(600)
    return { ok: true, demo: true, engine: 'edge', ms: 600 }
  }

  // ---------- 数据页：缓存 / 目录 ----------

  function buildDataCard() {
    const card = h('section', 'card')
    card.append(h('h3', 'card-title', '缓存与目录'))

    const cacheRow = h('div', 'info-row')
    cacheRow.append(h('span', 'k', '缓存占用'))
    const cacheValue = h('span', 'v', fmtBytes(model.info && model.info.cacheBytes))
    cacheRow.append(cacheValue)
    card.append(cacheRow)

    card.append(pathRow('日志文件', model.info && model.info.logPath))
    card.append(pathRow('配置文件', model.info && model.info.userConfigPath))

    const canClear = !!(window.pet && typeof window.pet.clearCache === 'function')
    const canOpen = !!(window.pet && typeof window.pet.openLogDir === 'function')

    const clear = h('button', 'btn', '清理缓存')
    clear.type = 'button'
    clear.disabled = !canClear
    if (!canClear) clear.title = '这个版本的 preload 还没接清理接口'

    const open = h('button', 'btn', '打开日志目录')
    open.type = 'button'
    open.disabled = !canOpen
    if (!canOpen) open.title = '这个版本的 preload 还没接打开目录接口'

    const toolbar = h('div', 'toolbar')
    toolbar.append(clear, open)
    card.append(toolbar)

    clear.addEventListener('click', async function () {
      clear.disabled = true
      clear.textContent = '清理中…'
      try {
        const res = await window.pet.clearCache()
        if (res && res.ok === false) {
          showNotice('error', '没清掉，看看日志里写了什么。')
        } else {
          cacheValue.textContent = fmtBytes(0)
          showNotice('ok', '缓存已清理。')
        }
      } catch (err) {
        showNotice('error', '清理失败：' + ((err && err.message) || err))
      } finally {
        clear.textContent = '清理缓存'
        clear.disabled = false
      }
    })

    open.addEventListener('click', function () {
      if (!window.pet || typeof window.pet.openLogDir !== 'function') return
      try {
        window.pet.openLogDir()
      } catch (err) {
        showNotice('error', '打不开目录：' + ((err && err.message) || err))
      }
    })

    return card
  }

  // ---------- 关于页 ----------

  function buildAboutCards() {
    const frag = document.createDocumentFragment()

    const versionCard = h('section', 'card')
    versionCard.append(h('h3', 'card-title', '版本'))
    versionCard.append(infoRow('应用', '蓝色鲸鱼娘 · pet-host'))
    versionCard.append(infoRow('版本', model.version || '未知'))
    frag.append(versionCard)

    const licenseCard = h('section', 'card')
    licenseCard.append(h('h3', 'card-title', '许可'))
    licenseCard.append(h('p', 'card-note',
      '本项目以 AGPL-3.0-or-later 分发。完整许可文本见 LICENSES/（打包后位于应用目录下的 LICENSES/ 里）。'))
    licenseCard.append(h('p', 'card-note',
      '角色素材来自 Coopanion（AGPL-3.0），第三方许可与声明见 THIRD-PARTY/Coopanion-LICENSE.txt。'))
    frag.append(licenseCard)

    const creditCard = h('section', 'card')
    creditCard.append(h('h3', 'card-title', '致谢'))
    const credits = h('div', 'credits')
    const list = [
      ['Coopanion', '角色素材与实时 rig'],
      ['edge-tts', '免费中文神经语音'],
      ['GPT-SoVITS', '本地克隆音色'],
      ['faster-whisper', '本地语音识别'],
      ['DeepSeek', '对话模型']
    ]
    for (const item of list) {
      const chip = h('span', 'credit')
      chip.append(h('b', null, item[0]), document.createTextNode(' · ' + item[1]))
      credits.append(chip)
    }
    creditCard.append(credits)
    frag.append(creditCard)

    const pathCard = h('section', 'card')
    pathCard.append(h('h3', 'card-title', '日志与配置'))
    pathCard.append(pathRow('配置路径', model.info && model.info.userConfigPath))
    pathCard.append(pathRow('日志路径', model.info && model.info.logPath))
    pathCard.append(infoRow(
      'API Key',
      model.info && model.info.apiKeyPresent ? '已填写（只存本地，不上传）' : '未填写（她仍会用现成台词应你）'
    ))
    frag.append(pathCard)

    return frag
  }

  function infoRow(label, value) {
    const row = h('div', 'info-row')
    row.append(h('span', 'k', label))
    row.append(h('span', 'v', value === undefined || value === null || value === '' ? '—' : String(value)))
    return row
  }

  function pathRow(label, value) {
    const row = h('div', 'info-row')
    row.append(h('span', 'k', label))
    const text = value === undefined || value === null ? '' : String(value)
    const val = h('span', 'v path', text || '（后端没提供）')
    row.append(val)

    if (text) {
      const btn = h('button', 'copy', '复制')
      btn.type = 'button'
      btn.setAttribute('aria-label', '复制' + label)
      btn.addEventListener('click', function () { void copyText(text, btn) })
      row.append(btn)
    }
    return row
  }

  // ---------- 复制 ----------

  async function copyText(text, btn) {
    let ok = false
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text)
        ok = true
      }
    } catch (err) {
      ok = false
    }
    if (!ok) ok = legacyCopy(text)

    const original = btn.textContent
    btn.textContent = ok ? '已复制' : '复制失败'
    btn.classList.toggle('ok', ok)
    setTimeout(function () {
      btn.textContent = original
      btn.classList.remove('ok')
    }, 1600)
  }

  /** 老环境（file:// 下剪贴板 API 不可用）的退路：临时 textarea + execCommand */
  function legacyCopy(text) {
    const ta = document.createElement('textarea')
    ta.className = 'sr-only'
    ta.value = text
    document.body.append(ta)
    ta.select()
    let ok = false
    try {
      ok = document.execCommand('copy')
    } catch (err) {
      ok = false
    }
    ta.remove()
    return ok
  }

  // ---------- 二次确认对话框 ----------

  function confirmDialog(title, text, okLabel, options) {
    const opts = options || {}
    return new Promise(function (resolve) {
      modalResolve = resolve
      modalPreviousFocus = document.activeElement
      modalTitleEl.textContent = title
      modalTextEl.textContent = text
      modalActionsEl.replaceChildren()

      const cancel = h('button', 'btn', '取消')
      cancel.type = 'button'
      cancel.addEventListener('click', function () { closeModal(false) })

      const ok = h('button', 'btn primary' + (opts.danger ? ' danger' : ''), okLabel || '确定')
      ok.type = 'button'
      ok.addEventListener('click', function () { closeModal(true) })

      modalActionsEl.append(cancel, ok)
      modalEl.hidden = false
      // 危险操作默认落在「取消」上，防止一个回车就把内容覆盖了
      ;(opts.danger ? cancel : ok).focus()
    })
  }

  function closeModal(result) {
    if (modalEl.hidden) return
    modalEl.hidden = true
    modalActionsEl.replaceChildren()
    if (modalPreviousFocus && typeof modalPreviousFocus.focus === 'function') {
      modalPreviousFocus.focus()
    }
    modalPreviousFocus = null
    const resolve = modalResolve
    modalResolve = null
    if (resolve) resolve(result)
  }

  // ---------- 全局事件 / 外部广播 ----------

  function bindGlobalEvents() {
    window.addEventListener('resize', fitPromptRows)

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return
      if (!modalEl.hidden) {
        e.preventDefault()
        closeModal(false)
        return
      }
      e.preventDefault()
      try {
        window.close()
      } catch (err) {
        // 浏览器里 window.close() 对非脚本打开的窗口无效，忽略即可
      }
    })

    modalEl.addEventListener('click', function (e) {
      if (e.target === modalEl) closeModal(false)
    })

    statusHintEl.textContent = '改动自动保存 · Esc 关闭窗口'
  }

  /** 主进程广播的 'settings:changed'（多窗口同步）。preload 没提供就跳过。 */
  function subscribeSettingsChanged() {
    const subscribe = window.pet && window.pet.onSettingsChanged
    if (typeof subscribe !== 'function') return
    subscribe(function (payload) {
      const patch = payload && payload.patch
      if (!patch || typeof patch !== 'object') return
      for (const key of Object.keys(patch)) {
        if (Object.prototype.hasOwnProperty.call(pendingPatch, key)) continue // 本地正在改，别被广播盖掉
        const field = fieldByKey(key)
        if (!field) continue
        values.set(key, patch[key])
        const el = fieldEls.get(key)
        if (el && document.activeElement !== el) writeControl(el, field, patch[key])
        if (promptUI && promptUI.field.key === key) updatePromptMeter()
      }
    })
  }

  // ---------- 起手 ----------

  void boot()
})()
