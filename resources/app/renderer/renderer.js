/**
 * 桌宠渲染层（P0）。
 *
 * 为什么用 canvas 而不是 <img> 轮换 src：
 *   直接改 img.src 会让浏览器每帧重新加载+解码文件，中间出现空帧 —— 表现为闪烁。
 *   canvas + 预解码好的 Image 对象则是一次内存拷贝，逐帧切换不会有空档。
 *
 * 为什么拖动走 IPC 手动实现，而不是 CSS 的 -webkit-app-region: drag：
 *   drag 区域会吞掉所有鼠标事件，于是「能拖」和「能点」二选一。
 *   手动实现可以用位移阈值把两者分开：位移<4px 算点击，否则算拖动。
 *
 * 帧源有两套，运行时二选一：
 *   A. 角色素材（assets/pets/<id>/...）—— 主进程扫描后经 IPC 下发
 *   B. 内置占位素材（assets/gif/...）—— A 不存在时的回落
 */
;(function () {
  'use strict'

  var ASSETS = '../assets'

  var BUILTIN_FRAMES = {
    idle: [ASSETS + '/gif/idle/idle-1.png', ASSETS + '/gif/idle/idle-2.png', ASSETS + '/gif/idle/idle-3.png', ASSETS + '/gif/idle/idle-4.png'],
    talking: [ASSETS + '/gif/talking/talk-1.png', ASSETS + '/gif/talking/talk-2.png', ASSETS + '/gif/talking/talk-3.png'],
    click: [ASSETS + '/gif/click/click-1.png', ASSETS + '/gif/click/click-2.png'],
    thinking: [ASSETS + '/gif/idle/idle-2.png', ASSETS + '/gif/idle/idle-3.png'],
    error: [ASSETS + '/gif/idle/idle-1.png']
  }
  var BUILTIN_FPS = { idle: 2, talking: 8, click: 6, thinking: 6, error: 2 }
  // petdex 的序列帧本来就是动画循环，帧率要高得多
  var PETDEX_FPS = { idle: 8, talking: 10, click: 12, thinking: 8, error: 6, held: 11 }

  var DRAG_THRESHOLD = 4 // px，小于它算点击

  // ------------------------------------------------------------ 渲染器

  function SpriteRenderer() {
    this.canvas = null
    this.ctx = null
    this.state = 'idle'
    this.frame = 0
    this.timer = null
    this.cache = {}
    this.frames = BUILTIN_FRAMES
    this.fpsMap = BUILTIN_FPS
    this.canvasW = 0
    this.canvasH = 0
  }

  SpriteRenderer.prototype.mount = function (el) {
    this.canvas = document.createElement('canvas')
    this.canvas.className = 'pet-sprite'
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })
    el.appendChild(this.canvas)
    return this.preload(this.frames)
  }

  /** 预解码一组帧。返回的 Promise 完成时，this.cache 里都是可直接 drawImage 的对象。 */
  SpriteRenderer.prototype.preload = function (frameMap) {
    var self = this
    var all = []
    var seen = {}
    Object.keys(frameMap).forEach(function (k) {
      ;(frameMap[k] || []).forEach(function (s) {
        if (!seen[s]) {
          seen[s] = 1
          all.push(s)
        }
      })
    })
    return Promise.all(
      all.map(function (src) {
        return new Promise(function (resolve) {
          var im = new Image()
          im.onload = function () {
            self.cache[src] = im
            resolve()
          }
          im.onerror = function () {
            resolve() // 缺帧不阻塞启动
          }
          im.src = src
        })
      })
    )
  }

  /** 把主进程下发 { state: {dir,count} } 展开成 { state: [url,...] }。不完整则返回 null。 */
  SpriteRenderer.prototype.buildPetFrames = function (spec) {
    var built = {}
    Object.keys(spec).forEach(function (k) {
      var f = spec[k]
      if (!f || !f.count) return
      var arr = []
      for (var i = 1; i <= f.count; i++) arr.push(f.dir + '/' + i + '.png')
      built[k] = arr
    })
    if (!built.idle) return null
    // 缺哪个逻辑状态就用 idle 顶替，避免切过去变空白
    Object.keys(BUILTIN_FRAMES).forEach(function (k) {
      if (!built[k]) built[k] = built.idle
    })
    return built
  }

  SpriteRenderer.prototype.stop = function () {
    if (this.timer !== null) {
      window.clearInterval(this.timer)
      this.timer = null
    }
  }

  SpriteRenderer.prototype.draw = function () {
    if (!this.ctx) return
    var frames = this.frames[this.state] || this.frames.idle
    if (!frames || !frames.length) return
    var src = frames[this.frame % frames.length]
    var im = this.cache[src]
    if (!im) return
    var w = im.naturalWidth || im.width
    var h = im.naturalHeight || im.height
    // 只在本帧尺寸与画布不一致时才改 canvas 尺寸（改尺寸会清空画布）
    if (this.canvasW !== w || this.canvasH !== h) {
      this.canvas.width = w
      this.canvas.height = h
      this.canvasW = w
      this.canvasH = h
    }
    this.ctx.clearRect(0, 0, w, h)
    this.ctx.drawImage(im, 0, 0)
  }

  SpriteRenderer.prototype.setState = function (s) {
    if (!this.ctx) return
    if (this.state === s && this.timer !== null) return
    this.state = s
    this.frame = 0
    this.stop()
    this.draw()
    var fps = this.fpsMap[s] || 2
    var self = this
    this.timer = window.setInterval(function () {
      self.frame++
      self.draw()
    }, Math.max(60, Math.round(1000 / fps)))
  }

  /** 先 bbox 粗筛，再读 canvas 该像素的 alpha 精判。P1 做点击穿透时直接复用。 */
  SpriteRenderer.prototype.onPointerHit = function (x, y) {
    var el = this.canvas
    if (!el) return false
    var r = el.getBoundingClientRect()
    if (x < r.left || y < r.top || x > r.right || y > r.bottom) return false
    try {
      var px = Math.floor(((x - r.left) / r.width) * el.width)
      var py = Math.floor(((y - r.top) / r.height) * el.height)
      var d = this.ctx.getImageData(px, py, 1, 1).data
      return d[3] > 12
    } catch (e) {
      return true
    }
  }

  // ------------------------------------------------------------ 装配

  var stageEl = document.getElementById('stage')
  var petEl = document.getElementById('pet')
  var toastEl = document.getElementById('toast')
  var hudEl = document.getElementById('hud')
  var renderer = new SpriteRenderer()
  var toastTimer = null
  var drag = null
  var dragCfg = { tilt: false, style: 'held', anchor: 'grab' }
  /** 抓取锚点（归一化，相对单帧）。手画在素材里，这个点就是「被捏住的位置」。 */
  var grabAnchor = { x: 0.5, y: 0.05 }

  function toast(text, ms) {
    toastEl.textContent = text
    toastEl.classList.add('show')
    if (toastTimer !== null) window.clearTimeout(toastTimer)
    toastTimer = window.setTimeout(function () {
      toastEl.classList.remove('show')
    }, ms || 2200)
  }

  // ---- 拖动：小白手 + 「被提着」状态 ----
  //
  // 坐标一律由主进程读真实光标算，这里只负责发信号和做视觉。
  // 早期版本用 e.screenX/screenY 算绝对坐标，因为窗口自己也在动，形成正反馈，
  // 桌宠会加速下落直到冲出屏幕（最后 setPosition 抛 conversion failure）。

  var grabbed = false

  /**
   * 抓取锚点在**窗口坐标系**里的位置（CSS px）。
   *
   * 由渲染层算而不是主进程算：只有这里知道精灵被 flex 布局摆到了哪里、
   * 又按 max-width/height 缩放了多大。canvas 的 getBoundingClientRect()
   * 就是它的实际显示区域，锚点 = 该矩形内按 grabAnchor 插值。
   */
  function anchorInWindow() {
    var cv = renderer.canvas
    if (!cv) return null
    var r = cv.getBoundingClientRect()
    if (!r.width || !r.height) return null
    return {
      x: r.left + r.width * grabAnchor.x,
      y: r.top + r.height * grabAnchor.y
    }
  }

  /**
   * 把视口信息报给主进程，用于拖动诊断。
   *
   * 记这几个量是因为「拖动时背景扩大、角色换位置」这类现象，
   * 只有把「精灵画在哪、多大」和「窗口在哪、多大」对齐看才判断得出来：
   *   canvasRect  精灵在窗口内的实际显示区域（CSS px）
   *   viewport    窗口的 CSS 视口尺寸
   *   dpr         devicePixelRatio，用来验证 CSS px 是否等于主进程的 DIP
   *   canvasAttr  canvas 的 width/height 属性值（后台缓冲尺寸）
   *   state       当前姿态名
   */
  function reportViewport(tag) {
    if (!window.pet || !window.pet.debug) return
    var cv = renderer.canvas
    var r = cv ? cv.getBoundingClientRect() : null
    window.pet.debug({
      tag: tag,
      state: renderer.state,
      canvasRect: r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null,
      canvasAttr: cv ? { width: cv.width, height: cv.height } : null,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      dpr: window.devicePixelRatio,
      stageRect: (function () {
        var s = stageEl.getBoundingClientRect()
        return { left: s.left, top: s.top, width: s.width, height: s.height }
      })(),
      petRect: (function () {
        var p = petEl.getBoundingClientRect()
        return { left: p.left, top: p.top, width: p.width, height: p.height }
      })()
    })
  }

  /** 被提起来：切到拖动姿态（held / running / rolling）。 */
  function grabVisual() {
    if (grabbed) return
    grabbed = true
    // 不叠加任何贴图 —— 手已经画在 held 素材里了。
    var style = dragCfg.style || 'held'
    if (renderer.frames && renderer.frames[style]) {
      renderer.setState(style)
    } else if (renderer.frames && renderer.frames.held) {
      renderer.setState('held')
    }
    // 切姿态后布局可能变（不同姿态帧尺寸理论上可以不同），记一笔
    reportViewport('grabbed')
  }

  /** 摆动：角度跟着鼠标水平速度走。tilt 默认关，因为姿态帧自带晃动。 */
  function swingVisual(dx) {
    if (!renderer.canvas || !dragCfg.tilt) return
    var angle = Math.max(-15, Math.min(15, dx * 0.06))
    renderer.canvas.style.transform =
      'rotate(' + angle.toFixed(2) + 'deg) translateY(-2px) scale(0.97,1.04)'
  }

  /** 松手：收手、回正、切回 idle。 */
  function releaseVisual() {
    if (!grabbed) return
    grabbed = false
    if (renderer.canvas) {
      renderer.canvas.style.transition = 'transform .34s cubic-bezier(.34,1.56,.64,1)'
      renderer.canvas.style.transform = ''
      window.setTimeout(function () {
        if (renderer.canvas) renderer.canvas.style.transition = 'none'
      }, 360)
    }
    renderer.setState('idle')
    reportViewport('released')
  }

  var drag = null

  function onPointerDown(e) {
    if (e.button !== 0) return
    drag = {
      id: e.pointerId,
      hitSprite: renderer.onPointerHit(e.clientX, e.clientY)
    }
    reportViewport('pointerdown')
    window.pet.dragStart({
      anchor: anchorInWindow(),
      pointer: { x: e.clientX, y: e.clientY }
    })
    try {
      stageEl.setPointerCapture(e.pointerId)
    } catch (err) {
      /* 忽略：个别情况下 capture 会失败，退化为只能在窗口内拖 */
    }
    e.preventDefault()
  }

  var lastScreenX = 0

  function onPointerMove(e) {
    if (!drag) return
    window.pet.dragMove()
    // 摆动用屏幕坐标的瞬时增量，只影响观感，不参与定位，不会形成反馈环
    var dx = e.screenX - lastScreenX
    lastScreenX = e.screenX
    if (grabbed && Math.abs(dx) < 200) swingVisual(dx * 12)
  }

  /** 上一次"点到了"的时间戳，用来识别双击（<400ms 算双击） */
  var lastClickAt = 0

  function onPointerUp(e) {
    if (!drag) return
    var hitSprite = drag.hitSprite
    try {
      stageEl.releasePointerCapture(drag.id)
    } catch (err) {
      /* 忽略 */
    }
    drag = null
    // 是否真的拖动过由主进程判定（它读的是真实光标），比渲染层判断可靠
    window.pet.dragEnd().then(function (r) {
      if (r && r.moved) {
        releaseVisual()
      } else if (hitSprite) {
        var now = Date.now()
        if (now - lastClickAt < 400) {
          // 双击 → 打开聊天窗。放在双击而不是单击，
          // 是因为单击已经有"惊讶表情"的反馈，不该再抢一个动作。
          lastClickAt = 0
          window.pet.openChat()
          toast('聊天窗口已打开', 900)
        } else {
          lastClickAt = now
          renderer.setState('click')
          window.setTimeout(function () {
            renderer.setState('idle')
          }, 420)
          toast('点到了！', 900)
        }
      }
    })
  }

  function finishBoot(cfg, petName) {
    // 桌宠窗口已经收紧到只装得下角色，HUD 文本没地方放 —— 这类状态信息改放托盘提示里。
    if (hudEl) {
      var keyMark = cfg.hasApiKey ? '已配置' : '未配置'
      hudEl.textContent =
        petName + ' · P0-' + cfg.profile + ' · ' + cfg.model + ' · key ' + keyMark + '\n' +
        '预算 ¥' + cfg.budget.spentCNY.toFixed(3) + ' / ¥' + cfg.limitCNY + ' (' + cfg.budget.verdict + ')'
    }
    window.pet.notifyReady()
    toast('桌宠已启动 · ' + petName, 1800)
  }

  function boot() {
    stageEl.addEventListener('pointerdown', onPointerDown)
    stageEl.addEventListener('pointermove', onPointerMove)
    stageEl.addEventListener('pointerup', onPointerUp)
    stageEl.addEventListener('pointercancel', onPointerUp)

    window.pet.onState(function (s) {
      toast(s.screenPaused ? '👁 截屏已暂停' : '👁 截屏已开启')
    })

    // 主进程判定真的拖起来了 —— 这时才抓手、才切 held 状态
    window.pet.onDragMoved(grabVisual)

    // 右键弹出菜单（含退出）——给一个不用翻任务管理器的退出入口
    stageEl.addEventListener('contextmenu', function (e) {
      e.preventDefault()
      window.pet.showMenu()
    })

    renderer
      .mount(petEl)
      .then(function () {
        // 刻意不再叠加「小手」贴图：手已经画在 held 素材里了，再叠一只就是两只手。
        renderer.setState('idle')
        return window.pet.getConfig()
      })
      .then(function (cfg) {
        if (cfg.drag) dragCfg = cfg.drag
        if (cfg.pet && cfg.pet.grab) grabAnchor = cfg.pet.grab
        if (!cfg.pet || !cfg.pet.frames) return finishBoot(cfg, '内置占位')
        var built = renderer.buildPetFrames(cfg.pet.frames)
        if (!built) return finishBoot(cfg, '内置占位')
        // 关键顺序：先停掉旧动画、预解码完新帧，再开新动画。
        // 否则计时器会在帧还没解码好时就开始轮播 —— 那正是闪烁的来源。
        renderer.stop()
        return renderer.preload(built).then(function () {
          renderer.frames = built
          renderer.fpsMap = PETDEX_FPS
          renderer.setState('idle')
          finishBoot(cfg, cfg.pet.id)
        })
      })
      .catch(function (e) {
        hudEl.textContent = '启动失败: ' + String(e)
      })
  }

  // ---------- 气泡 + 状态机（Day 1 步 5-6）----------
  //
  // 主进程把同一份流式文本广播给桌宠窗和聊天窗。
  // 这里只负责：把它逐字画进气泡，并按 mood 切角色神态。
  //
  // 气泡的**空间**由主进程负责 —— 显示时会调 setBubbleExtra() 把窗口向上撑高，
  // 渲染层不用关心（见 main/index.ts）。

  var bubbleEl = document.getElementById('bubble')
  var bubbleBuf = ''
  var bubbleHideTimer = null

  function bubbleOpen() {
    if (bubbleHideTimer) {
      window.clearTimeout(bubbleHideTimer)
      bubbleHideTimer = null
    }
    bubbleEl.hidden = false
    bubbleEl.classList.remove('err')
    bubbleEl.classList.add('typing')
    bubbleEl.textContent = ''
    bubbleBuf = ''
  }

  function bubbleDelta(d) {
    if (bubbleEl.hidden) bubbleOpen()
    bubbleBuf += d
    bubbleEl.textContent = bubbleBuf
  }

  function bubbleFinish(errText) {
    bubbleEl.classList.remove('typing')
    if (errText) {
      bubbleEl.classList.add('err')
      if (!bubbleBuf) bubbleEl.textContent = errText
    }
    // 留一会儿再收，别让用户还没看完就消失
    bubbleHideTimer = window.setTimeout(function () {
      bubbleEl.hidden = true
      bubbleBuf = ''
    }, 9000)
  }

  /** mood → 角色帧。名字必须和素材里的状态一致 */
  var MOOD_STATE = { thinking: 'thinking', talking: 'talking', idle: 'idle', error: 'error' }

  function applyMood(mood) {
    var s = MOOD_STATE[mood]
    if (!s) return
    // 正在被拖动时不抢神态 —— 那会让手突然消失
    if (grabbed) return
    renderer.setState(s)
    // thinking / error 是"停留态"，不自动回 idle；
    // 真正的回落在主进程 onState('idle') 时到来。
  }

  if (window.pet) {
    if (window.pet.onMood) window.pet.onMood(applyMood)
    // 互动叙事（game）每一拍要换一句：气泡是复用的，没有这个信号会越积越长。
    // rig 页已支持；这里补上，保证"帧兼容模式"下剧情也能正常显示。
    if (window.pet.onExtra) {
      window.pet.onExtra(function (p) {
        if (p && p.kind === 'bubble-reset') bubbleOpen()
      })
    }
    if (window.pet.onDelta) {
      window.pet.onDelta(function (p) {
        bubbleDelta(p.delta)
      })
    }
    if (window.pet.onDone) {
      window.pet.onDone(function (info) {
        bubbleFinish(info && info.blocked ? '（预算用尽）' : '')
      })
    }
    if (window.pet.onError) {
      window.pet.onError(function (p) {
        bubbleFinish('出错了：' + (p && p.message ? p.message : '未知'))
      })
    }
  }

  // ---------- 游戏状态 HUD（轨道 B · B-4，只读）----------
  //
  // 主进程起子进程跑 game/probe.js --json，把状态采样发过来。
  // 这里只**显示**，不做任何决策、不下发动作。
  //
  // 为什么不用气泡：气泡是给对话逐字用的，游戏状态是持续刷新的，
  // 塞进气泡会互相打架。所以用底部一行小字（#hud，P0 就写好了样式）。

  var hudEl = document.getElementById('hud')

  /** 把一次采样格式化成一行 */
  function fmtGame(s) {
    var pos = s.pos ? s.pos.x + ',' + s.pos.y + ',' + s.pos.z : '?'
    var near = s.near && s.near.length
      ? s.near.map(function (x) { return x.name + '×' + x.count }).join(' ')
      : '无'
    return '🐋 血 ' + (s.health == null ? '?' : s.health) + '/20' +
      ' · 食 ' + (s.food == null ? '?' : s.food) + '/20' +
      ' · ' + pos +
      ' · 附近 ' + near
  }

  function showGame(s) {
    if (!s || !hudEl) return
    hudEl.hidden = false
    hudEl.classList.remove('err')
    hudEl.classList.remove('warn')
    hudEl.textContent = fmtGame(s)
  }

  function gameErr(msg) {
    if (!hudEl) return
    hudEl.hidden = false
    hudEl.classList.remove('warn')
    hudEl.classList.add('err')
    hudEl.textContent = '游戏桥：' + msg
  }

  /**
   * 可恢复的状态（比如重连中）。
   * 用暖色而不是告警色 —— 之前把「退出码 0」这种干净退出也显示成红色错误，
   * 看着像坏了，实际只是没连上/断开了，而且桥会自动重连。
   */
  function gameWarn(msg) {
    if (!hudEl) return
    hudEl.hidden = false
    hudEl.classList.remove('err')
    hudEl.classList.add('warn')
    hudEl.textContent = '🐋 ' + msg
  }

  if (window.pet) {
    if (window.pet.onGameState) window.pet.onGameState(showGame)
    if (window.pet.gameState) {
      // 主动拉一次，省得等下一个采样周期（可能是 5 秒）
      window.pet.gameState()
        .then(function (s) { if (s) showGame(s) })
        .catch(function () { /* 没开游戏桥就算正常，不报错 */ })
    }
    if (window.pet.onGameEvent) {
      window.pet.onGameEvent(function (e) {
        if (!e) return
        if (e.kind === 'spawn') toast('游戏里进来了：' + (e.user || ''), 1600)
        else if (e.kind === 'kicked') gameWarn('被踢出：' + e.reason)
        else if (e.kind === 'bridge-retry') {
          // 断开/连不上会**自动重连**，所以说"重连中"而不是报错。
          var why = e.reason ? String(e.reason) : '连不上服务器'
          // ECONNREFUSED 是最常见的一种，翻成人话
          if (why.indexOf('ECONNREFUSED') >= 0) why = '服务器没开'
          gameWarn('重连中（' + why + '）第 ' + e.attempt + ' 次')
        } else if (e.kind === 'bridge-error') gameErr(String(e.message || '启动失败'))
        else if (e.kind === 'bridge-exit') gameErr('已停止')
      })
    }
  }

  boot()
})()
