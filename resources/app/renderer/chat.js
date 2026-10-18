/*
 * 聊天窗逻辑。
 *
 * 无打包器约定：普通 <script>、全局作用域、ES5 风格写法
 * （与 renderer.js 保持一致，避免 file:// 下的 module 限制）。
 *
 * 本文件的目标（Day 1 步 4）：
 *   能打字 → 能回车发送 → 能看到自己发的话
 * 流式回复（步 5）在 main 侧实现后接进来。
 */
(function () {
  'use strict'

  var logEl = document.getElementById('log')
  var inputEl = document.getElementById('input')
  var sendEl = document.getElementById('send')
  var lookEl = document.getElementById('look')
  var statusEl = document.getElementById('status')

  /** 是否正在等回复（等的时候禁用发送，避免连发） */
  var busy = false

  // ---------- 渲染 ----------

  /**
   * 加一条消息。
   *
   * @param {string} who  'pet' | 'user' | 'sys' | 'error'
   * @param {string} text
   * @param {boolean} echo 是否回报给主进程。
   *        重放历史时必须传 false —— 否则会把刚读回来的历史又写回去一遍，
   *        每开一次窗口记录就翻一倍。
   * @returns {HTMLElement} 消息元素（流式更新时要用）
   */
  function addMsg(who, text, echo) {
    var el = document.createElement('div')
    el.className = 'msg ' + who
    el.textContent = text
    logEl.appendChild(el)
    scrollToEnd()
    // 记录归主进程：窗口关掉销毁了，下次打开还能读回来
    if (echo !== false && window.pet && window.pet.chatAppend) {
      window.pet.chatAppend({ who: who, text: text })
    }
    return el
  }

  function scrollToEnd() {
    // 用 rAF 等布局完成，否则新元素高度还没算出来
    window.requestAnimationFrame(function () {
      logEl.scrollTop = logEl.scrollHeight
    })
  }

  function setStatus(kind, text) {
    statusEl.className = kind
    statusEl.textContent = text
  }

  function setBusy(v) {
    busy = v
    sendEl.disabled = v
    inputEl.disabled = v
    if (!v) inputEl.focus()
  }

  // ---------- 输入 ----------

  /** 输入框随内容长高，到上限为止（max-height 在 CSS 里） */
  function autoGrow() {
    inputEl.style.height = 'auto'
    inputEl.style.height = Math.min(inputEl.scrollHeight, 132) + 'px'
  }

  function send() {
    var text = inputEl.value.trim()
    if (!text || busy) return

    addMsg('user', text)
    inputEl.value = ''
    autoGrow()
    setBusy(true)
    setStatus('thinking', '思考中…')

    // 真正的请求交给主进程：它持有 ChatLog 和预算，
    // 并把同一份流式文本广播给桌宠窗和本窗口。
    if (window.pet && window.pet.chatSend) {
      window.pet.chatSend(text)
    } else {
      addMsg('error', '聊天后端未接通（preload 未加载？）')
      setBusy(false)
      setStatus('error', '出错')
    }
  }

  inputEl.addEventListener('input', autoGrow)

  inputEl.addEventListener('keydown', function (e) {
    // Enter 发送，Shift+Enter 换行
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  })

  sendEl.addEventListener('click', send)

  // ---------- 屏幕感知：「看一眼」按钮（按需单次，不是常驻截屏）----------
  //
  // 为什么放在聊天窗而不是桌宠窗：这是个**明确动作**，要让用户知道"我现在让她看屏幕了"。
  // 主进程那边还有三道闸门（配置开关 / 托盘暂停 / 前台窗口黑名单），命中就拒绝、不抓屏。
  if (lookEl) {
    lookEl.addEventListener('click', function () {
      if (busy) return
      // 老版 preload 没有这个接口时别炸（同步 TypeError 不会被下面的 catch 接住）
      if (!window.pet || typeof window.pet.screenLook !== 'function') {
        addMsg('error', '这个版本的 preload 还没接屏幕感知（需要重启桌宠）')
        return
      }
      var q = inputEl.value.trim() || '看看我的屏幕，用一两句话告诉我我现在在做什么。'
      setStatus('thinking', '看一眼…')
      window.pet
        .screenLook(q)
        .then(function (r) {
          if (r && r.ok) {
            // 主进程已经把这一轮发出去了：清空输入框，剩下的走正常的流式/气泡链路
            inputEl.value = ''
            autoGrow()
            setBusy(true)
            addMsg('user', q + '（👁 附一张屏幕截图）')
            return
          }
          var msg = (r && r.error) || '看不了屏幕'
          addMsg('error', msg)
          setStatus('idle', '就绪')
        })
        .catch(function (e) {
          addMsg('error', '看屏幕失败：' + (e && e.message ? e.message : String(e)))
          setStatus('idle', '就绪')
        })
    })
  }

  // ---------- 互动叙事面板（🎲 剧情）----------
  //
  // 这一块**只做展示与转发**：剧情怎么走全在 src/game/stories/*，
  // 宿主（src/game/host.ts）负责把每一"拍"（Beat）推过来。
  // 想换剧本 / 加节点：只改 game 那边，这个文件不用动。
  var storyEl = document.getElementById('story')
  var storyTitleEl = document.getElementById('storyTitle')
  var storyHintEl = document.getElementById('storyHint')
  var storyLogEl = document.getElementById('storyLog')
  var storyDiceEl = document.getElementById('storyDice')
  var storyChoicesEl = document.getElementById('storyChoices')
  var storyTextEl = document.getElementById('storyText')
  var storyStateEl = document.getElementById('storyState')
  var storyToggleEl = document.getElementById('storyToggle')
  var storyCloseEl = document.getElementById('storyClose')
  var storySayEl = document.getElementById('storySay')
  var storySeen = 0            // 已经画到第几条历史
  var storyActive = false

  function storyRender(v) {
    if (!v) return
    storyActive = !!v.active
    storyEl.hidden = false
    storyTitleEl.textContent = v.title || '剧情'
    // 历史增量渲染（只在有新条目时追加，避免每次重画滚动条乱跳）
    var hist = v.history || []
    if (hist.length < storySeen) { storyLogEl.textContent = ''; storySeen = 0 }
    for (var i = storySeen; i < hist.length; i++) {
      var row = document.createElement('div')
      if (hist[i].speaker) {
        var sp = document.createElement('span')
        sp.className = 'sp'
        sp.textContent = hist[i].speaker + '：'
        row.appendChild(sp)
      }
      row.appendChild(document.createTextNode(hist[i].text || ''))
      storyLogEl.appendChild(row)
    }
    storySeen = hist.length
    storyLogEl.scrollTop = storyLogEl.scrollHeight

    // 骰面
    var roll = v.beat && v.beat.roll
    if (roll) {
      storyDiceEl.hidden = false
      storyDiceEl.className = roll.success === false ? 'bad' : (roll.success ? 'ok' : '')
      var dc = roll.dc !== undefined ? ' vs 难度 ' + roll.dc + '：' + (roll.success ? '成功' : '失败') : ''
      storyDiceEl.textContent = '🎲 ' + (roll.expr || '') + ' → [' + (roll.rolls || []).join(', ') + ']' +
        (roll.modifier ? (roll.modifier > 0 ? ' + ' + roll.modifier : ' - ' + Math.abs(roll.modifier)) : '') +
        ' = ' + roll.total + dc
    } else {
      storyDiceEl.hidden = true
    }

    // 选项
    storyChoicesEl.textContent = ''
    var choices = (v.beat && v.beat.choices) || []
    choices.forEach(function (c) {
      var b = document.createElement('button')
      var label = document.createElement('span')
      label.textContent = c.label
      b.appendChild(label)
      if (c.hint) {
        var h = document.createElement('span')
        h.className = 'hint'
        h.textContent = c.hint
        b.appendChild(h)
      }
      b.disabled = !!c.disabledReason
      b.title = c.disabledReason || ''
      b.addEventListener('click', function () {
        window.pet.game.choose(c.id).then(storyRender).catch(storyFail)
      })
      storyChoicesEl.appendChild(b)
    })

    // 状态摘要：只显示与"看得懂"相关的（原石 / 道具 / 属性）
    var st = v.state || {}
    var bits = []
    if (st.bag && st.bag.yuanShi && st.bag.yuanShi.count) bits.push('原石 ' + st.bag.yuanShi.count + '/5')
    if (st.bag && Array.isArray(st.bag.items) && st.bag.items.length) bits.push('道具：' + st.bag.items.join('、'))
    if (st.player) {
      var p = []
      Object.keys(st.player).forEach(function (k) { p.push(k + ' ' + st.player[k]) })
      if (p.length) bits.push(p.join(' / '))
    }
    storyStateEl.textContent = bits.join('　|　')

    storyHintEl.textContent = v.beat && v.beat.end ? '本节点已结束' : (choices.length ? '请选择一个行动' : '可以输入你想说的话')
  }

  function storyFail(e) {
    addMsg('error', '剧情出错：' + ((e && e.message) || String(e)))
  }

  function storyStart() {
    if (!window.pet || !window.pet.game) {
      addMsg('error', '这个版本的 preload 还没接剧情接口（需要重启桌宠）')
      return
    }
    window.pet.game.start().then(storyRender).catch(storyFail)
  }

  function storySay() {
    var t = storyTextEl.value.trim()
    if (!t || !window.pet || !window.pet.game) return
    storyTextEl.value = ''
    window.pet.game.say(t).then(storyRender).catch(storyFail)
  }

  if (storyToggleEl) {
    storyToggleEl.addEventListener('click', function () {
      if (storyEl.hidden) {
        storyEl.hidden = false
        if (window.pet && window.pet.game) window.pet.game.view().then(storyRender).then(storyStart).catch(storyFail)
      } else {
        storyEl.hidden = true
      }
    })
  }
  if (storyCloseEl) storyCloseEl.addEventListener('click', function () { storyEl.hidden = true })
  if (storySayEl) storySayEl.addEventListener('click', storySay)
  if (storyTextEl) {
    storyTextEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); storySay() }
    })
  }
  if (window.pet && window.pet.game && window.pet.game.onView) {
    window.pet.game.onView(function (v) {
      // 剧情推进时自动展开面板（否则玩家不知道轮到他了）
      storyEl.hidden = false
      storyRender(v)
    })
  }

  // ---------- 供 main 侧调用的接口 ----------

  window.chatUI = {
    /** 流式增量：把 delta 追加到最后一条 pet 消息上 */
    onDelta: function (delta) {
      var last = logEl.lastElementChild
      if (!last || !last.classList.contains('pet') || !last.classList.contains('streaming')) {
        last = document.createElement('div')
        last.className = 'msg pet streaming'
        logEl.appendChild(last)
      }
      last.textContent += delta
      scrollToEnd()
    },
    /** 一次流式结束 */
    onDone: function (info) {
      var last = logEl.lastElementChild
      if (last && last.classList.contains('streaming')) {
        last.classList.remove('streaming')
        if (info && info.firstTokenMs != null) {
          var m = document.createElement('span')
          m.className = 'meta'
          m.textContent = '首字 ' + info.firstTokenMs + ' ms · 共 ' + info.totalMs + ' ms'
          last.appendChild(m)
        }
      }
      setBusy(false)
      setStatus('idle', '就绪')
      scrollToEnd()
    },
    /** 出错 */
    onError: function (msg) {
      var last = logEl.lastElementChild
      if (last) last.classList.remove('streaming')
      addMsg('error', msg)
      setBusy(false)
      setStatus('error', '出错')
    },
    /** 主进程告知桌宠状态（thinking/talking/idle） */
    onPetState: function (s) {
      var map = { thinking: '思考中…', talking: '说话中…', idle: '就绪', error: '出错' }
      setStatus(s, map[s] || s)
    }
  }

  // ---------- 语音输入（步 7）----------
  //
  // 识别结果直接填进输入框（**不自动发送**）——
  // 识别难免出错，让用户看一眼再决定发不发，比自动发出去强。

  function voiceStatus(s) {
    if (!s) return
    var k = s.kind
    if (k === 'loading') setStatus('thinking', '加载语音模型…')
    else if (k === 'ready') setStatus('idle', '语音就绪')
    else if (k === 'recording') setStatus('talking', '● 正在听…')
    else if (k === 'empty') setStatus('idle', '没听清')
    else if (k === 'error') {
      setStatus('error', '语音出错')
      addMsg('sys', '语音：' + (s.message || '未知错误'), false)
    }
  }

  if (window.pet) {
    if (window.pet.onVoiceStatus) window.pet.onVoiceStatus(voiceStatus)
    if (window.pet.onVoiceText) {
      window.pet.onVoiceText(function (p) {
        if (!p || !p.text) return
        // 追加而不是覆盖，方便连说几句
        inputEl.value = (inputEl.value ? inputEl.value + ' ' : '') + p.text
        autoGrow()
        inputEl.focus()
        setStatus('idle', '识别 ' + p.ms + 'ms')
      })
    }
    // ⚠️ 这里**刻意不注册** keydown/keyup。
    //
    // 原来写了「按下开始 / 松开停止」，但有自动停止之后它是**纯有害的**：
    // 你点一下波浪键，松开时会立刻发 STOP，录音只持续 100 毫秒，
    // 结果是"太短"什么也识别不到。
    //
    // 现在全局热键按一次就够，录音器自己在静音时收尾。
  }

  // ---------- 订阅主进程广播 ----------
  //
  // 桌宠窗和聊天窗收到的是**同一份**流式文本。
  // 重放历史时 addMsg 传 echo=false，但流式路径不走 addMsg（主进程已经记过账），
  // 所以不会重复写入。

  if (window.pet) {
    if (window.pet.onDelta) {
      window.pet.onDelta(function (p) {
        window.chatUI.onDelta(p.delta)
      })
    }
    if (window.pet.onMood) {
      window.pet.onMood(function (mood) {
        window.chatUI.onPetState(mood)
        // 首字到达时自动解除"思考中"的忙碌态提示（真正解禁在 onDone）
        if (mood === 'talking') setStatus('talking', '说话中…')
      })
    }
    if (window.pet.onDone) {
      window.pet.onDone(function (info) {
        window.chatUI.onDone(info)
        if (info && info.blocked) {
          setStatus('error', '预算已用尽')
        } else if (info && info.degraded) {
          setStatus('idle', '降级模式')
        }
      })
    }
    if (window.pet.onError) {
      window.pet.onError(function (p) {
        window.chatUI.onError(p && p.message ? p.message : '未知错误')
      })
    }
  }

  // ---------- 首屏：先把历史读回来 ----------
  //
  // 记录归主进程，所以这里要主动拉一次。
  // ⚠️ 重放时必须 echo=false —— 否则刚读回来的历史会被再写回去一遍，
  //    每开关一次窗口记录就翻一倍。

  function boot() {
    inputEl.focus()
    autoGrow()
  }

  if (window.pet && window.pet.chatHistory) {
    window.pet.chatHistory()
      .then(function (entries) {
        if (entries && entries.length) {
          entries.forEach(function (e) {
            addMsg(e.who, e.text, false)
            if (e.meta) {
              var last = logEl.lastElementChild
              if (last) {
                var m = document.createElement('span')
                m.className = 'meta'
                m.textContent = e.meta
                last.appendChild(m)
              }
            }
          })
        } else {
          addMsg('sys', '这是 Day 1 步 3/4 的聊天窗骨架。输入框可用，回复链路在步 5 接通。', false)
        }
        boot()
      })
      .catch(function (err) {
        addMsg('sys', '历史记录读取失败：' + err, false)
        boot()
      })
  } else {
    addMsg('sys', '未接通主进程（preload 未加载？）', false)
    boot()
  }
})()
